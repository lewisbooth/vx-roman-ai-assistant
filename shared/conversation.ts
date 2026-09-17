export type MessageStatus = "pending" | "complete" | "failed";

import type {
  VoiceCaptionPart,
  VoiceEventPart,
  VoiceSessionSnapshot,
} from "./voice";
import type {
  CartAddedProduct,
  CartAddedSample,
  CartToolName,
} from "./cart-tools";
import type { ProductConfigurationToolName } from "./product-configuration";
import type { ProductGuide, ProductGuideKind } from "./product-guides";
import type { QuestionPart, QuestionAnswerReference } from "./questions";
import type { NavigationPart } from "./navigation-tool";

export interface TextPart {
  type: "text";
  text: string;
  /** A real customer selection during voice, never an audio transcript. */
  questionAnswer?: QuestionAnswerReference;
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

export interface CartAddedPart {
  type: "cart_added";
  version: 1;
  invocationId: string;
  product: CartAddedProduct;
}

export interface CartSampleAddedPart {
  type: "cart_sample_added";
  version: 1;
  invocationId: string;
  sample: CartAddedSample;
}

export type ConversationPart =
  | TextPart
  | ProductListPart
  | GuidePart
  | QuestionPart
  | NavigationPart
  | CartAddedPart
  | CartSampleAddedPart
  | PageViewPart
  | VoiceEventPart
  | VoiceCaptionPart;

export type CatalogToolName =
  "search_products" | "get_product" | "lookup_catalog";

export type BrowserToolName =
  | CatalogToolName
  | CartToolName
  | ProductConfigurationToolName
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
  /** Customer submission identity, when available, for local-send reconciliation. */
  requestId?: string;
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
  /** Current server work only; never stored in the conversation transcript. */
  readingGuides?: ProductGuideKind[];
}

/** Durable state plus current text/activity changes, scoped to one chat. */
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
// 1,200 captions + 200 page observations + 40 turns with two message rows and
// up to eight persisted tool notifications. Actual model action limits are lower.
// Also accommodates 40 selected voice answers and 20 voice lifecycle events.
export const MAX_CONVERSATION_MESSAGES = 1800;
export const CONVERSATION_STORAGE_KEY = "roman:conversation";
