import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import { parseRoomAnalysis, roomAnalysisSchema } from "../../shared/room-analysis";
import { ROOM_ANALYSIS_PROMPT } from "../prompts/room-analysis.server";
import type { ModelUsageUpdate } from "../usage/contracts";

export const ROOM_ANALYSIS_MODEL = "gpt-5.6-luna";
export const ROOM_ANALYSIS_TIMEOUT_MS = 30_000;
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
export function analysisUsage(id: string, status: ModelUsageUpdate["status"], response?: Response): ModelUsageUpdate {
  const usage = response?.usage;
  const input = count(usage?.input_tokens);
  const cached = count(usage?.input_tokens_details?.cached_tokens);
  const written = count(usage?.input_tokens_details?.cache_write_tokens);
  const output = count(usage?.output_tokens);
  const reasoning = count(usage?.output_tokens_details?.reasoning_tokens);
  return {
    id, status,
    model: response?.model && /^[a-zA-Z0-9._:-]{1,100}$/.test(response.model) ? response.model : ROOM_ANALYSIS_MODEL,
    serviceTier: response?.service_tier && /^[a-z0-9_-]{1,40}$/.test(response.service_tier) ? response.service_tier : null,
    inputTokens: input,
    cachedInputTokens: cached !== null && input !== null && cached > input ? null : cached,
    cacheWriteInputTokens: written !== null && input !== null && written + (cached ?? 0) > input ? null : written,
    outputTokens: output,
    reasoningTokens: reasoning !== null && output !== null && reasoning > output ? null : reasoning,
    totalTokens: count(usage?.total_tokens),
  };
}

/** Pixels remain in this short request, never the advisor's durable history. */
export async function analyzeRoomPhoto(bytes: Buffer, options: {
  usageId: string;
  signal: AbortSignal;
  onUsage: (usage: ModelUsageUpdate) => Promise<void>;
}) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: ROOM_ANALYSIS_TIMEOUT_MS });
  const response = await client.responses.create({
    model: ROOM_ANALYSIS_MODEL,
    service_tier: "fast",
    reasoning: { effort: "none" },
    instructions: ROOM_ANALYSIS_PROMPT,
    input: [{ role: "user", content: [
      { type: "input_text", text: "Record the visible room and window observations." },
      { type: "input_image", image_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, detail: "high" },
    ] }],
    text: { format: { type: "json_schema", name: "roman_room_observations", strict: true, schema: roomAnalysisSchema } },
    max_output_tokens: 2_400,
    store: false,
  }, { signal: options.signal });
  // Account for a physical response even when its output is incomplete or invalid.
  await options.onUsage(analysisUsage(options.usageId, response.status === "completed" ? "completed" : response.status === "incomplete" ? "incomplete" : "failed", response));
  if (response.status !== "completed") throw new Error("Room analysis did not complete.");
  return parseRoomAnalysis(JSON.parse(response.output_text));
}
