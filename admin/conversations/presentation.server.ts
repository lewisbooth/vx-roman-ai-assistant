export interface ProductPresentation {
  callId: string;
  productIds: string[];
}

const productId = /^gid:\/\/shopify\/Product\/\d+$/;

export const showProductsDefinition = {
  type: "function",
  name: "show_products",
  description:
    "Select up to six products for one visible recommendation carousel, in display order. Use only IDs returned by successful catalog lookups in this reply. Call once for deliberate new recommendations or alternatives, not routine price checks, measurement-unit clarification, or repeating earlier cards. Catalog lookups do not show cards by themselves.",
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
