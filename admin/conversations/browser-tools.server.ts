import { parseCatalogResult, type CatalogResult } from "../../shared/catalog";
import { parseCatalogCall } from "../../shared/catalog-tools";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../shared/navigation-tool";
import type { ToolClaim } from "../../shared/conversation";
import { ConversationError } from "./errors.server";
import {
  completeToolInvocation,
  createToolInvocation,
  failToolInvocation,
  getBrowserToolContext,
} from "./repository.server";

export type BrowserToolOutcome =
  CatalogResult | NavigationResult | { error: string };
interface BrowserWaiter {
  invocationId?: string;
  resolve?: (result: BrowserToolOutcome) => void;
}
const waiting = new Map<string, BrowserWaiter>();

export async function requestBrowserTool(
  conversationId: string,
  assistantId: string,
  providerCallId: string,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<BrowserToolOutcome> {
  const call =
    name === "navigate"
      ? { name: "navigate" as const, arguments: parseNavigationCall(input) }
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
    if (waiter.invocationId)
      await failToolInvocation(
        conversationId,
        waiter.invocationId,
        "The storefront action was interrupted or timed out.",
      );
    throw error;
  } finally {
    if (deadline && onAbort) deadline.removeEventListener("abort", onAbort);
    if (waiting.get(conversationId) === waiter) waiting.delete(conversationId);
  }
}

export async function submitBrowserToolResult(
  conversationId: string,
  invocationId: string,
  claim: ToolClaim,
  result: unknown,
  error?: string,
): Promise<void> {
  let outcome: BrowserToolOutcome;
  if (error !== undefined) {
    if (typeof error !== "string" || !error.trim() || error.length > 500)
      throw new ConversationError(400, "Invalid storefront action error.");
    outcome = { error };
  } else {
    const context = await getBrowserToolContext(conversationId, invocationId);
    try {
      if (context.name === "navigate") {
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw new Error("Invalid navigation result.");
        const value = result as Record<string, unknown>;
        if (value.status !== "navigated" || Object.keys(value).length !== 2)
          throw new Error("Invalid navigation result.");
        outcome = {
          status: "navigated",
          ...parseNavigationCall({ path: value.path }),
        };
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
        },
  );
  const pending = waiting.get(conversationId);
  if (pending?.invocationId === invocationId) pending.resolve?.(outcome);
}
