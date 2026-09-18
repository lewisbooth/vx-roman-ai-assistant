import type {
  ApplyMeasurementsResult,
  MeasurementDraft,
} from "../../../shared/measurements";
import type { ProductMeasurements } from "../../../shared/product-configuration";
import {
  controlVisible,
  currentProductForm,
  isCurrentProduct,
  notifyProductControl,
} from "./product-controls";
import { settleProductPrice } from "./product-pricing";

const unavailable =
  "These measurements need the product's own supported controls. Review its units, dimensions and fitting option on the matching product page.";
type NumericControl = HTMLInputElement | HTMLSelectElement;
type DimensionField = {
  control: NumericControl;
  number: number;
  axis: "width" | "drop";
  part?: "whole" | "fractional";
};
class InvalidMeasurement extends Error {}
const themeUnit = { mm: "mm", cm: "cm", in: "inches" } as const;
const publicUnit = (unit: string): ProductMeasurements["unit"] =>
  unit === "inches" ? "in" : unit === "mm" || unit === "cm" ? unit : null;

function measurementControls(form: HTMLFormElement) {
  const components = form.querySelectorAll<HTMLElement>(
    "dynamic-pricing-measurements",
  );
  if (components.length !== 1) throw new Error(unavailable);
  const component = components[0],
    definition = customElements.get(component.localName);
  if (
    !definition ||
    !(component instanceof definition) ||
    !component.shadowRoot?.querySelector("slot") ||
    !controlVisible(component)
  )
    throw new Error(unavailable);
  const units = component.querySelectorAll<HTMLSelectElement>(
    "select[data-measurement-select]",
  );
  if (
    units.length !== 1 ||
    units[0].matches(":disabled") ||
    units[0].form !== form ||
    !controlVisible(units[0])
  )
    throw new Error(unavailable);
  return { component, units: units[0] };
}

function numericControl(group: Element, selector: string): NumericControl {
  const controls = group.querySelectorAll(selector);
  if (controls.length !== 1) throw new Error(unavailable);
  const control = controls[0];
  if (
    !(control instanceof HTMLSelectElement) &&
    !(control instanceof HTMLInputElement && control.type === "number")
  )
    throw new Error(unavailable);
  if (control instanceof HTMLSelectElement && control.multiple)
    throw new Error(unavailable);
  return control;
}

function validateValue(field: DimensionField, draft: MeasurementDraft) {
  const { control, number: value, axis, part } = field;
  const requested = `${axis === "width" ? "Width" : "Drop"} ${axis === "width" ? draft.width : draft.height} ${draft.unit}`;
  if (
    control.matches(":disabled") ||
    (control instanceof HTMLInputElement && control.readOnly) ||
    !controlVisible(control)
  )
    throw new Error(unavailable);
  if (control instanceof HTMLSelectElement) {
    const options = [...control.options].filter(
      (option) =>
        option.value !== "" &&
        Number(option.value) === value &&
        !option.disabled &&
        !option.closest("optgroup[disabled]"),
    );
    if (options.length > 1) throw new Error(unavailable);
    if (!options.length)
      throw new InvalidMeasurement(
        `${requested} is not one of the product's available sizes or inch fractions.`,
      );
    return options[0].value;
  }
  const probe = control.cloneNode(false) as HTMLInputElement;
  probe.value = String(value);
  if (probe.valueAsNumber !== value) throw new Error(unavailable);
  if (!probe.checkValidity()) {
    if (
      !probe.validity.rangeUnderflow &&
      !probe.validity.rangeOverflow &&
      !probe.validity.stepMismatch
    )
      throw new Error(unavailable);
    const bounds = (["min", "max"] as const).flatMap((attribute) => {
      const raw = control.getAttribute(attribute);
      return raw?.trim() && Number.isFinite(Number(raw))
        ? [
            `${attribute === "min" ? "minimum" : "maximum"} ${Number(raw)} ${draft.unit}`,
          ]
        : [];
    });
    if (control.step !== "any") {
      const step = Number(control.step);
      bounds.push(
        `increments of ${Number.isFinite(step) && step > 0 ? step : 1} ${draft.unit}`,
      );
    }
    throw new InvalidMeasurement(
      `${requested} is outside the product's allowed range or increments${part ? ` for its ${part}-inch field` : ""}: ${bounds.join(", ")}.`,
    );
  }
  return String(value);
}

function groupFor(component: Element, unit: string) {
  const groups = [
    ...component.querySelectorAll("[data-input-measurement-group]"),
  ].filter(
    (group) => group.getAttribute("data-input-measurement-group") === unit,
  );
  if (groups.length !== 1) throw new Error(unavailable);
  return groups[0];
}

function dimensions(group: Element, draft: MeasurementDraft): DimensionField[] {
  const width = numericControl(group, "[data-width-input]"),
    height = numericControl(group, "[data-drop-input]");
  if (draft.unit !== "in")
    return [
      { control: width, number: draft.width, axis: "width" },
      { control: height, number: draft.height, axis: "drop" },
    ];
  // Splitting an explicitly supplied inch value into the theme's whole/fraction
  // fields changes its representation only. Never round to a supported fraction.
  return [
    {
      control: width,
      number: Math.floor(draft.width),
      axis: "width",
      part: "whole",
    },
    {
      control: numericControl(group, "[data-width-inches-input]"),
      number: draft.width % 1,
      axis: "width",
      part: "fractional",
    },
    {
      control: height,
      number: Math.floor(draft.height),
      axis: "drop",
      part: "whole",
    },
    {
      control: numericControl(group, "[data-drop-inches-input]"),
      number: draft.height % 1,
      axis: "drop",
      part: "fractional",
    },
  ];
}

