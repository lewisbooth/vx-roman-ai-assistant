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
