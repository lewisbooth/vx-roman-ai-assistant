import type { ProductGuideKind } from "../../shared/product-guides";
import { MAX_PRODUCT_CARDS } from "../../shared/conversation";
import type { QuestionSelection } from "../../shared/questions";
import type { BoundLibrarySource } from "../guides/library.server";

export interface QuestionPresentation extends QuestionSelection {
  callId: string;
  /** Required for measurement inputs; supplied from verified original guides. */
  sourceCallId?: string;
  /** General guidance remains distinct from a product-owned PDF receipt. */
  librarySource?: BoundLibrarySource;
}

/** Server-owned original-file cache receipt; never accepted from model arguments. */
export interface CachedGuideSource {
  sourceCallId: string;
  sourceAssistantId: string;
  productPath: string;
  expiresAt: number;
  kinds: ProductGuideKind[];
}

export interface ProductPresentation {
  callId: string;
  productIds: string[];
  productRefs: { id: string; title: string }[];
}

const productId = /^gid:\/\/shopify\/Product\/\d+$/;

export const showProductsDefinition = {
  type: "function",
  name: "show_products",
  description:
    "Display up to ten selected products in Roman's large, horizontally scrolling carousel. Use for recommendations, collection browsing or whenever the customer asks to see a carousel or product cards, including showing earlier products again. These cards replace the storefront's collection pages in Roman. For discovery, show a useful spread of up to ten relevant verified matches when available; do not artificially cap results at three or four or pad with poor matches. A specific entry-PDP choice still shows only that product. First search or refresh the requested products with catalog tools in this reply, then select IDs from their combined results in the intended display order. For cross-category browsing, follow the shared family-balancing guidance instead of copying a ranked search page. This display call does not consume a storefront call. Call once per reply. Avoid unsolicited carousels during routine price checks or measurement clarification; an explicit request to show products takes precedence. Catalog lookups alone do not display cards.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      productIds: {
        type: "array",
        items: { type: "string", pattern: productId.source, maxLength: 100 },
        minItems: 1,
        maxItems: MAX_PRODUCT_CARDS,
      },
    },
    required: ["productIds"],
    additionalProperties: false,
  },
} as const;

export function parseProductSelection(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Product selection must be an object.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.productIds) ||
    value.productIds.length < 1 ||
    value.productIds.length > MAX_PRODUCT_CARDS ||
    new Set(value.productIds).size !== value.productIds.length ||
    !value.productIds.every(
      (id) => typeof id === "string" && id.length <= 100 && productId.test(id),
    )
  )
    throw new Error(
      `Select one to ${MAX_PRODUCT_CARDS} distinct Shopify Product IDs.`,
    );
  return [...value.productIds];
}
