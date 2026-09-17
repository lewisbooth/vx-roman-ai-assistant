import {
  parseProductConfigurationCall,
  parseProductConfigurationResult,
  type ConfigureProductResult,
  type ProductConfiguration,
  type ProductConfigurationCall,
  type ProductConfigurationControl,
} from "../../../shared/product-configuration";
import { readProductMeasurements } from "./measurements";
import { isSampleAvailable } from "./product-sample";
import {
  readConfiguredProductPrice,
  readProductOptionPrice,
  settleProductPrice,
} from "./product-pricing";
import {
  controlVisible,
  currentProductForm,
  isCurrentProduct,
  notifyProductControl,
} from "./product-controls";

type NativeControl = HTMLInputElement | HTMLSelectElement;
type Choice = { control: NativeControl; value: string; checked?: boolean };
type Inspection = {
  form: HTMLFormElement;
  controls: ProductConfigurationControl[];
  choices: Choice[][];
  elements: Element[];
  fingerprint: string;
  measurements: ProductConfiguration["measurements"];
  configuredPrice: string | null;
};
const unavailable =
  "Only the current product's supported native choices can be changed. Finish any required product-page steps, then read its configuration again.";

function label(value: string) {
  const result = value.replace(/\s+/gu, " ").trim();
  if (!result || result.length > 160) throw new Error(unavailable);
  return result;
}
function available(control: NativeControl) {
  return (
    !control.matches(":disabled") &&
    !control.hasAttribute("data-screen-disabled") &&
    !control.closest('[aria-disabled="true"]') &&
    controlVisible(control)
  );
}

