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
export const VOICE_IDLE_MS = 60_000;
export const VOICE_IDLE_WARNING_MS = 15_000;

export const VOICE_CLOSE_REASONS = [
  "transport_lost", "provider_expired", "idle", "user_stop", "outage", "policy", "error",
] as const;
export type VoiceCloseReason = (typeof VOICE_CLOSE_REASONS)[number];

export function isVoiceCloseReason(value: unknown): value is VoiceCloseReason {
  return VOICE_CLOSE_REASONS.some((reason) => reason === value);
}

export function canRecoverVoice(reason: unknown): boolean {
  return reason === "transport_lost" || reason === "provider_expired";
}

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
  closeReason?: VoiceCloseReason;
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

/** Trusted backend acceptance of speech; captions alone never imply a new task. */
export interface VoiceTurnPart {
  type: "voice_turn";
  version: 1;
  voiceId: string;
  throughSequence: number;
  offsetMs: number;
}

export function parseVoiceTurnPart(input: unknown): VoiceTurnPart {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid accepted voice turn.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 5 ||
    value.type !== "voice_turn" || value.version !== 1 ||
    typeof value.voiceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.voiceId) ||
    typeof value.throughSequence !== "number" ||
    !Number.isSafeInteger(value.throughSequence) || value.throughSequence < 0 ||
    typeof value.offsetMs !== "number" || !Number.isFinite(value.offsetMs) || value.offsetMs < 0
  ) throw new Error("Invalid accepted voice turn.");
  return {
    type: "voice_turn", version: 1, voiceId: value.voiceId,
    throughSequence: value.throughSequence, offsetMs: value.offsetMs,
  };
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
