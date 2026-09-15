import { parseCatalogResult, type CatalogResult } from "../../shared/catalog";
import { parseCatalogCall } from "../../shared/catalog-tools";
import type { ToolClaim } from "../../shared/conversation";
import { ConversationError } from "./errors.server";
import {
  completeToolInvocation,
  createToolInvocation,
  failToolInvocation,
  getConversationOrigin,
} from "./repository.server";

export type CatalogOutcome = CatalogResult | { error: string };
const waiting = new Map<
  string,
  { invocationId: string; resolve: (result: CatalogOutcome) => void }
>();

export async function requestBrowserTool(
  conversationId: string,
  assistantId: string,
  providerCallId: string,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<CatalogOutcome> {
  const call = parseCatalogCall(name, input);
  signal.throwIfAborted();
  if (waiting.has(conversationId))
    throw new Error("A storefront lookup is already running.");
  const invocation = await createToolInvocation(conversationId, assistantId, {
    providerCallId,
    ...call,
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    return await new Promise<CatalogOutcome>((resolve, reject) => {
      const onAbort = () =>
        reject(
          new Error(
            "The storefront lookup did not finish. Please keep this storefront open and try again.",
          ),
        );
      const finish = (result: CatalogOutcome) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(result);
      };
      waiting.set(conversationId, {
        invocationId: invocation.id,
        resolve: finish,
      });
      deadline.addEventListener("abort", onAbort, { once: true });
      if (deadline.aborted) onAbort();
    });
  } catch (error) {
    await failToolInvocation(
      conversationId,
      invocation.id,
      "The storefront lookup was interrupted or timed out.",
    );
    throw error;
  } finally {
    waiting.delete(conversationId);
  }
}

export async function submitBrowserToolResult(
  conversationId: string,
  invocationId: string,
  claim: ToolClaim,
  result: unknown,
  error?: string,
): Promise<void> {
  let outcome: CatalogOutcome;
  if (error !== undefined) {
    if (typeof error !== "string" || !error.trim() || error.length > 500)
      throw new ConversationError(400, "Invalid catalog error.");
    outcome = { error };
  } else {
    try {
      outcome = parseCatalogResult(
        result,
        await getConversationOrigin(conversationId),
      );
    } catch {
      throw new ConversationError(
        400,
        "The storefront returned an invalid catalog result.",
      );
    }
  }
  await completeToolInvocation(
    conversationId,
    invocationId,
    claim,
    "error" in outcome
      ? { productIds: [], error: outcome.error }
      : { productIds: outcome.products.map((product) => product.id) },
  );
  const pending = waiting.get(conversationId);
  if (pending?.invocationId === invocationId) pending.resolve(outcome);
}
