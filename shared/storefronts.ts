// Shopify's permanent shop identity is separate from its storefront domains.
// Keep aliases explicit; never authorize a wildcard parent domain.
export const CONVERSATION_STOREFRONTS: Readonly<
  Record<string, readonly string[]>
> = {
  "hd-dev-multi.myshopify.com": ["https://hd-dev-multi.myshopify.com"],
  "hd-dev-single.myshopify.com": [
    "https://hd-dev-single.myshopify.com",
    "https://shopify-single-dev.hdecom.com",
  ],
};

export function isConversationStorefront(origin: string): boolean {
  return Object.values(CONVERSATION_STOREFRONTS).some((origins) =>
    origins.includes(origin),
  );
}

export function isConversationStorefrontForShop(
  shop: string,
  origin: string,
): boolean {
  return (
    Object.hasOwn(CONVERSATION_STOREFRONTS, shop) &&
    CONVERSATION_STOREFRONTS[shop].includes(origin)
  );
}
