import OpenAI from "openai";
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
): Promise<ModelReply> {
  client ??= new OpenAI({ maxRetries: 0, timeout: 90_000 });
  const stream = await client.responses.create(
    {
      model: TEXT_MODEL,
      service_tier: TEXT_SERVICE_TIER,
      reasoning: { effort: "low" },
      instructions: ROMAN_ADVISOR_PROMPT,
      input: history.map(({ role, text }) => ({ role, content: text })),
      max_output_tokens: 1600,
      store: false,
      stream: true,
    },
    { signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      onText(text);
    } else if (event.type === "response.completed") {
      // Refusals are displayable responses too, without exposing reasoning items.
      text = event.response.output
        .flatMap((item) => (item.type === "message" ? item.content : []))
        .map((part) => (part.type === "output_text" ? part.text : part.refusal))
        .join("");
      if (!text.trim()) throw new Error("The model returned an empty reply.");
      return {
        text,
        model: event.response.model,
        serviceTier: event.response.service_tier ?? undefined,
      };
    } else if (
      event.type === "response.failed" ||
      event.type === "response.incomplete" ||
      event.type === "error"
    ) {
      throw new Error("The model did not complete its reply.");
    }
  }
  throw new Error("The model connection ended before its reply completed.");
}
