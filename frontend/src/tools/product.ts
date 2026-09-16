import {
  parseCartCall,
  type CartAddedProduct,
} from "../../../shared/cart-tools";

type PricingElement = HTMLElement & { variantId?: unknown; cart?: unknown };
type ProductActionResult = {
  status: "added" | "needs_configuration" | "handed_off";
  message: string;
  quantityAdded?: number;
  addedProduct?: CartAddedProduct;
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

export function inspectConfiguredProduct(productPath?: string) {
  if (
    productPath !== undefined &&
    window.location.pathname.replace(/\/$/, "") !== productPath
  )
    throw new Error(
      "Open the requested product and configure it before adding to cart.",
    );
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
  return forms[0];
}

function submittedMeasurements(
  form: HTMLFormElement,
): CartAddedProduct["measurements"] {
  const components = form.querySelectorAll("dynamic-pricing-measurements");
  if (components.length !== 1) return;
  const units = components[0].querySelectorAll<HTMLSelectElement>(
    "select[data-measurement-select]",
  );
  const groups = components[0].querySelectorAll(
    "[data-active-input-measurement]",
  );
  if (
    units.length !== 1 ||
    units[0].disabled ||
    units[0].form !== form ||
    groups.length !== 1 ||
    groups[0].getAttribute("data-input-measurement-group") !== units[0].value
  )
    return;
  const selectedUnit = units[0].value;
  if (!["mm", "cm", "in", "inches"].includes(selectedUnit)) return;
  const unit = selectedUnit === "inches" ? "in" : selectedUnit;
  function value(selector: string) {
    const fields = groups[0].querySelectorAll(selector);
    if (fields.length !== 1) return;
    const input = fields[0];
    if (
      !(
        input instanceof HTMLSelectElement ||
        (input instanceof HTMLInputElement && input.type === "number")
      ) ||
      input.disabled ||
      input.form !== form ||
      !input.value.trim()
    )
      return;
    const number = Number(input.value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  }
  function dimension(axis: "width" | "drop") {
    const whole = value(`[data-${axis}-input]`);
    if (whole === undefined) return;
    if (unit !== "in") return whole;
    const fraction = value(`[data-${axis}-inches-input]`);
    // The theme represents inches as a whole-number select and eighths.
    if (
      !Number.isSafeInteger(whole) ||
      fraction === undefined ||
      fraction >= 1 ||
      !Number.isInteger(fraction * 8)
    )
      return;
    return whole + fraction;
  }
  const width = dimension("width");
  const height = dimension("drop");
  if (
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    width > Number.MAX_SAFE_INTEGER ||
    height > Number.MAX_SAFE_INTEGER
  )
    return;
  return { width, height, unit: unit as "mm" | "cm" | "in" };
}

function submittedProduct(form: HTMLFormElement): CartAddedProduct | undefined {
  const title = document
    .querySelector("app-provider > main#main h1")
    ?.textContent?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  if (!title) return;
  let productPath: string;
  try {
    productPath = parseCartCall("add_to_cart", {
      productPath: window.location.pathname,
    }).arguments.productPath as string;
  } catch {
    // An unsupported URL cannot supply trustworthy product context.
    return;
  }
  const measurements = submittedMeasurements(form);
  return { productPath, title, ...(measurements ? { measurements } : {}) };
}

export async function addConfiguredProduct(
  signal: AbortSignal,
): Promise<ProductActionResult> {
  signal.throwIfAborted();
  const form = inspectConfiguredProduct();
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
    let captured = false;
    let addedProduct: CartAddedProduct | undefined;
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
      form.removeEventListener("submit", captureSubmission, true);
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
    const captureSubmission = (event: SubmitEvent) => {
      if (event.target !== form || captured) return;
      captured = true;
      // Snapshot the fields before the theme's slot handler submits them.
      // Later edits or pricing updates must not rewrite the recorded add.
      addedProduct = submittedProduct(form);
    };
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
        !captured ||
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
          ...(addedProduct ? { addedProduct } : {}),
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
    form.addEventListener("submit", captureSubmission, true);
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
