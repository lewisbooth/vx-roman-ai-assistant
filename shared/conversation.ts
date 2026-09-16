export type MessageStatus = "pending" | "complete" | "failed";

import type { VoiceCaptionPart, VoiceSessionSnapshot } from "./voice";
import type { CartToolName } from "./cart-tools";
import type { ProductGuide } from "./product-guides";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ProductListPart {
  type: "products";
  version: 1;
  invocationId: string;
  productIds: string[];
  /** Display association for a voice result; never evidence of heard speech. */
  voiceReply?: { voiceId: string; afterSequence: number };
}

export interface PageViewPart {
  type: "page_view";
  version: 1;
  title: string;
  path: string;
  occurredAt: string;
}

export interface GuidePart {
  type: "guides";
  version: 1;
  invocationId: string;
  productPath: string;
  guides: ProductGuide[];
  /** Display association only; it does not assert that the shopper heard it. */
  voiceReply?: { voiceId: string; afterSequence: number };
}

export type ConversationPart =
  TextPart | ProductListPart | GuidePart | PageViewPart | VoiceCaptionPart;

export type CatalogToolName =
  "search_products" | "get_product" | "lookup_catalog";

export type BrowserToolName =
  | CatalogToolName
  | CartToolName
  | "navigate"
  | "apply_measurements"
  | "get_product_guides";

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

/** Supplied by the shopper's cart review controls, never by the model's arguments. */
export interface ToolClaimInput extends ToolClaim {
  confirmed?: boolean;
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

/** Durable state plus the current in-process text stream, scoped to one chat. */
export interface ConversationReadVersion {
  revision: number;
  streamRevision: number;
}

export type ConversationReadSnapshot = ConversationSnapshot &
  ConversationReadVersion;

export interface ConversationUnchanged extends ConversationReadVersion {
  id: string;
  unchanged: true;
}

export type ConversationRead = ConversationReadSnapshot | ConversationUnchanged;

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
