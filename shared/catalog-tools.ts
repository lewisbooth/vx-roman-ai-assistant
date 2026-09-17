import type { CatalogToolName } from "./conversation";

const gid = /^gid:\/\/shopify\/(?:Product|ProductVariant)\/\d+$/;
const idSchema = { type: "string", pattern: gid.source };

export const catalogToolDefinitions = [
  {
    type: "function",
    name: "search_products",
    description:
      "Search this store's current product catalog for candidates matching known customer needs. Inspect each candidate's returned description before recommending it; use lookup_catalog for a shortlist or get_product for one when needed details are missing. Search rank, titles and images alone are not product evidence. Verify known fitting constraints through relevant store guidance before recommending candidates, not after the customer chooses. Results are not a fitted-product quote or proof of suitability.",
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
      "Get current catalog details for one product or variant ID returned by this store. Use to investigate a candidate or a specific product question when search details are insufficient. Inspect the returned description; the compact result does not expose every option or specification, and missing details remain unknown. Use native configuration for current options and verified store guidance for fitting compatibility. Reuse a sufficient detail read rather than repeating it.",
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
      "Read current catalog details for up to ten product or variant IDs already returned by this store. Batch a shortlist in one call to investigate relevant features before recommending products when search details are insufficient, or refresh earlier recommendations. Compare actual returned descriptions, not just titles; a lookup cannot verify facts it does not return. Missing products must not be recommended as available. Do not repeat a sufficient current-turn read.",
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
