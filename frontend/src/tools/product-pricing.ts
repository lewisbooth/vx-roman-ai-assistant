import { controlVisible, isCurrentProduct } from "./product-controls";

type PriceOutcome = "ready" | "needs_configuration" | "uncertain";
type PricingElement = HTMLElement & {
  _instantPriceButton?: unknown;
  _addToCartButtons?: unknown;
};

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
