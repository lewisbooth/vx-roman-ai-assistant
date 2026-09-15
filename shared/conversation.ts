export type MessageStatus = "pending" | "complete" | "failed";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  status: MessageStatus;
  parts: TextPart[];
  createdAt: string;
  error?: string;
}

export interface ConversationSnapshot {
  id: string;
  messages: ConversationMessage[];
  busy: boolean;
}

export interface ConversationCredential {
  conversationId: string;
  token: string;
  expiresAt: string;
  apiBaseUrl: string;
}

export interface ConversationBootstrap extends ConversationCredential {
  conversation: ConversationSnapshot;
}

export interface SendMessageInput {
  requestId: string;
  text: string;
}

export const MAX_MESSAGE_LENGTH = 4000;
