export function isCurrentProduct(productPath: string): boolean {
  const match =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i.exec(
      window.location.pathname,
    );
  return (
    !!match &&
    `/products/${match[1]}` === productPath &&
    document.body.classList.contains("template-product") &&
    !new URL(window.location.href).searchParams.has("line")
  );
}

/** The theme's configured-product form is separate from samples and cart forms. */
export function currentProductForm(productPath: string): HTMLFormElement {
  if (!isCurrentProduct(productPath))
    throw new Error("Open the matching product page before configuring it.");
  const forms = document.querySelectorAll<HTMLFormElement>(
    "app-provider > main#main dynamic-pricing > form[data-dynamic-pricing-form]",
  );
  if (
    forms.length !== 1 ||
    // variant-loading persists until the first price; blocking marks invalid
    // configuration. Both still allow the customer to edit enabled controls.
    forms[0].matches(".loading,.adding,.adding-sample") ||
    forms[0].closest("dynamic-pricing.loading")
  )
    throw new Error(
      "Wait for the product controls and price to finish updating.",
    );
  return forms[0];
}

export function controlVisible(element: Element): boolean {
  if (
    !element.isConnected ||
    element.closest('[hidden],[inert],[aria-hidden="true"]')
  )
    return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
  }
  return true;
}

export function notifyProductControl(control: Element) {
  let failed = false;
  const onError = () => {
    failed = true;
  };
  window.addEventListener("error", onError);
  try {
    control.dispatchEvent(
      new Event("input", { bubbles: true, composed: true }),
    );
    if (!failed)
      control.dispatchEvent(
        new Event("change", { bubbles: true, composed: true }),
      );
  } finally {
    window.removeEventListener("error", onError);
  }
  if (failed)
    throw new Error("The theme failed while updating the product controls.");
}
