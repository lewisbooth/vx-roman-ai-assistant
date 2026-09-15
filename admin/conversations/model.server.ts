import OpenAI from "openai";
import type {
  Response,
  ResponseInput,
} from "openai/resources/responses/responses";
import {
  catalogToolDefinitions,
  parseCatalogCall,
} from "../../shared/catalog-tools";
import type { CatalogOutcome } from "./browser-tools.server";
import { ROMAN_ADVISOR_PROMPT } from "./prompt.server";

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
  ) => Promise<CatalogOutcome>,
): Promise<ModelReply> {
  client ??= new OpenAI({ maxRetries: 0, timeout: 90_000 });
  const input: ResponseInput = history.map(({ role, text }) => ({
    role,
    content: text,
  }));
  let calls = 0;
  let accumulated = "";
  for (let round = 0; round < 5; round++) {
    signal.throwIfAborted();
    const stream = await client.responses.create(
      {
        model: TEXT_MODEL,
        service_tier: TEXT_SERVICE_TIER,
        reasoning: { effort: "low" },
        instructions: ROMAN_ADVISOR_PROMPT,
        input,
        include: ["reasoning.encrypted_content"],
        ...(execute
          ? {
              tools: [...catalogToolDefinitions],
              parallel_tool_calls: false,
              tool_choice: calls < 4 ? ("auto" as const) : ("none" as const),
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
      };
    }
    if (!execute || calls + toolCalls.length > 4)
      throw new Error("Roman reached the catalog lookup limit for this reply.");
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
      calls++;
      let outcome: CatalogOutcome;
      try {
        const parsed = parseCatalogCall(call.name, JSON.parse(call.arguments));
        signal.throwIfAborted();
        outcome = await execute(call.call_id, parsed.name, parsed.arguments);
      } catch {
        signal.throwIfAborted();
        outcome = {
          error:
            "The store lookup could not be completed. Do not claim product availability or invent the missing details.",
        };
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(outcome),
      });
    }
  }
  throw new Error("Roman reached the catalog lookup limit for this reply.");
}
