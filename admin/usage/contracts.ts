export type ModelUsageStatus =
  "pending" | "completed" | "failed" | "incomplete" | "unavailable";

/** Provider-reported counts; null is unknown, including older conversations. */
export interface ModelUsageUpdate {
  id: string;
  model: string;
  serviceTier: string | null;
  status: ModelUsageStatus;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface VoiceUsage {
  model: string;
  seconds: number | null;
}
