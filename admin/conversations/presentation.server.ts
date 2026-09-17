import type { ProductGuideKind } from "../../shared/product-guides";
import type { QuestionSelection } from "../../shared/questions";

export interface QuestionPresentation extends QuestionSelection {
  callId: string;
  /** Required for measurement inputs; supplied from this turn's guide read. */
  sourceCallId?: string;
}

export interface ProductPresentation {
  callId: string;
  productIds: string[];
}

/** The source call is supplied by the runner, never by model-authored URLs. */
export interface GuidePresentation {
  callId: string;
  sourceCallId: string;
  productPath: string;
  kinds: ProductGuideKind[];
}

const productId = /^gid:\/\/shopify\/Product\/\d+$/;

export const showProductsDefinition = {
  type: "function",
  name: "show_products",
  description:
    "Display up to six selected products in a horizontally scrolling carousel inside this chat. Use for recommendations or whenever the customer asks to see a carousel or product cards, including showing earlier products again. First search or refresh the requested products with a catalog tool in this reply, then pass their returned IDs in display order. Call once per reply. Avoid unsolicited carousels during routine price checks or measurement clarification; an explicit request to show products takes precedence. Catalog lookups alone do not display cards.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      productIds: {
        type: "array",
        items: { type: "string", pattern: productId.source, maxLength: 100 },
        minItems: 1,
        maxItems: 6,
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
    value.productIds.length > 6 ||
    new Set(value.productIds).size !== value.productIds.length ||
    !value.productIds.every(
      (id) => typeof id === "string" && id.length <= 100 && productId.test(id),
    )
  )
    throw new Error("Select one to six distinct Shopify Product IDs.");
  return [...value.productIds];
}
