type PricingElement = HTMLElement & { variantId?: unknown; cart?: unknown };
type ProductActionResult = {
  status: "added" | "needs_configuration" | "handed_off";
  message: string;
  quantityAdded?: number;
};

const pendingProducts = new WeakSet<Element>();

function variantQuantity(cart: unknown, variantId: string): number | null {
  if (!cart || typeof cart !== "object") return null;
  const items = (cart as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  let quantity = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const record = item as { variant_id?: unknown; quantity?: unknown };
    if (
      typeof record.quantity !== "number" ||
      !Number.isSafeInteger(record.quantity) ||
      record.quantity < 0
    )
      return null;
    if (String(record.variant_id) === variantId) quantity += record.quantity;
  }
  return Number.isSafeInteger(quantity) ? quantity : null;
}

export async function addConfiguredProduct(
  signal: AbortSignal,
): Promise<ProductActionResult> {
  signal.throwIfAborted();
  if (!document.body.classList.contains("template-product"))
    throw new Error(
      "Open and configure a product before adding it to the cart.",
    );
  if (new URL(window.location.href).searchParams.has("line"))
    throw new Error(
      "This page is editing an existing cart item. Finish that edit in the storefront first.",
    );

  const forms = document.querySelectorAll<HTMLFormElement>(
    "app-provider > main#main dynamic-pricing > form[data-dynamic-pricing-form]",
  );
  if (forms.length !== 1)
    throw new Error(
      "The current product has no unambiguous supported purchase form.",
    );
  const form = forms[0];
  const product = form.parentElement as PricingElement;
  const definition = customElements.get("dynamic-pricing");
  if (!definition || !(product instanceof definition) || !form.assignedSlot)
    throw new Error(
      "The product configuration is still initializing. Wait for the storefront to finish loading.",
    );
  if (pendingProducts.has(product))
    throw new Error("This product is already being submitted.");
  const buttons = form.querySelectorAll<HTMLButtonElement>(
    'button[data-price-box-atc][data-atc-button][type="submit"]',
  );
  if (buttons.length !== 1 || buttons[0].form !== form)
    throw new Error(
      "The theme's configured-product submit button is unavailable.",
    );
  const button = buttons[0];
  const needsConfiguration: ProductActionResult = {
    status: "needs_configuration",
    message:
      "Complete the product options and measurements, wait for its price, then add it again.",
  };
  if (
    button.matches(':disabled, [aria-disabled="true"]') ||
    button.closest('[hidden], [inert], [aria-hidden="true"], .hidden') ||
    form.matches(
      ".loading, .adding, .blocking, .adding-sample, .variant-loading",
    ) ||
    product.classList.contains("loading")
  )
    return needsConfiguration;
  if (!form.reportValidity()) return needsConfiguration;
  signal.throwIfAborted();

  const variantId = String(product.variantId ?? "");
  const previousQuantity = /^\d+$/.test(variantId)
    ? variantQuantity(product.cart, variantId)
    : null;
  pendingProducts.add(product);

  return new Promise((resolve, reject) => {
    let settled = false;
    let submitted = false;
    const handedOff: ProductActionResult = {
      status: "handed_off",
      message:
        "The request was handed to the storefront, but completion was not confirmed. Check the cart before trying again.",
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("roman:navigation", onLeave);
      document.removeEventListener("submit", onSubmit);
      product.removeEventListener("cart:updated", onCartUpdated);
      product.removeEventListener("cart:error", onCartError);
      pendingProducts.delete(product);
    };
    const finish = (result: ProductActionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onLeave = () => finish(handedOff);
    const onSubmit = (event: SubmitEvent) => {
      if (event.target !== form) return;
      submitted = true;
      // The theme handles this event on the form's assigned slot. Never allow
      // an unhandled form submission to turn this action into native navigation.
      if (!event.defaultPrevented) {
        event.preventDefault();
        finish({
          status: "needs_configuration",
          message:
            "The theme did not accept the product submission. Use its product controls before trying again.",
        });
      }
    };
    const onCartUpdated = (event: Event) => {
      if (
        event.target !== product ||
        !product.isConnected ||
        previousQuantity === null
      )
        return;
      const quantity = variantQuantity(
        (event as CustomEvent<unknown>).detail,
        variantId,
      );
      if (quantity !== null && quantity > previousQuantity) {
        finish({
          status: "added",
          quantityAdded: quantity - previousQuantity,
          message:
            "The storefront confirmed the configured product was added to the cart.",
        });
      }
    };
    const onCartError = (event: Event) => {
      if (event.target !== product || settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "The storefront could not add the product. Check its error message and cart before trying again.",
        ),
      );
    };
    const timer = window.setTimeout(onLeave, 15000);
    signal.addEventListener("abort", onLeave, { once: true });
    window.addEventListener("pagehide", onLeave, { once: true });
    document.addEventListener("roman:navigation", onLeave, { once: true });
    document.addEventListener("submit", onSubmit);
    product.addEventListener("cart:updated", onCartUpdated);
    product.addEventListener("cart:error", onCartError);
    try {
      // Clicking preserves native constraint validation and the exact submitter
      // the theme uses to distinguish pricing from a configured-product add.
      button.click();
      if (!submitted && !settled) finish(needsConfiguration);
    } catch {
      finish(handedOff);
    }
  });
}
