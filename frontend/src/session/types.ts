import type {
  ConversationSnapshot,
  JourneyInput,
} from "../../../shared/conversation";
import type { CatalogResult } from "../../../shared/catalog";
import type { MeasurementToolResult } from "../../../shared/measurements";
import type { LiveVoice, VoiceClientState } from "../../../shared/voice";
import type { PendingToolApproval } from "./tool-approval";

export interface ConversationClientState {
  conversation: ConversationSnapshot | null;
  pending: boolean;
  restoring: boolean;
  error: string | null;
  voice: VoiceClientState;
  selectedVoice: LiveVoice;
  approval: PendingToolApproval | null;
}

export interface ConversationClient {
  getSnapshot(): ConversationClientState;
  subscribe(listener: () => void): () => void;
  /** Resolves when the server has accepted the message, before generation ends. */
  sendMessage(text: string): Promise<void>;
  /** Sends a saved suggested answer to this tab's live connection. */
  sendVoiceAnswer(questionId: string, answer: string): Promise<void>;
  recordPage(input: Omit<JourneyInput, "requestId">): Promise<void>;
  executeMeasurements(
    name: "set_measurements" | "get_measurements",
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MeasurementToolResult>;
  loadProducts(ids: string[], signal?: AbortSignal): Promise<CatalogResult>;
  loadProductImage(
    url: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  resolveToolApproval(invocationId: string, confirmed: boolean): void;
  startVoice(): Promise<void>;
  setVoice(voice: LiveVoice): void;
  stopVoice(): Promise<void>;
  setVoiceMuted(muted: boolean): void;
  end(): Promise<void>;
  clearError(): void;
  dispose(): void;
}