function inspect(productPath: string): Inspection {
  const form = currentProductForm(productPath),
    pricing = form.parentElement!;
  const definition = customElements.get(pricing.localName);
  if (
    !definition ||
    !(pricing instanceof definition) ||
    !pricing.shadowRoot?.querySelector("slot")
  )
    throw new Error(unavailable);
  // This marker is consumed by the theme's feature-selection handler. Native
  // labels alone are not authorization to mutate arbitrary product-page fields.
  const candidates = [
    ...form.querySelectorAll(
      "input[data-feature-option],select:has(option[data-feature-option])",
    ),
  ];
  if (candidates.length > 160) throw new Error(unavailable);
  const controls: ProductConfigurationControl[] = [],
    choices: Choice[][] = [];
  const bindings: {
    parentId?: string;
    fieldset: Element | null;
    ambiguous: boolean;
  }[] = [];
  const radioGroups = new Map<string, number>();
  for (const element of candidates) {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement
      ) ||
      element.form !== form ||
      element.closest(
        "dynamic-pricing-measurements,product-level-insurance,dynamic-pricing-sample-option",
      )
    )
      continue;
    const parts = element.name.split("##");
    if (
      parts.length < 2 ||
      parts.length > 3 ||
      !parts.slice(1).every((id) => /^\d{1,12}$/.test(id))
    )
      continue;
    const feature = parts[1];
    const matchingValue = (value: string, marker: string | null) => {
      const split = value.split("##");
      return split.length === 2 &&
        /^\d{1,12}$/.test(split[1]) &&
        marker === `${feature}##${split[1]}`
        ? label(split[0])
        : null;
    };
    let index: number;
    const addControl = (
      kind: ProductConfigurationControl["kind"],
      title: string,
    ) => {
      if (controls.length === 24) throw new Error(unavailable);
      const index = controls.length;
      controls.push({
        id: `c${index}`,
        label: label(title),
        kind,
        options: [],
      });
      choices.push([]);
      bindings.push({
        parentId: parts[2],
        fieldset: element.closest("fieldset[data-feature]"),
        ambiguous: false,
      });
      return index;
    };
    const addChoice = (
      index: number,
      title: string,
      choice: Choice,
      selected: boolean,
      enabled: boolean,
    ) => {
      const list = controls[index].options;
      if (
        bindings[index].fieldset !== element.closest("fieldset[data-feature]")
      )
        bindings[index].ambiguous = true;
      if (list.length === 32) throw new Error(unavailable);
      list.push({
        id: `o${list.length}`,
        label: title,
        selected,
        available: enabled,
      });
      choices[index].push(choice);
    };
    if (element instanceof HTMLSelectElement) {
      if (element.multiple) continue;
      const options = [...element.options]
        .map((option) => ({
          option,
          title: matchingValue(
            option.value,
            option.getAttribute("data-feature-option"),
          ),
        }))
        .filter((entry) => entry.title !== null);
      if (
        !options.length ||
        options.length !==
          [...element.options].filter((option) => option.value !== "").length
      )
        continue;
      index = addControl("select", parts[0]);
      for (const { option, title } of options)
        addChoice(
          index,
          title!,
          { control: element, value: option.value },
          option.selected,
          available(element) &&
            !option.disabled &&
            !option.closest("optgroup[disabled]"),
        );
    } else if (element.type === "radio" || element.type === "checkbox") {
      const title = matchingValue(
        element.value,
        element.getAttribute("data-feature-option"),
      );
      if (!title) continue;
      if (element.type === "checkbox") {
        index = addControl("checkbox", `${parts[0]}: ${title}`);
        for (const checked of [false, true])
          addChoice(
            index,
            checked ? "Selected" : "Not selected",
            { control: element, value: element.value, checked },
            element.checked === checked,
            available(element),
          );
      } else {
        index = radioGroups.get(element.name) ?? addControl("radio", parts[0]);
        radioGroups.set(element.name, index);
        addChoice(
          index,
          title,
          { control: element, value: element.value, checked: true },
          element.checked,
          available(element),
        );
      }
    }
  }
  // The theme encodes a nested choice's parent option in the third name
  // segment. Resolve only unique native parents in the same feature fieldset.
  const resolved = new Set<number>(),
    resolving = new Set<number>();
  const resolveParent = (index: number) => {
    if (resolved.has(index)) return;
    if (resolving.has(index)) throw new Error(unavailable);
    resolving.add(index);
    const binding = bindings[index];
    if (binding.parentId !== undefined) {
      const parents = choices.flatMap((options, controlIndex) =>
        options.flatMap((choice, optionIndex) =>
          choice.control instanceof HTMLInputElement &&
          choice.checked === true &&
          choice.value.split("##")[1] === binding.parentId &&
          binding.fieldset !== null &&
          choice.control.closest("fieldset[data-feature]") ===
            binding.fieldset &&
          (choice.control.name.split("##").length === 3 ||
            choice.control.name.split("##")[1] ===
              binding.fieldset.getAttribute("data-feature"))
            ? [{ controlIndex, optionIndex }]
            : [],
        ),
      );
      if (binding.ambiguous || parents.length !== 1) {
        controls[index].options.forEach((option) => {
          option.available = false;
        });
      } else {
        const parent = parents[0];
        resolveParent(parent.controlIndex);
        controls[index].parent = {
          controlId: controls[parent.controlIndex].id,
          optionId:
            controls[parent.controlIndex].options[parent.optionIndex].id,
        };
        const option =
          controls[parent.controlIndex].options[parent.optionIndex];
        controls[index].options.forEach((child) => {
          child.available &&= option.selected && option.available;
        });
      }
    }
    resolving.delete(index);
    resolved.add(index);
  };
  controls.forEach((_, index) => resolveParent(index));
  const elements = [
    ...form.querySelectorAll("input:not([type=hidden]),select"),
  ];
  if (elements.length > 200) throw new Error(unavailable);
  const measurements = readProductMeasurements(form);
  const configuredPrice = readConfiguredProductPrice(
    form,
    productPath,
    measurements,
  );
  controls.forEach((control, index) =>
    control.options.forEach((option, optionIndex) => {
      if (!option.available) return;
      const choice = choices[index][optionIndex];
      if (
        choice.control instanceof HTMLInputElement &&
        choice.control.type === "checkbox" &&
        choice.checked !== true
      )
        return;
      const feature = choice.control.name.split("##")[1];
      const priceLabel = readProductOptionPrice(
        form,
        choice.control,
        `${feature}##${choice.value.split("##")[1]}`,
        configuredPrice,
      );
      if (priceLabel) option.priceLabel = priceLabel;
    }),
  );
  const fingerprint = JSON.stringify([
    controls,
    measurements,
    configuredPrice,
    elements.map((element) => {
      const control = element as NativeControl;
      return [
        control.name,
        control.type,
        control.value,
        control instanceof HTMLInputElement ? control.checked : null,
        control.disabled,
        control.getAttribute("data-feature-option"),
        control.getAttribute("min"),
        control.getAttribute("max"),
        control.getAttribute("step"),
      ];
    }),
  ]);
  return {
    form,
    controls,
    choices,
    elements,
    measurements,
    configuredPrice,
    fingerprint,
  };
}

