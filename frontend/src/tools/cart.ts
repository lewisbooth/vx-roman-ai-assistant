import type { CartSnapshot } from "../../../shared/cart-tools";

type ShopifyWindow = Window & { Shopify?: { routes?: { root?: string } } };

export type StoreCart = Record<string, unknown> & {
  currency: string;
  item_count: number;
  total_price: number;
  items: (Record<string, unknown> & {
    key: string;
    title: string;
    quantity: number;
    variant_id: number;
    final_line_price: number;
  })[];
};

function cartUrl(): URL {
  const root = new URL(
    (window as ShopifyWindow).Shopify?.routes?.root ?? "/",
    window.location.origin,
  );
  if (
    root.origin !== window.location.origin ||
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    !root.pathname.endsWith("/")
  )
    throw new Error("The storefront cart route is invalid.");
  return new URL("cart.js", root);
}

// Raw cart data is for theme integration only; tool results use summarizeCart.
export async function getStoreCart(signal: AbortSignal): Promise<StoreCart> {
  signal.throwIfAborted();
  const url = cartUrl();
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Shopify cart request could not be completed.");
  }
  signal.throwIfAborted();
  if (!response.ok)
    throw new Error(`Shopify cart request failed (${response.status}).`);
  // Shopify's cart.js endpoint serves JSON with a text/javascript content type.
  // Parse it as data and validate its shape; never evaluate it as a script.
  let cart: unknown;
  try {
    cart = await response.json();
  } catch {
    signal.throwIfAborted();
    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType === "text/html" || contentType === "application/xhtml+xml")
      throw new Error(
        "Shopify returned an HTML page instead of cart data. Check your storefront login.",
      );
    throw new Error("Shopify returned invalid cart JSON.");
  }
  signal.throwIfAborted();
  return validateStoreCart(cart);
}

export function validateStoreCart(cart: unknown): StoreCart {
  if (!cart || typeof cart !== "object" || Array.isArray(cart))
    throw new Error("Shopify returned invalid cart data.");
  const {
    currency,
    item_count: itemCount,
    total_price: totalPrice,
    items,
  } = cart as Record<string, unknown>;
  if (
    typeof currency !== "string" ||
    !currency.trim() ||
    typeof itemCount !== "number" ||
    !Number.isSafeInteger(itemCount) ||
    itemCount < 0 ||
    typeof totalPrice !== "number" ||
    !Number.isFinite(totalPrice) ||
    !Array.isArray(items)
  )
    throw new Error("Shopify returned invalid cart data.");
  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Shopify returned an invalid cart item.");
    const item = value as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      !item.key.trim() ||
      typeof item.title !== "string" ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 0 ||
      typeof item.variant_id !== "number" ||
      !Number.isSafeInteger(item.variant_id) ||
      typeof item.final_line_price !== "number" ||
      !Number.isFinite(item.final_line_price)
    )
      throw new Error("Shopify returned an invalid cart item.");
  }
  return cart as StoreCart;
}

export function summarizeCart(cart: StoreCart): CartSnapshot {
  // Return the shopper's items, never the cart token, note or customer attributes.
  return {
    currency: cart.currency,
    itemCount: cart.item_count,
    totalPriceMinorUnits: cart.total_price,
    items: cart.items.map((item) => ({
      lineKey: item.key,
      title: item.title,
      variantId: item.variant_id,
      quantity: item.quantity,
      linePriceMinorUnits: item.final_line_price,
    })),
  };
}

export async function getCart(signal: AbortSignal): Promise<CartSnapshot> {
  return summarizeCart(await getStoreCart(signal));
}

/** Theme cart events must confirm the exact variant's quantity increased. */
export function cartVariantQuantity(cart: unknown, variantId: string): number | null {
  if (!cart || typeof cart !== "object") return null;
  const items = (cart as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  let quantity = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const record = item as { variant_id?: unknown; quantity?: unknown };
    if (
      typeof record.variant_id !== "number" ||
      !Number.isSafeInteger(record.variant_id) ||
      record.variant_id <= 0 ||
      typeof record.quantity !== "number" ||
      !Number.isSafeInteger(record.quantity) ||
      record.quantity < 0
    ) return null;
    if (String(record.variant_id) === variantId) quantity += record.quantity;
  }
  return Number.isSafeInteger(quantity) ? quantity : null;
}
