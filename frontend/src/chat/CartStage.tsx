import { useEffect, useState, useSyncExternalStore } from "react";
import { parseCartResult, type CartSnapshot } from "../../../shared/cart-tools";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { getStoreCart, summarizeCart } from "../tools/cart";

type DisplayCart = Omit<CartSnapshot, "items"> & {
  items: (CartSnapshot["items"][number] & { imageUrl?: string })[];
};

/** Cart imagery is display-only and never changes tool/approval snapshots. */
function cartImageUrl(item: Record<string, unknown>): string | undefined {
  const featured = item.featured_image;
  const candidates = [
    featured && typeof featured === "object" && !Array.isArray(featured)
      ? (featured as Record<string, unknown>).url
      : undefined,
    item.image,
  ];
  for (const value of candidates) {
    if (typeof value !== "string" || !value || value.length > 2048) continue;
    try {
      const url = new URL(value, window.location.origin);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        ((url.origin === window.location.origin &&
          url.pathname.startsWith("/cdn/shop/")) ||
          (url.origin === "https://cdn.shopify.com" &&
            url.pathname.startsWith("/s/files/")))
      )
        return url.href;
    } catch {
      // Missing or unsupported imagery must not hide a valid cart line.
    }
  }
}

function CartImage({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="roman-cart-image" aria-hidden="true">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>Image unavailable</span>
      )}
    </div>
  );
}

/** Roman's Cart view reads Shopify without navigating the underlying theme. */
export function CartStage({
  navigation,
  session,
  visible,
}: {
  navigation: StorefrontNavigation;
  session: ConversationClient;
  visible: boolean;
}) {
  const page = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const requested = visible;
  const [cart, setCart] = useState<DisplayCart>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const cartChanging =
    requested &&
    (state.conversation?.tools.some(
      (tool) =>
        tool.status === "running" &&
        [
          "add_to_cart",
          "add_sample_to_cart",
          "remove_from_cart",
          "set_cart_quantity",
          "clear_cart",
        ].includes(tool.name),
    ) ??
      false);

  useEffect(() => {
    if (!requested) return;
    const refresh = () => setAttempt((value) => value + 1);
    // Capture also observes a theme's non-bubbling confirmation event. Never
    // trust its payload for display; read the visitor's canonical cart instead.
    document.addEventListener("cart:updated", refresh, true);
    return () => document.removeEventListener("cart:updated", refresh, true);
  }, [requested]);

  useEffect(() => {
    if (!requested) {
      setCart(undefined);
      setError(undefined);
      setLoading(true);
      return;
    }
    if (page.pending || cartChanging) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const timeout = window.setTimeout(
      () =>
        controller.abort(new Error("Cart request timed out. Please retry.")),
      10000,
    );
    let current = true;
    void getStoreCart(controller.signal)
      .then((value) => {
        const verified = parseCartResult("get_cart", summarizeCart(value));
        if (current && "items" in verified)
          setCart({
            ...verified,
            items: verified.items.map((item, index) => ({
              ...item,
              imageUrl: cartImageUrl(value.items[index]),
            })),
          });
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Your cart could not be loaded.",
          );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [requested, page.pending, cartChanging, attempt]);

  if (!requested) return null;
  const price = (minor: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cart!.currency,
    }).format(minor / 100);
  return (
    <aside
      className="roman-cart-stage"
      aria-label="Your Shopify cart"
      aria-busy={loading || page.pending || cartChanging}
    >
      <span className="roman-stage-eyebrow">Your selection</span>
      <h2>Your cart</h2>
      {loading || page.pending || cartChanging ? (
        <p role="status">Updating your cart…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry cart
          </button>
        </div>
      ) : (
        cart && (
          <>
            {cart.items.length ? (
              <ul className="roman-cart-items">
                {cart.items.map((item) => (
                  <li key={item.lineKey}>
                    <CartImage
                      key={item.imageUrl ?? "missing"}
                      url={item.imageUrl}
                    />
                    <h3>{item.title}</h3>
                    <div className="roman-cart-item-details">
                      <span>Quantity {item.quantity}</span>
                      <strong>{price(item.linePriceMinorUnits)}</strong>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Your cart is empty. Let’s find something you love.</p>
            )}
            {cart.items.length > 0 && (
              <div className="roman-cart-summary">
                <div className="roman-cart-total">
                  <span>Subtotal</span>
                  <strong>{price(cart.totalPriceMinorUnits)}</strong>
                </div>
                <a
                  className="roman-checkout"
                  href="/checkout"
                  data-roman-native-navigation
                >
                  Continue to checkout <span aria-hidden="true">↗</span>
                </a>
                <p className="roman-cart-note">
                  Checkout opens securely with the store.
                </p>
              </div>
            )}
          </>
        )
      )}
    </aside>
  );
}
