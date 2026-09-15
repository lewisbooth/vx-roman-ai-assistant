// BuiltInVoice in the OpenAI Live API. Keep this browser-safe list aligned with
// https://developers.openai.com/api/reference/typescript/resources/live#built-in-voice
export const LIVE_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "beacon",
  "bossa",
  "cedar",
  "cinder",
  "coral",
  "delta",
  "echo",
  "gleam",
  "marin",
  "meridian",
  "quartz",
  "ripple",
  "sage",
  "shimmer",
  "stone",
  "tempo",
  "verse",
  "vesper",
  "willow",
] as const;

export type LiveVoice = (typeof LIVE_VOICES)[number];
export const DEFAULT_LIVE_VOICE: LiveVoice = "marin";

export function isLiveVoice(value: unknown): value is LiveVoice {
  return (
    typeof value === "string" && LIVE_VOICES.some((voice) => voice === value)
  );
}

export interface VoiceSessionSnapshot {
  id: string;
  clientId: string;
  status: "starting" | "active" | "closed" | "failed";
  error?: string;
}

export interface VoiceCaptionPart {
  type: "voice";
  version: 1;
  voiceId: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceStartResult {
  voiceId: string;
  sdp: string;
}

export interface VoiceClientState {
  status: "idle" | "starting" | "active" | "stopping" | "error";
  muted: boolean;
  error: string | null;
}
