import type { StorefrontNavigation } from "../navigation/shared";
import { selectStore } from "../navigation/themes";
import { getCart } from "./cart";
import { clearCart, removeFromCart, setCartQuantity } from "./cart-actions";
import { getProduct, lookupCatalog, searchProducts } from "./catalog";
import { addConfiguredProduct } from "./product";

export const toolDefinitions = [
  {
    name: "search_products",
    description: "Search this store's live product catalogue.",
    example: { query: "blackout blinds" },
  },
  {
    name: "get_product",
    description: "Look up a product using an ID returned by search.",
    example: { id: "" },
  },
  {
    name: "lookup_catalog",
    description: "Look up 1–10 product or variant IDs returned by the catalog.",
    example: { ids: [""] },
  },
  {
    name: "get_cart",
    description: "Read this browser's real Shopify cart.",
    example: {},
  },
  {
    name: "add_to_cart",
    description:
      "Submit the current product through the theme's configuration and validation. This can change your real cart.",
    example: {},
    actionLabel: "Add configured product to cart",
  },
  {
    name: "remove_from_cart",
    description:
      "Remove a cart line through the theme, preserving its linked-item rules. Copy lineKey from get_cart. Open Cart if its controls are unavailable.",
    example: { lineKey: "" },
    actionLabel: "Remove item from cart",
  },
  {
    name: "set_cart_quantity",
    description:
      "Set a cart line's positive whole-number quantity through the theme. Copy lineKey from get_cart. Linked items follow the theme's rules.",
    example: { lineKey: "", quantity: 2 },
    actionLabel: "Change cart quantity",
  },
  {
    name: "clear_cart",
    description:
      "Empty this browser's real cart through the theme. Open Cart if its controls are unavailable.",
    example: {},
    actionLabel: "Clear entire cart",
  },
  {
    name: "set_measurements",
    description:
      "Save a measurement draft for this product in Roman memory. This does not change the product configuration or cart.",
    example: { width: 100, height: 150, unit: "cm" },
  },
  {
    name: "get_measurements",
    description: "Read Roman's measurement draft for the current product.",
    example: {},
  },
  {
    name: "navigate",
    description: "Open any path on the current storefront.",
    example: { path: "/" },
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];
type Measurement = {
  productPath: string;
  width: number;
  height: number;
  unit: "mm" | "cm" | "in";
};

function argumentsObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new Error(
      `Expected an object containing only: ${keys.join(", ") || "no arguments"}.`,
    );
  return input as Record<string, unknown>;
}

function textArgument(
  input: Record<string, unknown>,
  key: string,
  maxLength = 500,
): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(
      `${key} must be a non-empty string of at most ${maxLength} characters.`,
    );
  return value.trim();
}

