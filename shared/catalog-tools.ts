const gid = /^gid:\/\/shopify\/(?:Product|ProductVariant)\/\d+$/;
const idSchema = { type: "string", pattern: gid.source };

export const catalogToolDefinitions = [
  {
    type: "function",
    name: "search_products",
    description:
      "Search this store's catalog with 1–3 targeted queries in one operation. Queries run concurrently and each returns up to ten ranked candidates. Results include deduplicated products, per-query outcomes and product IDs identifying which queries found each product. A failed query does not discard successful results. Catalog prices are starting prices, not configured quotes.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 500 },
          minItems: 1,
          maxItems: 3,
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_product",
    description:
      "Get current catalog details for one product or variant ID returned by this store. Returns the product description and starting price; missing fields remain unknown.",
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
      "Read current catalog details for 1–10 product or variant IDs already returned by this store. Returns matching product descriptions and starting prices, with messages for missing identifiers.",
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

export type CatalogCall =
  | { name: "search_products"; arguments: { queries: string[] } }
  | { name: "get_product"; arguments: { id: string } }
  | { name: "lookup_catalog"; arguments: { ids: string[] } };

export function parseCatalogCall(
  name: "search_products",
  input: unknown,
): Extract<CatalogCall, { name: "search_products" }>;
export function parseCatalogCall(
  name: "get_product",
  input: unknown,
): Extract<CatalogCall, { name: "get_product" }>;
export function parseCatalogCall(
  name: "lookup_catalog",
  input: unknown,
): Extract<CatalogCall, { name: "lookup_catalog" }>;
export function parseCatalogCall(name: string, input: unknown): CatalogCall;
export function parseCatalogCall(name: string, input: unknown): CatalogCall {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Catalog arguments must be an object.");
  const args = input as Record<string, unknown>;
  const keys = Object.keys(args);
  if (
    name === "search_products" &&
    keys.length === 1 &&
    Array.isArray(args.queries) &&
    args.queries.length >= 1 &&
    args.queries.length <= 3 &&
    args.queries.every(
      (query) =>
        typeof query === "string" && query.trim() && query.length <= 500,
    )
  ) {
    const queries = args.queries.map((query: string) => query.trim());
    if (new Set(queries).size === queries.length)
      return { name, arguments: { queries } };
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
