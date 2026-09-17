import { useEffect, useState, useSyncExternalStore } from "react";
import { parseCartResult, type CartSnapshot } from "../../../shared/cart-tools";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { getCart } from "../tools/cart";

/** A cart is visible only after an explicit cart navigation, never on addition. */
export function CartStage({
  navigation,
  session,
}: {
  navigation: StorefrontNavigation;
  session: ConversationClient;
}) {
  const page = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const requested = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/i.test(
    new URL(page.url, window.location.origin).pathname,
  );
  const [cart, setCart] = useState<CartSnapshot>();
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
    void getCart(controller.signal)
      .then((value) => {
        const verified = parseCartResult("get_cart", value);
        if (current && "items" in verified) setCart(verified);
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
              <ul>
                {cart.items.map((item) => (
                  <li key={item.lineKey}>
                    <h3>{item.title}</h3>
                    <span>Quantity {item.quantity}</span>
                    <strong>{price(item.linePriceMinorUnits)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Your cart is empty. Let’s find something you love.</p>
            )}
            {cart.items.length > 0 && (
              <>
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
              </>
            )}
          </>
        )
      )}
    </aside>
  );
}
