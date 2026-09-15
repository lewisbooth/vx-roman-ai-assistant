export type MessageStatus = "pending" | "complete" | "failed";

import type { VoiceCaptionPart, VoiceSessionSnapshot } from "./voice";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ProductListPart {
  type: "products";
  version: 1;
  invocationId: string;
  productIds: string[];
}

export interface PageViewPart {
  type: "page_view";
  version: 1;
  title: string;
  path: string;
  occurredAt: string;
}

export type ConversationPart =
  TextPart | ProductListPart | PageViewPart | VoiceCaptionPart;

export type CatalogToolName =
  "search_products" | "get_product" | "lookup_catalog";

export type BrowserToolName = CatalogToolName | "navigate";

export interface BrowserToolInvocation {
  id: string;
  name: BrowserToolName;
  arguments: Record<string, unknown>;
  status: "pending" | "running";
}

export interface ToolClaim {
  clientId: string;
  claimToken: string;
}

export interface JourneyInput {
  requestId: string;
  title: string;
  path: string;
  occurredAt: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "context";
  status: MessageStatus;
  parts: ConversationPart[];
  createdAt: string;
  error?: string;
}

export interface ConversationSnapshot {
  id: string;
  status: "active" | "ended";
  revision: number;
  messages: ConversationMessage[];
  busy: boolean;
  tools: BrowserToolInvocation[];
  voice?: VoiceSessionSnapshot | null;
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
export const MAX_CONVERSATION_MESSAGES = 1600;
export const CONVERSATION_STORAGE_KEY = "roman:conversation";
