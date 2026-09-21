import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { parseCartResult, type CartSnapshot } from "../../../shared/cart-tools";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { getStoreCart, summarizeCart } from "../tools/cart";
import {
  cartLineConfiguration,
  type CartConfiguration,
} from "../tools/cart-configuration";

type DisplayCart = Omit<CartSnapshot, "items"> & {
  items: (CartSnapshot["items"][number] & {
    imageUrl?: string;
    configuration: CartConfiguration;
  })[];
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

const cartMutations = new Set([
  "add_to_cart",
  "add_sample_to_cart",
  "remove_from_cart",
  "set_cart_quantity",
  "clear_cart",
]);

/** One display read owner for Roman's cart display and navigation count. */
export function useCart(
  navigation: StorefrontNavigation,
  session: ConversationClient,
) {
  const page = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [open, setOpen] = useState(() =>
    document.documentElement.hasAttribute("data-roman-open"),
  );
  const [cart, setCart] = useState<DisplayCart>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const settledRevision = useRef(-1);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const changing =
    state.conversation?.tools.some(
      (tool) => tool.status === "running" && cartMutations.has(tool.name),
    ) ?? false;
  const wasChanging = useRef(changing);

  useEffect(() => {
    const observeOpen = () => {
      const next = document.documentElement.hasAttribute("data-roman-open");
      setOpen(next);
      if (next) retry();
    };
    const observer = new MutationObserver(observeOpen);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-roman-open"],
    });
    // Capture also observes native non-bubbling cart confirmations. Payloads
    // are not trusted: both cards and badge use the same canonical cart read.
    document.addEventListener("cart:updated", retry, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("cart:updated", retry, true);
    };
  }, [retry]);

  useEffect(() => {
    if (
      wasChanging.current &&
      !changing &&
      settledRevision.current === revision
    )
      retry();
    wasChanging.current = changing;
  }, [changing, revision, retry]);

  useEffect(() => {
    if (
      !open ||
      page.pending ||
      changing ||
      settledRevision.current === revision
    )
      return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const timeout = window.setTimeout(
      () =>
        controller.abort(new Error("Cart request timed out. Please retry.")),
      10000,
    );
    let current = true;
    // A discarded StrictMode setup must not enqueue a duplicate cart read.
    void Promise.resolve().then(async () => {
      if (!current) return;
      try {
        const value = await getStoreCart(controller.signal);
        const verified = parseCartResult("get_cart", summarizeCart(value));
        if (current && "items" in verified) {
          settledRevision.current = revision;
          setCart({
            ...verified,
            items: verified.items.map((item, index) => ({
              ...item,
              imageUrl: cartImageUrl(value.items[index]),
              configuration: cartLineConfiguration(value.items[index]),
            })),
          });
        }
      } catch (cause) {
        if (current) {
          settledRevision.current = revision;
          setError(
            cause instanceof Error
              ? cause.message
              : "Your cart could not be loaded.",
          );
        }
      } finally {
        window.clearTimeout(timeout);
        if (current) setLoading(false);
      }
    });
    return () => {
      current = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, page.pending, changing, revision]);

  return { cart, error, loading: loading || page.pending || changing, retry };
}

export type CartDisplayState = ReturnType<typeof useCart>;
