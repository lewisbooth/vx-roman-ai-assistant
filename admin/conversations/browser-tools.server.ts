import { parseCatalogResult, type CatalogResult } from "../../shared/catalog";
import { parseCatalogCall } from "../../shared/catalog-tools";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../shared/navigation-tool";
import type { ToolClaim, ToolClaimInput } from "../../shared/conversation";
import {
  isCartTool,
  parseCartCall,
  parseCartResult,
  requiresCartConfirmation,
  interruptedCartResult,
  type CartToolResult,
} from "../../shared/cart-tools";
import {
  parseMeasurementCall,
  parseApplyMeasurementsCommand,
  parseApplyMeasurementsResult,
  type ApplyMeasurementsResult,
} from "../../shared/measurements";
import { getMeasurementDraft } from "../measurements/service.server";
import {
  parseProductGuidesCall,
  parseProductGuidesResult,
  type ProductGuidesResult,
} from "../../shared/product-guides";
import { ConversationError } from "./errors.server";
import {
  completeToolInvocation,
  createToolInvocation,
  failToolInvocation,
  getBrowserToolContext,
  claimToolInvocation,
} from "./repository.server";

export type BrowserToolOutcome =
  | CatalogResult
  | NavigationResult
  | CartToolResult
  | ApplyMeasurementsResult
  | ProductGuidesResult
  | { error: string };
interface BrowserWaiter {
  invocationId?: string;
  resolve?: (result: BrowserToolOutcome) => void;
}
const waiting = new Map<string, BrowserWaiter>();

async function resolveMeasurements(conversationId: string, input: unknown) {
  const call = parseMeasurementCall("get_measurements", input);
  const draft = await getMeasurementDraft(
    conversationId,
    call.arguments.productPath,
  );
  if (!draft)
    throw new ConversationError(
      409,
      "Save explicit order dimensions before applying measurements.",
    );
  return {
    name: "apply_measurements" as const,
    arguments: {
      ...parseApplyMeasurementsCommand({
        productPath: call.arguments.productPath,
        draft,
      }),
    },
  };
}

export async function requestBrowserTool(
  conversationId: string,
  assistantId: string,
  providerCallId: string,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<BrowserToolOutcome> {
  const call =
    name === "get_product_guides"
      ? {
          name: "get_product_guides" as const,
          arguments: parseProductGuidesCall(input),
        }
      : name === "apply_measurements"
        ? await resolveMeasurements(conversationId, input)
        : name === "navigate"
          ? { name: "navigate" as const, arguments: parseNavigationCall(input) }
          : isCartTool(name)
            ? parseCartCall(name, input)
            : parseCatalogCall(name, input);
  signal.throwIfAborted();
  if (waiting.has(conversationId))
    throw new Error("A storefront action is already running.");
  // Reserve before the database await. A cancelled turn can still be settling
  // its invocation while the runner accepts a replacement turn.
  const waiter: BrowserWaiter = {};
  waiting.set(conversationId, waiter);
  let deadline: AbortSignal | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const invocation = await createToolInvocation(conversationId, assistantId, {
      providerCallId,
      ...call,
    });
    waiter.invocationId = invocation.id;
    const actionDeadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(45_000),
    ]);
    deadline = actionDeadline;
    return await new Promise<BrowserToolOutcome>((resolve, reject) => {
      onAbort = () =>
        reject(
          new Error(
            "The storefront action did not finish. A full page load may have interrupted confirmation; check the current page before retrying.",
          ),
        );
      waiter.resolve = resolve;
      actionDeadline.addEventListener("abort", onAbort, { once: true });
      if (actionDeadline.aborted) onAbort();
    });
  } catch (error) {
    if (waiter.invocationId) {
      const outcome = await failToolInvocation(
        conversationId,
        waiter.invocationId,
        "The storefront action was interrupted or timed out.",
      );
      if (outcome && !signal.aborted) return outcome;
    }
    throw error;
  } finally {
    if (deadline && onAbort) deadline.removeEventListener("abort", onAbort);
    if (waiting.get(conversationId) === waiter) waiting.delete(conversationId);
  }
}

/** Cart confirmation belongs to the invocation, not to model-supplied args. */
export async function claimBrowserTool(
  conversationId: string,
  invocationId: string,
  claim: ToolClaimInput,
) {
  const decision = await claimToolInvocation(
    conversationId,
    invocationId,
    claim,
  );
  if (decision.outcome) {
    const pending = waiting.get(conversationId);
    if (pending?.invocationId === invocationId)
      pending.resolve?.(decision.outcome);
  }
  return { claimed: decision.claimed };
}

export async function submitBrowserToolResult(
  conversationId: string,
  invocationId: string,
  claim: ToolClaim,
  result: unknown,
  error?: string,
): Promise<void> {
  let outcome: BrowserToolOutcome;
  const context = await getBrowserToolContext(conversationId, invocationId);
  if (error !== undefined) {
    if (typeof error !== "string" || !error.trim() || error.length > 500)
      throw new ConversationError(400, "Invalid storefront action error.");
    if (context.name === "apply_measurements") {
      const command = parseApplyMeasurementsCommand(context.arguments);
      outcome = {
        status: "uncertain",
        productPath: command.productPath,
        draftUpdatedAt: command.draft.updatedAt,
        message:
          "The product fields may have changed, but application was not confirmed. Check the form before requesting another change.",
      };
    } else
      outcome = requiresCartConfirmation(context.name)
        ? interruptedCartResult(true)
        : { error };
  } else {
    try {
      if (context.name === "get_product_guides") {
        outcome = parseProductGuidesResult(result, context.origin);
        if (outcome.productPath !== context.arguments.productPath)
          throw new Error("Guide links belong to another product.");
      } else if (context.name === "navigate") {
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw new Error("Invalid navigation result.");
        const value = result as Record<string, unknown>;
        if (value.status !== "navigated" || Object.keys(value).length !== 2)
          throw new Error("Invalid navigation result.");
        outcome = {
          status: "navigated",
          ...parseNavigationCall({ path: value.path }),
        };
      } else if (context.name === "apply_measurements") {
        outcome = parseApplyMeasurementsResult(result);
      } else if (isCartTool(context.name)) {
        outcome = parseCartResult(context.name, result);
      } else {
        outcome = parseCatalogResult(result, context.origin);
      }
    } catch {
      throw new ConversationError(
        400,
        "The storefront returned an invalid tool result.",
      );
    }
  }
  await completeToolInvocation(
    conversationId,
    invocationId,
    claim,
    "error" in outcome
      ? { productIds: [], error: outcome.error }
      : {
          productIds:
            "products" in outcome
              ? outcome.products.map((product) => product.id)
              : [],
          ...(isCartTool(context.name) ||
          context.name === "apply_measurements" ||
          context.name === "get_product_guides"
            ? {
                outcome: outcome as
                  | CartToolResult
                  | ApplyMeasurementsResult
                  | ProductGuidesResult,
              }
            : {}),
        },
  );
  const pending = waiting.get(conversationId);
  if (pending?.invocationId === invocationId) pending.resolve?.(outcome);
}
