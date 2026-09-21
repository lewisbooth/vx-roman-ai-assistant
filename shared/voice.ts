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

export interface VoiceEventPart {
  type: "voice_event";
  version: 1;
  voiceId: string;
  event: "started" | "ended" | "disconnected";
}

export const VOICE_EVENT_LABELS = {
  started: "Voice chat started",
  ended: "Voice chat ended",
  disconnected: "Voice chat disconnected",
} as const;

export function parseVoiceEventPart(input: unknown): VoiceEventPart {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid voice event.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    value.type !== "voice_event" ||
    value.version !== 1 ||
    typeof value.voiceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.voiceId,
    ) ||
    (value.event !== "started" &&
      value.event !== "ended" &&
      value.event !== "disconnected")
  )
    throw new Error("Invalid voice event.");
  return {
    type: "voice_event",
    version: 1,
    voiceId: value.voiceId,
    event: value.event,
  };
}

export interface VoiceStartResult {
  voiceId: string;
  sdp: string;
}

export interface VoiceClientState {
  status: "idle" | "starting" | "active" | "stopping" | "error";
  muted: boolean;
  error: string | null;
  errorCode?: "microphone_denied";
}
