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
