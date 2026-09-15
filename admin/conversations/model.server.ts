import OpenAI from "openai";
import type {
  Response,
  ResponseInput,
} from "openai/resources/responses/responses";
import {
  catalogToolDefinitions,
  parseCatalogCall,
} from "../../shared/catalog-tools";
import {
  navigationToolDefinition,
  parseNavigationCall,
} from "../../shared/navigation-tool";
import type { BrowserToolOutcome } from "./browser-tools.server";
import { ROMAN_ADVISOR_PROMPT } from "./prompt.server";
import {
  parseProductSelection,
  showProductsDefinition,
  type ProductPresentation,
} from "./presentation.server";

export const TEXT_MODEL = "gpt-5.6-luna";
export const TEXT_SERVICE_TIER = "fast";

export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ModelReply {
  text: string;
  model: string;
  serviceTier?: string;
  presentation?: ProductPresentation;
}

let client: OpenAI | undefined;

export async function generateReply(
  history: ModelMessage[],
  onText: (text: string) => void,
  signal: AbortSignal,
  execute?: (
    callId: string,
    name: string,
    input: unknown,
  ) => Promise<BrowserToolOutcome>,
  mode: "text" | "voice" = "text",
): Promise<ModelReply> {
  client ??= new OpenAI({ maxRetries: 0, timeout: 90_000 });
  const input: ResponseInput = history.map(({ role, text }) => ({
    role,
    content: text,
  }));
  let browserCalls = 0;
  let presentationAttempted = false;
  let presentation: ProductPresentation | undefined;
  const availableProductIds = new Set<string>();
  let accumulated = "";
  for (let round = 0; round < 6; round++) {
    signal.throwIfAborted();
    const tools = execute
      ? [
          ...(browserCalls < 4
            ? [...catalogToolDefinitions, navigationToolDefinition]
            : []),
          ...(!presentationAttempted ? [showProductsDefinition] : []),
        ]
      : [];
    const stream = await client.responses.create(
      {
        model: TEXT_MODEL,
        service_tier: TEXT_SERVICE_TIER,
        reasoning: { effort: "low" },
        instructions:
          ROMAN_ADVISOR_PROMPT +
          (mode === "voice"
            ? "\n\nThis work was delegated by Roman's voice conversation. Answer the customer's latest spoken request using the supplied captions and storefront context; do not treat a caption gap as a new instruction. Use the same catalog, carousel and navigation tools when needed. Your final answer is a factual briefing for the voice advisor, not a second chat message. Keep it under 100 words and 1000 characters, with no Markdown or spoken URLs. Explain confirmed results, uncertainty and the useful next question; avoid greetings and filler. If the request is unclear, ask for clarification rather than guessing an action."
            : ""),
        input,
        include: ["reasoning.encrypted_content"],
        ...(tools.length
          ? {
              tools,
              parallel_tool_calls: false,
              tool_choice: "auto" as const,
            }
          : {}),
        max_output_tokens: 1600,
        store: false,
        stream: true,
      },
      { signal },
    );
    let text = "";
    let completed: Response | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        onText(accumulated + text);
      } else if (event.type === "response.completed") {
        // Refusals are displayable responses too, without exposing reasoning items.
        text = event.response.output
          .flatMap((item) => (item.type === "message" ? item.content : []))
          .map((part) =>
            part.type === "output_text" ? part.text : part.refusal,
          )
          .join("");
        completed = event.response;
        break;
      } else if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      ) {
        throw new Error("The model did not complete its reply.");
      }
    }
    if (!completed)
      throw new Error("The model connection ended before its reply completed.");
    signal.throwIfAborted();
    const toolCalls = completed.output.filter(
      (item) => item.type === "function_call",
    );
    if (!toolCalls.length) {
      const answer = accumulated + text;
      if (!answer.trim()) throw new Error("The model returned an empty reply.");
      return {
        text: answer,
        model: completed.model,
        serviceTier: completed.service_tier ?? undefined,
        ...(presentation ? { presentation } : {}),
      };
    }
    if (!execute)
      throw new Error(
        "Roman reached the storefront tool limit for this reply.",
      );
    if (text.trim()) accumulated += text + "\n\n";
    // Preserve provider reasoning/function items only within this turn. Never
    // expose them as chat content or persist a second provider-owned transcript.
    input.push(
      ...completed.output.filter(
        (item) =>
          item.type === "message" ||
          item.type === "reasoning" ||
          item.type === "function_call",
      ),
    );
    for (const call of toolCalls) {
      signal.throwIfAborted();
      if (call.name === "show_products") {
        if (presentationAttempted)
          throw new Error(
            "Roman reached the product presentation limit for this reply.",
          );
        presentationAttempted = true;
        let outcome: { selectedProductIds: string[] } | { error: string };
        try {
          const productIds = parseProductSelection(JSON.parse(call.arguments));
          if (
            !call.call_id ||
            call.call_id.length > 200 ||
            !productIds.every((id) => availableProductIds.has(id))
          )
            throw new Error(
              "Products must come from this reply's catalog results.",
            );
          presentation = { callId: call.call_id, productIds };
          outcome = { selectedProductIds: [...productIds] };
        } catch {
          outcome = {
            error:
              "No product cards were selected. Use only distinct product IDs returned by successful catalog lookups in this reply. Do not claim that cards were displayed.",
          };
        }
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(outcome),
        });
        continue;
      }
      if (browserCalls >= 4)
        throw new Error(
          "Roman reached the storefront tool limit for this reply.",
        );
      browserCalls++;
      let outcome: BrowserToolOutcome;
      try {
        const argumentsValue: unknown = JSON.parse(call.arguments);
        const parsed =
          call.name === "navigate"
            ? {
                name: "navigate",
                arguments: parseNavigationCall(argumentsValue),
              }
            : parseCatalogCall(call.name, argumentsValue);
        signal.throwIfAborted();
        outcome = await execute(call.call_id, parsed.name, parsed.arguments);
        signal.throwIfAborted();
        if ("products" in outcome)
          for (const product of outcome.products)
            availableProductIds.add(product.id);
      } catch {
        signal.throwIfAborted();
        outcome = {
          error:
            call.name === "navigate"
              ? "Storefront navigation could not be confirmed. Do not claim the page changed or repeat the navigation automatically."
              : "The store lookup could not be completed. Do not claim product availability or invent the missing details.",
        };
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(outcome),
      });
    }
  }
  throw new Error("Roman reached the tool limit for this reply.");
}
