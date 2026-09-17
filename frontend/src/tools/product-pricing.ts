import type { ProductMeasurements } from "../../../shared/product-configuration";
import {
  controlVisible,
  currentProductForm,
  isCurrentProduct,
} from "./product-controls";

type PriceOutcome = "ready" | "needs_configuration" | "uncertain";
type PricingElement = HTMLElement & {
  _instantPriceButton?: unknown;
  _addToCartButtons?: unknown;
  _features?: unknown;
};
// Recognize one native display amount without converting currency or decimals.
// Unknown combined discounts/prices stay unavailable rather than becoming a quote.
const displayedAmount =
  /^(?:[+\-−]\s*)?(?:(?:[A-Z]{0,3}\p{Sc}|[A-Z]{3})\s*(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:[., ]\d{3})+(?:[.,]\d{1,2})?)|(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:[., ]\d{3})+(?:[.,]\d{1,2})?)\s*(?:[A-Z]{0,3}\p{Sc}|[A-Z]{3}))$/u;

function displayedPrice(element: Element): string | null {
  if (element.querySelector(".text-error,[role=alert]")) return null;
  const sales = [...element.querySelectorAll(".sale-price")].filter(
    controlVisible,
  );
  if (
    sales.length > 1 ||
    (!sales.length && element.querySelector("s,del,.regular-price"))
  )
    return null;
  const value = (sales[0] ?? element).textContent?.replace(/\s+/gu, " ").trim();
  return value && value.length <= 120 && displayedAmount.test(value)
    ? value
    : null;
}

/** The theme's displayed configured price includes its own extras and discounts. */
export function readConfiguredProductPrice(
  form: HTMLFormElement,
  productPath: string,
  measurements: ProductMeasurements | null,
): string | null {
  try {
    const product = form.parentElement;
    const definition = customElements.get("dynamic-pricing");
    if (
      currentProductForm(productPath) !== form ||
      !product ||
      !definition ||
      !(product instanceof definition) ||
      !form.assignedSlot ||
      form.matches(
        ".loading,.adding,.adding-sample,.variant-loading,.blocking,.has-error",
      ) ||
      product.matches(".loading,.variant-loading,.blocking,.has-error") ||
      !form.checkValidity() ||
      !measurements?.unit ||
      measurements.width === null ||
      measurements.height === null ||
      !Number.isFinite(measurements.width) ||
      !Number.isFinite(measurements.height) ||
      measurements.width <= 0 ||
      measurements.height <= 0 ||
      (product.dataset.multistep === "true" &&
        ![
          ...product.querySelectorAll('[data-pdp-form-screen="post-price"]'),
        ].some(controlVisible))
    )
      return null;
    const prices = [...product.querySelectorAll("[data-dynamic-price]")].filter(
      (element) =>
        element.closest("dynamic-pricing") === product &&
        controlVisible(element),
    );
    if (!prices.length || prices.length > 4) return null;
    const values = prices.map(displayedPrice);
    return values[0] && values.every((value) => value === values[0])
      ? values[0]
      : null;
  } catch {
    return null;
  }
}

/** Native option labels are surcharges, separate from the displayed configured total. */
export function readProductOptionPrice(
  form: HTMLFormElement,
  control: HTMLInputElement | HTMLSelectElement,
  marker: string,
  configuredPrice: string | null,
): string | undefined {
  if (
    !configuredPrice ||
    !/^\d{1,12}##\d{1,12}$/.test(marker) ||
    control.form !== form
  )
    return;
  const product = form.parentElement as PricingElement;
  const [featureId, optionId] = marker.split("##");
  const features = product._features;
  if (!Array.isArray(features) || features.length > 160) return;
  const matching = features.filter(
    (feature) =>
      feature &&
      typeof feature === "object" &&
      String(feature.featureId) === featureId,
  );
  if (
    matching.length !== 1 ||
    !Array.isArray(matching[0].featureOptions) ||
    matching[0].featureOptions.length > 160
  )
    return;
  const options = matching[0].featureOptions.filter(
    (option: { featureOptionId?: unknown } | null) =>
      option && String(option.featureOptionId) === optionId,
  );
  const amount =
    options.length === 1 ? options[0].priceInfo?.retailPrice : undefined;
  // The theme does not clear old labels when the refreshed option price is zero.
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
    return;
  const fieldset = control.closest("fieldset[data-feature]");
  if (!fieldset) return;
  const labels = [
    ...form.querySelectorAll(`[data-second-label="${marker}"]`),
  ].filter(
    (element) =>
      element.closest("dynamic-pricing") === product &&
      element.closest("fieldset[data-feature]") === fieldset &&
      controlVisible(element),
  );
  if (!labels.length || labels.length > 4) return;
  const values = labels.map(displayedPrice);
  return values[0] && values.every((value) => value === values[0])
    ? values[0]
    : undefined;
}

