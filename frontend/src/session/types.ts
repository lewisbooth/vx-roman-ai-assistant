import type {
  ConversationSnapshot,
  JourneyInput,
} from "../../../shared/conversation";
import type { CatalogResult } from "../../../shared/catalog";

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
  recordPage(input: Omit<JourneyInput, "requestId">): Promise<void>;
  loadProducts(ids: string[]): Promise<CatalogResult>;
  end(): Promise<void>;
  clearError(): void;
  dispose(): void;
}
