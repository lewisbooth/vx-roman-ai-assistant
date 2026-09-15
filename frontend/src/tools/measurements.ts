import type { MeasurementDraft } from "../../../shared/measurements";

const unavailable =
  "These measurements need the product's own controls. Open the matching product with the same mm or cm unit, then review its measurements and fitting option.";

function canonicalProductPath() {
  const match =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i.exec(
      window.location.pathname,
    );
  return match ? `/products/${match[1]}` : null;
}

function numericInput(group: Element, selector: string, value: number) {
  const inputs = group.querySelectorAll(selector);
  if (inputs.length !== 1 || !(inputs[0] instanceof HTMLInputElement))
    throw new Error(unavailable);
  const input = inputs[0];
  for (
    let element: Element | null = input;
    element;
    element = element.parentElement
  ) {
    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      throw new Error(unavailable);
  }
  if (
    input.type !== "number" ||
    input.disabled ||
    input.readOnly ||
    input.closest('[hidden],[inert],[aria-hidden="true"]')
  )
    throw new Error(unavailable);
  // Validate a detached native control first, so invalid dimensions never alter
  // a live field or trigger theme pricing. Shopify owns its limits and steps.
  const probe = input.cloneNode(false) as HTMLInputElement;
  probe.value = String(value);
  if (probe.valueAsNumber !== value || !probe.checkValidity())
    throw new Error(
      "The saved dimension does not match the product's allowed range or increments. Review it in the product controls.",
    );
  return input;
}

export function inspectMeasurementApplication(draft: MeasurementDraft) {
  if (
    draft.kind !== "order" ||
    !["mm", "cm"].includes(draft.unit) ||
    canonicalProductPath() !== draft.productPath ||
    !document.body.classList.contains("template-product") ||
    new URL(window.location.href).searchParams.has("line")
  )
    throw new Error(unavailable);
  const forms = document.querySelectorAll<HTMLFormElement>(
    "app-provider > main#main dynamic-pricing > form[data-dynamic-pricing-form]",
  );
  if (forms.length !== 1) throw new Error(unavailable);
  const form = forms[0];
  const components = form.querySelectorAll<HTMLElement>(
    "dynamic-pricing-measurements",
  );
  if (components.length !== 1) throw new Error(unavailable);
  const component = components[0];
  const definition = customElements.get(component.localName);
  if (
    !definition ||
    !(component instanceof definition) ||
    !component.isConnected ||
    !component.shadowRoot?.querySelector("slot") ||
    form.matches(".loading,.adding,.blocking,.variant-loading") ||
    form.closest("dynamic-pricing.loading")
  )
    throw new Error(unavailable);
  const units = component.querySelectorAll<HTMLSelectElement>(
    "select[data-measurement-select]",
  );
  const groups = component.querySelectorAll("[data-active-input-measurement]");
  if (
    units.length !== 1 ||
    units[0].disabled ||
    units[0].value !== draft.unit ||
    groups.length !== 1 ||
    groups[0].getAttribute("data-input-measurement-group") !== draft.unit
  )
    throw new Error(unavailable);
  const width = numericInput(groups[0], "[data-width-input]", draft.width);
  const height = numericInput(groups[0], "[data-drop-input]", draft.height);
  if (width.form !== form || height.form !== form) throw new Error(unavailable);
  const fingerprint = JSON.stringify([
    draft,
    window.location.pathname,
    units[0].value,
    ...[width, height].map((input) => [
      input.value,
      input.min,
      input.max,
      input.step,
    ]),
    ...[
      ...form.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked'),
    ].map((input) => [input.name, input.value]),
  ]);
  return {
    details: [
      `Width ${draft.width} ${draft.unit}; drop ${draft.height} ${draft.unit}.`,
      "These are your intended order dimensions. Only width and drop will change; check the product's fitting choice and recalculated price before adding it to your cart.",
    ],
    fingerprint,
    form,
    component,
    width,
    height,
  };
}

export type MeasurementApplicationContext = ReturnType<
  typeof inspectMeasurementApplication
>;

export function applyMeasurements(
  draft: MeasurementDraft,
  expected: MeasurementApplicationContext,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const current = inspectMeasurementApplication(draft);
  if (
    current.fingerprint !== expected.fingerprint ||
    current.form !== expected.form ||
    current.component !== expected.component ||
    current.width !== expected.width ||
    current.height !== expected.height
  )
    throw new Error(
      "The product or measurements changed after review. Review the new values before applying them.",
    );
  // Assign both values before either event, so the theme reads one coherent pair.
  current.width.value = String(draft.width);
  current.height.value = String(draft.height);
  for (const input of [current.width, current.height]) {
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  if (
    !current.form.isConnected ||
    !current.component.isConnected ||
    !current.width.isConnected ||
    !current.height.isConnected ||
    current.width.form !== current.form ||
    current.height.form !== current.form ||
    !current.component.contains(current.width) ||
    !current.component.contains(current.height) ||
    current.width.valueAsNumber !== draft.width ||
    current.height.valueAsNumber !== draft.height
  )
    return {
      status: "uncertain" as const,
      productPath: draft.productPath,
      draftUpdatedAt: draft.updatedAt,
      message:
        "The theme changed the entered values. Review the product controls and price before continuing; nothing was added to the cart.",
    };
  return {
    status: "applied" as const,
    productPath: draft.productPath,
    draftUpdatedAt: draft.updatedAt,
    message:
      "Width and drop were entered in the product controls. Wait for the theme's price and check its fitting choice. Nothing was added to the cart.",
  };
}