/** Advance only the theme's verified quote submitter, never its cart submitter. */
export async function settleProductPrice(
  form: HTMLFormElement,
  productPath: string,
  signal: AbortSignal,
): Promise<PriceOutcome> {
  const product = form.parentElement as PricingElement | null;
  if (!product) return "needs_configuration";
  const multistep = product.dataset.multistep === "true";
  const definition = customElements.get("dynamic-pricing");
  if (!definition || !(product instanceof definition) || !form.assignedSlot)
    return "needs_configuration";
  const buttons = form.querySelectorAll<HTMLButtonElement>(
    'button[data-instant-price-button][type="submit"]',
  );
  if (
    multistep &&
    (buttons.length !== 1 ||
      buttons[0].form !== form ||
      buttons[0].hasAttribute("data-atc-button") ||
      product._instantPriceButton !== buttons[0] ||
      (Array.isArray(product._addToCartButtons) &&
        product._addToCartButtons.includes(buttons[0])))
  )
    return "needs_configuration";
  const button = buttons[0];
  const postPrice = () =>
    [...product.querySelectorAll('[data-pdp-form-screen="post-price"]')].some(
      controlVisible,
    );
  if (
    multistep &&
    !postPrice() &&
    (button.matches(':disabled,[aria-disabled="true"]') ||
      !controlVisible(button) ||
      !form.checkValidity())
  )
    return "needs_configuration";
  if (signal.aborted) return "uncertain";
  return new Promise((resolve) => {
    let settled = false,
      submitted = false;
    let debounceElapsed = false;
    const finish = (outcome: PriceOutcome) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      window.clearTimeout(debounce);
      signal.removeEventListener("abort", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("roman:navigation", onLeave);
      resolve(outcome);
    };
    const onLeave = () => finish("uncertain");
    const check = () => {
      if (
        !form.isConnected ||
        form.parentElement !== product ||
        !isCurrentProduct(productPath) ||
        signal.aborted
      )
        return finish("uncertain");
      // Theme input handling schedules pricing after 150 ms. Do not mistake the
      // brief gap before that request for a settled quote.
      if (
        !debounceElapsed ||
        form.matches(".loading,.adding,.adding-sample") ||
        product.classList.contains("loading")
      )
        return;
      if (form.classList.contains("blocking"))
        return finish("needs_configuration");
      if (
        (!multistep || postPrice()) &&
        !form.classList.contains("variant-loading")
      )
        finish("ready");
    };
    const observer = new MutationObserver(check);
    const timeout = window.setTimeout(onLeave, 15_000);
    const debounce = window.setTimeout(() => {
      debounceElapsed = true;
      check();
    }, 250);
    observer.observe(product, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    signal.addEventListener("abort", onLeave, { once: true });
    window.addEventListener("pagehide", onLeave, { once: true });
    document.addEventListener("roman:navigation", onLeave, { once: true });
    if (multistep && !postPrice()) {
      const guard = (event: SubmitEvent) => {
        if (event.target !== form) return;
        // The inspected theme handler always handles this event, including when
        // default is prevented. Block native navigation before it sees the event.
        event.preventDefault();
        if (event.submitter !== button) {
          event.stopImmediatePropagation();
          finish("uncertain");
          return;
        }
        submitted = true;
      };
      let failed = false;
      const onError = () => {
        failed = true;
      };
      form.addEventListener("submit", guard, true);
      window.addEventListener("error", onError);
      try {
        button.click();
      } catch {
        failed = true;
      } finally {
        form.removeEventListener("submit", guard, true);
        window.removeEventListener("error", onError);
      }
      if (failed) finish("uncertain");
      else if (!submitted || !postPrice()) finish("needs_configuration");
    }
    check();
  });
}