export function readProductMeasurements(
  form: HTMLFormElement,
): ProductMeasurements | null {
  try {
    const { component, units } = measurementControls(form);
    const unit = publicUnit(units.value);
    const availableUnits = [
      ...new Set(
        [...units.options]
          .filter(
            (option) =>
              !option.disabled && !option.closest("optgroup[disabled]"),
          )
          .map((option) => publicUnit(option.value))
          .filter((unit) => unit !== null),
      ),
    ];
    const result: ProductMeasurements = {
      unit,
      width: null,
      height: null,
      availableUnits,
    };
    if (!unit) return result;
    const group = groupFor(component, units.value);
    if (!group.hasAttribute("data-active-input-measurement")) return result;
    const read = (axis: "width" | "drop") => {
      const input = numericControl(group, `[data-${axis}-input]`);
      const fraction =
        unit === "in"
          ? numericControl(group, `[data-${axis}-inches-input]`)
          : null;
      if (!input.value.trim() || (fraction && !fraction.value.trim()))
        return null;
      const value =
        Number(input.value) + (fraction ? Number(fraction.value) : 0);
      return Number.isFinite(value) &&
        value > 0 &&
        value <= Number.MAX_SAFE_INTEGER
        ? value
        : null;
    };
    result.width = read("width");
    result.height = read("drop");
    return result;
  } catch {
    return null;
  }
}

export async function applyMeasurements(
  draft: MeasurementDraft,
  signal: AbortSignal,
): Promise<ApplyMeasurementsResult> {
  signal.throwIfAborted();
  if (draft.kind !== "order") throw new Error(unavailable);
  const form = currentProductForm(draft.productPath);
  const { component, units } = measurementControls(form);
  const unit = themeUnit[draft.unit];
  if (
    ![...units.options].some(
      (option) =>
        option.value === unit &&
        !option.disabled &&
        !option.closest("optgroup[disabled]"),
    )
  )
    throw new Error(unavailable);
  const target = groupFor(component, unit);
  dimensions(target, draft); // Check the supported shape before changing any live control.
  let changed = false;
  let dimensionsWritten = false;
  const uncertain = (): ApplyMeasurementsResult => ({
    status: "uncertain",
    productPath: draft.productPath,
    draftUpdatedAt: draft.updatedAt,
    message:
      "The theme could not confirm the exact units and dimensions after updating. Review the product controls and price before continuing; nothing was added to the cart.",
  });
  try {
    signal.throwIfAborted();
    if (units.value !== unit) {
      changed = true;
      units.value = unit;
      notifyProductControl(units);
    }
    signal.throwIfAborted();
    const groups = component.querySelectorAll(
      "[data-active-input-measurement]",
    );
    if (
      !isCurrentProduct(draft.productPath) ||
      !form.isConnected ||
      !component.isConnected ||
      !units.isConnected ||
      units.value !== unit ||
      groups.length !== 1 ||
      groups[0] !== target
    )
      throw new Error(unavailable);
    const fields = dimensions(target, draft).map((field) => {
      const { control, number } = field;
      if (control.form !== form) throw new Error(unavailable);
      return { control, number, value: validateValue(field, draft) };
    });
    signal.throwIfAborted();
    // Assign the complete pair (and inch fractions) before either event. Theme
    // pricing always sees coherent confirmed values, never a half-written pair.
    changed = true;
    dimensionsWritten = true;
    for (const { control, value } of fields) control.value = value;
    for (const { control } of fields) notifyProductControl(control);
    const finalGroups = component.querySelectorAll(
      "[data-active-input-measurement]",
    );
    const finalFields = dimensions(target, draft);
    if (
      signal.aborted ||
      !isCurrentProduct(draft.productPath) ||
      !form.isConnected ||
      !component.isConnected ||
      !units.isConnected ||
      units.value !== unit ||
      finalGroups.length !== 1 ||
      finalGroups[0] !== target ||
      finalFields.some(
        ({ control }, index) => control !== fields[index].control,
      ) ||
      fields.some(
        ({ control, number }) =>
          !control.isConnected ||
          control.form !== form ||
          !component.contains(control) ||
          Number(control.value) !== number,
      )
    )
      return uncertain();
    const price = await settleProductPrice(form, draft.productPath, signal);
    const measured = readProductMeasurements(form);
    if (
      price === "uncertain" ||
      !isCurrentProduct(draft.productPath) ||
      measured?.unit !== draft.unit ||
      measured.width !== draft.width ||
      measured.height !== draft.height
    )
      return uncertain();
    return {
      status: "applied",
      productPath: draft.productPath,
      draftUpdatedAt: draft.updatedAt,
      message:
        price === "needs_configuration"
          ? "The confirmed units, width and drop are entered. The theme still needs product configuration before it can be added to the cart. Review its product controls; nothing was added."
          : "The confirmed units, width and drop were entered in the product controls. Check the theme's price and fitting choice. Nothing was added to the cart.",
    };
  } catch (error) {
    if (error instanceof InvalidMeasurement && !dimensionsWritten)
      return {
        status: "invalid_measurements",
        productPath: draft.productPath,
        draftUpdatedAt: draft.updatedAt,
        message: `${error.message} No confirmed dimensions were entered; no values were rounded or adjusted. The displayed unit is ${draft.unit}.`,
      };
    if (changed) return uncertain();
    throw error;
  }
}