/** One bounded, expiring DOM capability per mounted Roman runtime. */
export function createProductConfigurationTools() {
  let snapshot:
    | (Inspection & { id: string; productPath: string; createdAt: number })
    | null = null;
  let disposed = false;
  let pending: AbortController | undefined;
  return {
    getProductConfiguration(
      productPath: string,
      signal: AbortSignal,
    ): ProductConfiguration {
      signal.throwIfAborted();
      if (disposed) throw new Error("Roman product configuration is closed.");
      parseProductConfigurationCall("get_product_configuration", {
        productPath,
      });
      const actions = { sampleAvailable: isSampleAvailable(productPath) };
      snapshot = null;
      try {
        if (pending) throw new Error(unavailable);
        const current = inspect(productPath),
          id = crypto.randomUUID();
        snapshot = { ...current, id, productPath, createdAt: Date.now() };
        return parseProductConfigurationResult("get_product_configuration", {
          status: "available",
          productPath,
          configurationId: id,
          controls: current.controls,
          measurements: current.measurements,
          configuredPrice: current.configuredPrice,
          actions,
          message:
            "These are supported native product choices. Unavailable choices need the theme's required steps. Measurements use the confirmed measurement tool; purchases and insurance are separate.",
        });
      } catch {
        snapshot = null;
        return {
          status: "unavailable",
          productPath,
          configurationId: null,
          controls: [],
          measurements: null,
          configuredPrice: null,
          actions,
          message: unavailable,
        };
      }
    },
    async configureProduct(
      input: Extract<
        ProductConfigurationCall,
        { name: "configure_product" }
      >["arguments"],
      signal: AbortSignal,
    ): Promise<ConfigureProductResult> {
      const call = parseProductConfigurationCall("configure_product", input);
      if (call.name !== "configure_product") throw new Error(unavailable);
      const saved = snapshot;
      snapshot = null; // Consume before validation or dispatch; never replay an uncertain action.
      signal.throwIfAborted();
      const result = (
        status: ConfigureProductResult["status"],
        message: string,
      ): ConfigureProductResult => ({
        status,
        productPath: input.productPath,
        message,
      });
      if (
        disposed ||
        pending ||
        !saved ||
        saved.id !== input.configurationId ||
        saved.productPath !== input.productPath ||
        Date.now() - saved.createdAt > 120_000
      )
        return result(
          "unsupported",
          "Read this product's current configuration again before changing a choice.",
        );
      let current: Inspection;
      try {
        current = inspect(input.productPath);
      } catch {
        return result("unsupported", unavailable);
      }
      if (
        current.form !== saved.form ||
        current.fingerprint !== saved.fingerprint ||
        current.elements.length !== saved.elements.length ||
        current.elements.some(
          (element, index) => element !== saved.elements[index],
        )
      )
        return result(
          "unsupported",
          "The product controls changed. Read the current configuration again before choosing an option.",
        );
      const c = Number(input.controlId.slice(1)),
        o = Number(input.optionId.slice(1));
      const choice = saved.choices[c]?.[o],
        option = saved.controls[c]?.options[o];
      if (!choice || !option?.available)
        return result("unsupported", unavailable);
      signal.throwIfAborted();
      const controller = new AbortController();
      pending = controller;
      const controlName = choice.control.name;
      const featureOption = choice.control.getAttribute("data-feature-option");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const selected = () =>
        !disposed &&
        !signal.aborted &&
        !controller.signal.aborted &&
        isCurrentProduct(input.productPath) &&
        saved.form.isConnected &&
        choice.control.isConnected &&
        choice.control.form === saved.form &&
        choice.control.name === controlName &&
        choice.control.getAttribute("data-feature-option") === featureOption &&
        choice.control.value === choice.value &&
        (!(choice.control instanceof HTMLInputElement) ||
          choice.control.checked === choice.checked);
      try {
        if (!option.selected) {
          if (choice.control instanceof HTMLInputElement)
            choice.control.checked = choice.checked!;
          else choice.control.value = choice.value;
          notifyProductControl(choice.control);
        }
        const price = selected()
          ? await settleProductPrice(
              saved.form,
              input.productPath,
              controller.signal,
            )
          : "uncertain";
        const settled =
          price !== "uncertain" && selected()
            ? inspect(input.productPath)
            : undefined;
        if (
          price === "uncertain" ||
          !selected() ||
          settled?.form !== saved.form ||
          !settled.choices.some((choices, controlIndex) =>
            choices.some(
              (candidate, optionIndex) =>
                candidate.control === choice.control &&
                candidate.value === choice.value &&
                candidate.checked === choice.checked &&
                settled.controls[controlIndex].options[optionIndex].selected &&
                settled.controls[controlIndex].options[optionIndex].available,
            ),
          )
        )
          return result(
            "uncertain",
            "The theme changed while applying this option. Review the product controls and price before continuing; nothing was added to the cart.",
          );
        return result(
          "applied",
          price === "needs_configuration"
            ? "The requested product option is selected. The theme still needs product configuration before pricing is ready; read its current choices before continuing. Nothing was added to the cart."
            : "The requested product option is selected and the theme has finished updating. Read its current configuration before changing another choice. Nothing was added to the cart.",
        );
      } catch {
        return result(
          "uncertain",
          "The theme could not confirm this option. Review its product controls before repeating a change; nothing was added to the cart.",
        );
      } finally {
        signal.removeEventListener("abort", abort);
        if (pending === controller) pending = undefined;
      }
    },
    dispose() {
      disposed = true;
      pending?.abort();
      snapshot = null;
    },
  };
}
