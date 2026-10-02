import { parseCheckoutCall } from "../../../shared/checkout";
import { openCheckout } from "./checkout";
import type { StorefrontNavigation } from "../navigation/shared";
import { selectStore } from "../navigation/themes";
import { getCart } from "./cart";
import { clearCart, removeFromCart, setCartQuantity } from "./cart-actions";
import { getProduct, lookupCatalog, searchProducts } from "./catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import { addConfiguredProduct } from "./product";
import { addProductSample } from "./product-sample";
import { createProductConfigurationTools } from "./product-configuration";
import { parseProductConfigurationCall } from "../../../shared/product-configuration";
import { getProductGuides } from "./product-guides";
import { discoverGuides } from "./guide-library";
import { getStoreSupport } from "./store-support";
import { parseGuideLibraryCall } from "../../../shared/guide-library";
import { parseStoreSupportCall } from "../../../shared/store-support";
import { parseProductGuidesCall } from "../../../shared/product-guides";
import {
  parseViewCall,
  type AssistantView,
} from "../../../shared/assistant-view";
import {
  parseMeasurementCall,
  type MeasurementToolResult,
} from "../../../shared/measurements";

export type MeasurementAccess = (
  name: "set_measurements" | "get_measurements",
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<MeasurementToolResult>;

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
  accessMeasurements?: MeasurementAccess,
  showView?: (view: AssistantView) => Promise<void>,
) {
  let active: AbortController | undefined;
  let disposed = false;
  const productConfiguration = createProductConfigurationTools();

  function productPath() {
    const path = new URL(navigation.getSnapshot().url).pathname;
    const match =
      /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i.exec(
        path,
      );
    if (!match) throw new Error("Open a product before using this tool.");
    return `/products/${match[1]}`;
  }

  return {
    async execute(
      name: string,
      input: unknown,
      signal?: AbortSignal,
      options?: { navigationSource?: "model" },
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
        name === "navigate" || name === "search_products"
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
              "get_product_guides",
              "discover_guides",
              "get_store_support",
              "get_cart",
              "add_to_cart",
              "add_sample_to_cart",
              "get_product_configuration",
              "configure_product",
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
            case "open_checkout": {
              parseCheckoutCall(input);
              if (!showView)
                throw new Error("Roman's Cart view is unavailable.");
              await showView("cart");
              request.signal.throwIfAborted();
              return openCheckout();
            }
            case "show_view": {
              const { view } = parseViewCall(input);
              if (!showView)
                throw new Error("Roman's view navigation is unavailable.");
              await showView(view);
              return { status: "shown", view };
            }
            case "discover_guides": {
              const call = parseGuideLibraryCall(input);
              return discoverGuides(call.library, request.signal);
            }
            case "get_store_support":
              parseStoreSupportCall(input);
              return getStoreSupport(request.signal);
            case "search_products": {
              const { arguments: args } = parseCatalogCall(name, input);
              return searchProducts(
                args.queries as string[],
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
            case "get_product_guides": {
              const args = argumentsObject(input, ["productPath"]);
              const call = parseProductGuidesCall({
                productPath: args.productPath ?? productPath(),
              });
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before reading product guides.",
                );
              const guides = await getProductGuides(
                call.productPath,
                request.signal,
              );
              // Both DOM reads share this operation's guard and cancellation.
              // No second executor admission or PDF fetch is needed.
              const configuration =
                productConfiguration.getProductConfiguration(
                  call.productPath,
                  request.signal,
                );
              request.signal.throwIfAborted();
              return { ...guides, configuration };
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
            case "add_sample_to_cart": {
              const args = argumentsObject(input, ["productPath"]);
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before adding a sample.",
                );
              return addProductSample(
                args.productPath === undefined
                  ? productPath()
                  : textArgument(args, "productPath", 2048),
                request.signal,
              );
            }
            case "get_product_configuration":
            case "configure_product": {
              const args = argumentsObject(
                input,
                name === "get_product_configuration"
                  ? ["productPath"]
                  : ["productPath", "configurationId", "controlId", "optionId"],
              );
              const call = parseProductConfigurationCall(name, {
                ...args,
                productPath: args.productPath ?? productPath(),
              });
              if (navigation.getSnapshot().pending)
                throw new Error(
                  "Wait for storefront navigation to finish before using product controls.",
                );
              return call.name === "get_product_configuration"
                ? productConfiguration.getProductConfiguration(
                    call.arguments.productPath,
                    request.signal,
                  )
                : productConfiguration.configureProduct(
                    call.arguments,
                    request.signal,
                  );
            }
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
              const args = argumentsObject(input, [
                "width",
                "height",
                "unit",
                "kind",
                "mount",
              ]);
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
              const call = parseMeasurementCall(name, {
                productPath: path,
                width,
                height,
                unit,
                kind: args.kind ?? "window",
                mount: args.mount ?? "unknown",
              });
              if (!accessMeasurements)
                throw new Error(
                  "Measurement storage requires a Roman conversation connection.",
                );
              return accessMeasurements(name, call.arguments, request.signal);
            }
            case "get_measurements": {
              argumentsObject(input, []);
              const path = productPath();
              const call = parseMeasurementCall(name, { productPath: path });
              if (!accessMeasurements)
                throw new Error(
                  "Measurement storage requires a Roman conversation connection.",
                );
              return accessMeasurements(name, call.arguments, request.signal);
            }
            case "navigate": {
              const args = argumentsObject(input, ["path"]);
              const path = textArgument(args, "path", 2048);
              const status = await navigation.navigate(
                path,
                request.signal,
                options?.navigationSource === "model"
                  ? { source: "model" }
                  : undefined,
              );
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
            "add_sample_to_cart",
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
      productConfiguration.dispose();
    },
  };
}

export type AssistantTools = ReturnType<typeof createAssistantTools>;
