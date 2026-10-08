import type { ProductChoice, ProductChoiceReference } from "./product-choice";
import type { VoiceTranscriptFragment } from "./voice-transcript";

export type MessageStatus = "pending" | "complete" | "failed";

import type {
  VoiceCaptionPart,
  VoiceEventPart,
  VoiceTurnPart,
  VoiceSessionSnapshot,
} from "./voice";
import type {
  CartAddedProduct,
  CartAddedSample,
  CartToolName,
} from "./cart-tools";
import type { ProductConfigurationToolName } from "./product-configuration";
import type { ProductGuide, ProductGuideKind } from "./product-guides";
import type {
  QuestionPart,
  QuestionAnswerReference,
  VoiceInputReference,
} from "./questions";
import type { NavigationPart } from "./navigation-tool";
import type { MediaPart, WindowPhotoDto } from "./visualizations";

export interface TextPart {
  type: "text";
  text: string;
  /** A real customer selection during voice, never an audio transcript. */
  questionAnswer?: QuestionAnswerReference;
  /** Exact carousel selection; voiceId is present only for a voice receipt. */
  productChoice?: ProductChoiceReference;
  /** Typed customer input delivered through an active voice connection. */
  voiceInput?: VoiceInputReference;
}

export interface ProductListPart {
  type: "products";
  version: 1;
  invocationId: string;
  productIds: string[];
  /** Titles verified when these cards were shown; refresh before using current details. */
  productRefs?: { id: string; title: string }[];
  /** Display association for a voice result; never evidence of heard speech. */
  voiceReply?: { voiceId: string; afterSequence: number };
}

/** Maximum verified products in one customer-facing carousel. */
export const MAX_PRODUCT_CARDS = 10;

export interface PageViewPart {
  type: "page_view";
  version: 1;
  title: string;
  path: string;
  occurredAt: string;
}

export type GuidePart = {
  type: "guides";
  invocationId: string;
  guides: ProductGuide[];
  /** Display association only; it does not assert that the shopper heard it. */
  voiceReply?: { voiceId: string; afterSequence: number };
} & (
  | { version: 1; productPath: string }
  | {
      version: 2;
      libraryPagePath: "/pages/measuring-blinds" | "/pages/measuring-curtains";
    }
);

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
  | VoiceTurnPart
  | VoiceCaptionPart
  | MediaPart;

export type CatalogToolName =
  "search_products" | "get_product" | "lookup_catalog";

export type BrowserToolName =
  | CatalogToolName
  | CartToolName
  | ProductConfigurationToolName
  | "navigate"
  | "show_view"
  | "open_checkout"
  | "apply_measurements"
  | "get_product_guides"
  | "discover_guides"
  | "get_store_support";

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
  /** Display positions; late ASR can reorder captions into earlier slots. */
  sequence?: number;
  endSequence?: number;
  /** Exact stored source range, independently of caption display order. */
  sourceSequence?: number;
  sourceEndSequence?: number;
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
  history: ConversationHistoryPage;
  /** Recently changed reserved rows may precede the current caption page. */
  historyUpdates: ConversationHistoryEntry[];
  current: ConversationCurrentState;
  busy: boolean;
  tools: BrowserToolInvocation[];
  voice?: VoiceSessionSnapshot | null;
  /** Current server work only; never stored in the conversation transcript. */
  readingGuides?: ProductGuideKind[];
}

export interface ConversationCurrentState {
  activeProduct: { path: string; title: string } | null;
  pendingQuestion: QuestionPart | null;
  hasCustomerReply: boolean;
  selectedWindow?: WindowPhotoDto | null;
  galleryEnabled?: boolean;
}

/** Exact public timeline inputs; grouping happens after adjacent pages merge. */
export type ConversationHistoryEntry =
  | { sequence: number; message: ConversationMessage }
  | {
      sequence: number;
      caption: Omit<VoiceTranscriptFragment, "providerEventId">;
    };

export interface ConversationHistoryPage {
  /** Half-open durable sequence range, including invisible bookkeeping rows. */
  start: number;
  end: number;
  before: number | null;
  entries: ConversationHistoryEntry[];
}

export interface ConversationHistoryResult {
  id: string;
  revision: number;
  history: ConversationHistoryPage;
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
  productChoice?: ProductChoice;
}

export const MAX_MESSAGE_LENGTH = 4000;
// Bounds one transport envelope, never the lifetime of a conversation.
export const CONVERSATION_HISTORY_PAGE_SIZE = 256;
export const MAX_HISTORY_UPDATES = 16;
export const CONVERSATION_STORAGE_KEY = "roman:conversation";
