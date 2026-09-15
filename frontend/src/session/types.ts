import type {
  ConversationSnapshot,
  JourneyInput,
} from "../../../shared/conversation";
import type { CatalogResult } from "../../../shared/catalog";
import type { LiveVoice, VoiceClientState } from "../../../shared/voice";

export interface ConversationClientState {
  conversation: ConversationSnapshot | null;
  pending: boolean;
  restoring: boolean;
  error: string | null;
  voice: VoiceClientState;
  selectedVoice: LiveVoice;
}

export interface ConversationClient {
  getSnapshot(): ConversationClientState;
  subscribe(listener: () => void): () => void;
  /** Resolves when the server has accepted the message, before generation ends. */
  sendMessage(text: string): Promise<void>;
  recordPage(input: Omit<JourneyInput, "requestId">): Promise<void>;
  loadProducts(ids: string[]): Promise<CatalogResult>;
  startVoice(): Promise<void>;
  setVoice(voice: LiveVoice): void;
  stopVoice(): Promise<void>;
  setVoiceMuted(muted: boolean): void;
  end(): Promise<void>;
  clearError(): void;
  dispose(): void;
}
