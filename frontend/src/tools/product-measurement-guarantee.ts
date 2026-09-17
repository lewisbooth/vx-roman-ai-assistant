import { controlVisible } from "./product-controls";
import { displayedPrice } from "./product-pricing";

type GuaranteeElement = HTMLElement & {
  _insuranceOption?: unknown;
  _isInsuranceAutoApplied?: unknown;
  variantId?: unknown;
  cartHasInsurance?: unknown;
};
type PricingElement = HTMLElement & {
  _productLevelInsuranceOption?: unknown;
  _insuranceInputChangedByUser?: unknown;
  _isInsuranceAutoApplied?: unknown;
  productLevelInsuranceVariantId?: unknown;
};
export interface MeasurementGuarantee {
  form: HTMLFormElement;
  component: GuaranteeElement;
  pricing: PricingElement;
  hidden: HTMLInputElement;
  title: string;
  description: string;
  options: {
    input: HTMLInputElement;
    toggle: HTMLLabelElement;
    label: string;
    selected: boolean;
    priceLabel?: string;
  }[];
  elements: Element[];
  fingerprint: string;
}

function text(element: Element | undefined, limit: number) {
  const value = element?.textContent?.replace(/\s+/gu, " ").trim();
  return value && value.length <= limit ? value : undefined;
}
function one<T extends Element>(element: Element, selector: string) {
  const found = element.querySelectorAll<T>(selector);
  return found.length === 1 ? found[0] : undefined;
}

/** Only the shipped, initialized product guarantee; cart insurance stays separate. */
export function readMeasurementGuarantee(
  form: HTMLFormElement,
): MeasurementGuarantee | undefined {
  const component = one<GuaranteeElement>(form, "product-level-insurance"),
    hidden = one<HTMLInputElement>(form, "input[data-product-level-insurance]"),
    pricing = form.parentElement as PricingElement | null,
    definition = customElements.get("product-level-insurance");
  if (
    !component ||
    !hidden ||
    !pricing ||
    !definition ||
    !(component instanceof definition) ||
    !controlVisible(component) ||
    component.closest("dynamic-pricing") !== pricing ||
    hidden.form !== form ||
    hidden.type !== "hidden" ||
    hidden.name !== "properties[ProductLevelInsurance]" ||
    !["true", "false"].includes(hidden.value) ||
    component._insuranceOption !== hidden ||
    pricing._productLevelInsuranceOption !== hidden ||
    component._isInsuranceAutoApplied !== false ||
    pricing._isInsuranceAutoApplied !== false ||
    component.dataset.isInsuranceAutoApplied === "true" ||
    pricing.dataset.isInsuranceAutoApplied === "true" ||
    component.cartHasInsurance === "true"
  )
    return;
  const variant = component.getAttribute("variantid");
  if (
    !variant ||
    !/^\d{1,20}$/.test(variant) ||
    String(component.variantId) !== variant ||
    String(pricing.productLevelInsuranceVariantId) !== variant
  )
    return;
  const heading = one<HTMLElement>(component, '[slot="heading"]'),
    group = one<HTMLElement>(component, '[slot="options"]');
  if (
    !heading ||
    !group ||
    heading.assignedSlot?.name !== "heading" ||
    group.assignedSlot?.name !== "options" ||
    !controlVisible(group)
  )
    return;
  const title = text(one(heading, ":scope > p"), 160),
    toggles = [
      ...group.querySelectorAll<HTMLLabelElement>(
        "label[data-product-level-insurance-toggle]",
      ),
    ];
  if (!title || toggles.length !== 2) return;
  const options: MeasurementGuarantee["options"] = [];
  let description: string | undefined;
  for (const value of ["false", "true"]) {
    const matches = toggles.filter((toggle) => toggle.dataset.value === value);
    if (matches.length !== 1) return;
    const toggle = matches[0],
      input = one<HTMLInputElement>(toggle, "input[data-product-insurance]");
    if (
      !input ||
      input.type !== "radio" ||
      input.value !== value ||
      input.form !== form ||
      input.closest("product-level-insurance") !== component ||
      input.name !== `product_level_insurance_toggle_${variant}` ||
      input.labels?.length !== 1 ||
      input.labels[0] !== toggle ||
      input.matches(":disabled,[data-screen-disabled]") ||
      toggle.closest('[aria-disabled="true"]') ||
      !controlVisible(toggle)
    )
      return;
    const label = text(one(toggle, ".body-md-semibold"), 160);
    if (!label) return;
    let priceLabel: string | undefined;
    if (value === "true") {
      description = text(one(toggle, ".body-sm:not(.whitespace-nowrap)"), 1200);
      const price = one(toggle, ".body-sm.whitespace-nowrap");
      priceLabel =
        price && controlVisible(price)
          ? (displayedPrice(price) ?? undefined)
          : undefined;
      if (!description || !priceLabel) return;
    }
    options.push({
      input,
      toggle,
      label,
      selected: hidden.value === value,
      ...(priceLabel ? { priceLabel } : {}),
    });
  }
  const checked = options.filter(({ input }) => input.checked),
    active = options.filter(({ toggle }) => toggle.hasAttribute("active"));
  // Initial HTML can leave both radios unchecked, while the hidden value and
  // active label establish the native default. Never infer customer consent.
  if (
    checked.length > 1 ||
    checked.some(({ input }) => input.value !== hidden.value) ||
    active.length !== 1 ||
    active[0].input.value !== hidden.value
  )
    return;
  return {
    form,
    component,
    pricing,
    hidden,
    title,
    description: description!,
    options,
    elements: [component, hidden, heading, group, ...toggles],
    fingerprint: JSON.stringify([
      variant,
      hidden.value,
      pricing._insuranceInputChangedByUser,
      options.map(({ input, toggle }) => [
        input.checked,
        toggle.hasAttribute("active"),
      ]),
    ]),
  };
}

/** A real native click records an explicit choice and updates both theme owners. */
export function selectMeasurementGuarantee(
  binding: MeasurementGuarantee,
  input: HTMLInputElement,
) {
  if (!binding.options.some((option) => option.input === input))
    throw new Error("The measurement guarantee controls changed.");
  let failed = false;
  const onError = () => {
    failed = true;
  };
  window.addEventListener("error", onError);
  try {
    input.click();
  } finally {
    window.removeEventListener("error", onError);
  }
  if (failed)
    throw new Error(
      "The theme failed while selecting the measurement guarantee.",
    );
}

export function measurementGuaranteeSelected(
  binding: MeasurementGuarantee,
  input: HTMLInputElement,
) {
  return (
    binding.pricing._insuranceInputChangedByUser === true &&
    binding.component._insuranceOption === binding.hidden &&
    binding.pricing._productLevelInsuranceOption === binding.hidden &&
    binding.hidden.value === input.value &&
    input.checked &&
    binding.options.every(
      (option) =>
        option.toggle.hasAttribute("active") === (option.input === input) &&
        option.input.checked === (option.input === input),
    )
  );
}