export function createAssistantTools(
  host: HTMLElement,
  navigation: StorefrontNavigation,
) {
  const measurements = new Map<string, Measurement>();
  let active: AbortController | undefined;
  let disposed = false;

  function productPath() {
    const path = new URL(navigation.getSnapshot().url).pathname;
    const match = /^(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/.exec(
      path,
    );
    if (!match)
      throw new Error("Open a product before using measurement tools.");
    return `/products/${match[1]}`;
  }

  return {
    async execute(
      name: string,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (disposed) throw new Error("Roman tools have been disposed.");
      signal?.throwIfAborted();
      if (active) throw new Error("Another tool is still running.");
      if (!selectStore(host.dataset.shop))
        throw new Error("Roman tools are not configured for this storefront.");
      const request = new AbortController();
      active = request;
      const abort = () => request.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      // The navigator owns its request deadlines and cancellation.
      const timer =
        name === "navigate"
          ? undefined
          : window.setTimeout(
              () =>
                request.abort(
                  new Error(
                    "The tool timed out. Check the storefront before retrying a cart action.",
                  ),
                ),
              20000,
            );
      try {
        const result = await (async () => {
          if (
            [
              "search_products",
              "get_product",
              "lookup_catalog",
              "get_cart",
              "add_to_cart",
              "remove_from_cart",
              "set_cart_quantity",
              "clear_cart",
            ].includes(name) &&
            ["localhost", "127.0.0.1", "[::1]"].includes(
              window.location.hostname,
            )
          )
            throw new Error(
              "Live Shopify tools run on the installed storefront. The local preview has no Shopify session.",
            );
          switch (name) {
            case "search_products": {
              const args = argumentsObject(input, ["query"]);
              return searchProducts(
                textArgument(args, "query"),
                request.signal,
                host.dataset.agentProfileUrl,
              );
            }
            case "get_product": {
              const args = argumentsObject(input, ["id"]);
              return getProduct(
                textArgument(args, "id"),
                request.signal,
                host.dataset.agentProfileUrl,
              );
            }
            case "lookup_catalog": {
              const args = argumentsObject(input, ["ids"]);
              if (
                !Array.isArray(args.ids) ||
                !args.ids.every((id) => typeof id === "string")
              )
                throw new Error(
                  "Provide ids as an array of product or variant IDs.",
                );
              return lookupCatalog(
                args.ids,
                request.signal,
                host.dataset.agentProfileUrl,
              );
            }
            case "get_cart":
              argumentsObject(input, []);
              return getCart(request.signal);
            case "add_to_cart":
              argumentsObject(input, []);
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before adding a product.",
                );
              return addConfiguredProduct(request.signal);
            case "remove_from_cart": {
              const args = argumentsObject(input, ["lineKey"]);
              const lineKey = textArgument(args, "lineKey");
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before changing the cart.",
                );
              return removeFromCart(lineKey, request.signal);
            }
            case "set_cart_quantity": {
              const args = argumentsObject(input, ["lineKey", "quantity"]);
              const lineKey = textArgument(args, "lineKey");
              if (
                typeof args.quantity !== "number" ||
                !Number.isSafeInteger(args.quantity) ||
                args.quantity < 1
              )
                throw new Error(
                  "Provide a positive whole-number quantity. Use remove_from_cart to remove an item.",
                );
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before changing the cart.",
                );
              return setCartQuantity(lineKey, args.quantity, request.signal);
            }
            case "clear_cart":
              argumentsObject(input, []);
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before changing the cart.",
                );
              return clearCart(request.signal);
            case "set_measurements": {
              const args = argumentsObject(input, ["width", "height", "unit"]);
              const { width, height, unit } = args;
              if (
                typeof width !== "number" ||
                !Number.isFinite(width) ||
                width <= 0 ||
                typeof height !== "number" ||
                !Number.isFinite(height) ||
                height <= 0 ||
                (unit !== "mm" && unit !== "cm" && unit !== "in")
              )
                throw new Error(
                  "Provide positive numeric width and height and a unit of mm, cm or in.",
                );
              const path = productPath();
              if (!measurements.has(path) && measurements.size >= 20)
                throw new Error(
                  "Roman can hold 20 product measurement drafts per session. Refresh to start again.",
                );
              const draft: Measurement = {
                productPath: path,
                width,
                height,
                unit,
              };
              measurements.set(path, draft);
              return {
                status: "draft_saved",
                appliedToProduct: false,
                ...draft,
              };
            }
            case "get_measurements": {
              argumentsObject(input, []);
              const path = productPath();
              return {
                status: "draft",
                measurement: measurements.get(path)
                  ? { ...measurements.get(path)! }
                  : null,
              };
            }
            case "navigate": {
              const args = argumentsObject(input, ["path"]);
              const path = textArgument(args, "path", 2048);
              const status = await navigation.navigate(path, request.signal);
              const state = navigation.getSnapshot();
              if (state.error) throw new Error(state.error);
              return { status, url: state.url, pending: state.pending };
            }
            default:
              throw new Error(`Unknown Roman tool: ${name}.`);
          }
        })();
        // A theme request already submitted cannot be undone by aborting Roman.
        // Preserve that explicit outcome; reads and pre-submission work abort.
        const handedOff =
          [
            "add_to_cart",
            "remove_from_cart",
            "set_cart_quantity",
            "clear_cart",
          ].includes(name) &&
          result !== null &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "handed_off";
        if (!handedOff) request.signal.throwIfAborted();
        return result;
      } catch (error) {
        throw request.signal.aborted ? request.signal.reason : error;
      } finally {
        signal?.removeEventListener("abort", abort);
        window.clearTimeout(timer);
        if (active === request) active = undefined;
      }
    },
    dispose() {
      disposed = true;
      active?.abort(new DOMException("Roman was removed.", "AbortError"));
      measurements.clear();
    },
  };
}

export type AssistantTools = ReturnType<typeof createAssistantTools>;
