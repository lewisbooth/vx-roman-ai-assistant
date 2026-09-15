import type { CatalogToolName } from "./conversation";

const gid = /^gid:\/\/shopify\/(?:Product|ProductVariant)\/\d+$/;
const idSchema = { type: "string", pattern: gid.source };

export const catalogToolDefinitions = [
  {
    type: "function",
    name: "search_products",
    description:
      "Search this store's current product catalog. Use before claiming the store carries a product or recommending specific products. Include relevant customer needs. Results are not a fitted-product quote or proof of suitability.",
    strict: true,
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_product",
    description:
      "Get current details for a product or variant ID returned by this store's catalog. Read available details before making product-specific fitting or material claims; missing details are unknown.",
    strict: true,
    parameters: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "lookup_catalog",
    description:
      "Refresh current details for up to ten product or variant IDs already seen in this conversation. Use to compare previous recommendations. Missing products must not be recommended as available.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: idSchema, minItems: 1, maxItems: 10 },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
] as const;

export function parseCatalogCall(
  name: string,
  input: unknown,
): { name: CatalogToolName; arguments: Record<string, unknown> } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Catalog arguments must be an object.");
  const args = input as Record<string, unknown>;
  const keys = Object.keys(args);
  if (
    name === "search_products" &&
    keys.length === 1 &&
    typeof args.query === "string" &&
    args.query.trim() &&
    args.query.length <= 500
  ) {
    return { name, arguments: { query: args.query.trim() } };
  }
  if (
    name === "get_product" &&
    keys.length === 1 &&
    typeof args.id === "string" &&
    gid.test(args.id)
  )
    return { name, arguments: { id: args.id } };
  if (
    name === "lookup_catalog" &&
    keys.length === 1 &&
    Array.isArray(args.ids) &&
    args.ids.length > 0 &&
    args.ids.length <= 10 &&
    args.ids.every((id) => typeof id === "string" && gid.test(id))
  ) {
    return { name, arguments: { ids: [...new Set(args.ids)] } };
  }
  throw new Error("This catalog tool or its arguments are not supported.");
}
