import {
  parseCartCall,
  type CartActionResult,
} from "../../../shared/cart-tools";
import { cartVariantQuantity } from "./cart";
import { inspectProductPage } from "./product";

type SampleElement = HTMLElement & {
  cart?: unknown;
  shopifyCartLoading?: boolean;
  addToCartButton?: HTMLButtonElement | null;
};
const pendingSamples = new WeakSet<Element>();

export function inspectSampleProduct(productPath: string) {
  const path = parseCartCall("add_sample_to_cart", { productPath }).arguments
    .productPath as string;
  inspectProductPage(path);
  const components = document.querySelectorAll<SampleElement>(
    "app-provider > main#main dynamic-pricing-sample-option",
  );
  if (components.length !== 1)
    throw new Error(
      "This product has no unambiguous supported sample control. Use the storefront's sample options.",
    );
  const component = components[0];
  const definition = customElements.get("dynamic-pricing-sample-option");
  if (!definition || !(component instanceof definition))
    throw new Error(
      "The sample control is still initializing. Wait for the storefront to finish loading.",
    );
  const buttons = component.querySelectorAll<HTMLButtonElement>(
    'button[data-sample-btn][data-sample-variant-id][type="button"]',
  );
  if (buttons.length !== 1)
    throw new Error("The product's sample button is unavailable or ambiguous.");
  const button = buttons[0];
  if (component.addToCartButton !== button)
    throw new Error(
      "The sample control is still initializing. Wait for the storefront to finish loading.",
    );
  const variantId = button.dataset.sampleVariantId || "";
  const mainVariant = button.dataset.mainProductVariant || "";
  const selectedVariant = new URL(window.location.href).searchParams.get(
    "variant",
  );
  if (
    !/^\d+$/.test(variantId) ||
    variantId !== component.dataset.sampleId ||
    button.dataset.mainProductUrl !== path ||
    !/^\d+$/.test(mainVariant) ||
    (selectedVariant !== null && selectedVariant !== mainVariant)
  )
    throw new Error(
      "The sample control does not match the current product. Refresh its options before trying again.",
    );
  const title = document
    .querySelector("app-provider > main#main h1")
    ?.textContent?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!title)
    throw new Error("The current sample product could not be identified.");
  return {
    component,
    button,
    variantId,
    product: { productPath: path, title },
  };
}

/** Click the theme's separate sample control; never substitute the full blind. */
export async function addProductSample(
  productPath: string,
  signal: AbortSignal,
): Promise<CartActionResult> {
  signal.throwIfAborted();
  const { component, button, variantId, product } =
    inspectSampleProduct(productPath);
  if (pendingSamples.has(component))
    throw new Error("This sample is already being submitted.");
  const previousQuantity = cartVariantQuantity(component.cart, variantId);
  if (previousQuantity === null)
    throw new Error(
      "The sample's cart data is still loading. Wait for the storefront before trying again.",
    );
  if (previousQuantity > 0)
    return {
      status: "already_in_cart",
      message:
        "This product's sample is already in your cart. No duplicate was added.",
    };
  if (
    button.slot !== "add-sample-btn" ||
    button.assignedSlot?.name !== "add-sample-btn" ||
    !component.isConnected ||
    !button.getClientRects().length ||
    getComputedStyle(button).visibility === "hidden" ||
    component.shopifyCartLoading ||
    button.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]') ||
    button.closest('[hidden], [inert], [aria-hidden="true"], .hidden') ||
    document.querySelector(
      "[data-dynamic-pricing-form].adding, [data-dynamic-pricing-form].adding-sample",
    )
  )
    return {
      status: "needs_configuration",
      message:
        "The sample control is not ready. Check the storefront's sample availability before trying again.",
    };
  signal.throwIfAborted();
  pendingSamples.add(component);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("roman:navigation", onLeave);
      component.removeEventListener("cart:updated", onUpdated);
      component.removeEventListener("cart:error", onError);
      pendingSamples.delete(component);
    };
    const finish = (result: CartActionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onLeave = () =>
      finish({
        status: "handed_off",
        message:
          "The sample request was handed to the storefront, but completion was not confirmed. Check the cart before trying again.",
      });
    const onUpdated = (event: Event) => {
      if (event.target !== component || !component.isConnected) return;
      const quantity = cartVariantQuantity(
        (event as CustomEvent<unknown>).detail,
        variantId,
      );
      if (quantity !== null && quantity > previousQuantity)
        finish({
          status: "added",
          addedSample: product,
          message:
            "The storefront confirmed the sample was added to your cart.",
        });
    };
    const onError = (event: Event) => {
      if (event.target !== component || settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "The storefront could not confirm the sample addition. Check its message and cart before trying again.",
        ),
      );
    };
    const timer = window.setTimeout(onLeave, 15000);
    signal.addEventListener("abort", onLeave, { once: true });
    window.addEventListener("pagehide", onLeave, { once: true });
    document.addEventListener("roman:navigation", onLeave, { once: true });
    component.addEventListener("cart:updated", onUpdated);
    component.addEventListener("cart:error", onError);
    try {
      button.click();
    } catch {
      onLeave();
    }
  });
}
