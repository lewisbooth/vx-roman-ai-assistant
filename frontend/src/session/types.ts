import type { ConversationSnapshot } from "../../../shared/conversation";

export interface ConversationClientState {
  conversation: ConversationSnapshot | null;
  pending: boolean;
  restoring: boolean;
  error: string | null;
}

export interface ConversationClient {
  getSnapshot(): ConversationClientState;
  subscribe(listener: () => void): () => void;
  /** Resolves when the server has accepted the message, before generation ends. */
  sendMessage(text: string): Promise<void>;
  clearError(): void;
  dispose(): void;
}
