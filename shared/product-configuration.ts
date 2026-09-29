import { parseProductPath, productPathSchema } from "./product-path";

export type ProductConfigurationToolName =
  "get_product_configuration" | "configure_product";
export interface ProductConfigurationChoice {
  id: string;
  label: string;
  selected: boolean;
  available: boolean;
  /** Native displayed option charge, separate from the configured product total. */
  priceLabel?: string;
}
export interface ProductConfigurationControl {
  id: string;
  label: string;
  kind: "radio" | "select" | "checkbox";
  options: ProductConfigurationChoice[];
  /** A native dependency on an option in this same configuration snapshot. */
  parent?: { controlId: string; optionId: string };
  /** Optional paid protection needs a separate, explicit customer decision. */
  purpose?: "measurement_guarantee";
  description?: string;
}
export const MAX_NATIVE_MEASUREMENT_VALUES = 512;
export type NativeMeasurementConstraint =
  | {
      kind: "number";
      min: number | null;
      max: number | null;
      step: number | "any";
      stepBase: number;
    }
  | { kind: "select"; values: number[] };
export interface ProductMeasurementConstraints {
  unit: "mm" | "cm" | "in";
  /** In inches these describe the whole-inch controls, not the combined value. */
  width: NativeMeasurementConstraint;
  height: NativeMeasurementConstraint;
  /** Separate fractional-inch controls. No derived combined bounds are implied. */
  fractions?: {
    width: NativeMeasurementConstraint;
    height: NativeMeasurementConstraint;
  };
}
export interface ProductMeasurements {
  unit: "mm" | "cm" | "in" | null;
  width: number | null;
  height: number | null;
  availableUnits: ("mm" | "cm" | "in")[];
  /** Present only when the current native form exposes one unambiguous pair. */
  entry?: "single_pair";
  /** Observed native constraints, by unit; missing units/limits remain unknown. */
  constraints?: ProductMeasurementConstraints[];
}
export interface ProductConfiguration {
  status: "available" | "unavailable";
  productPath: string;
  configurationId: string | null;
  controls: ProductConfigurationControl[];
  measurements: ProductMeasurements | null;
  // Optional only for durable results recorded before action discovery existed.
  actions?: { sampleAvailable: boolean };
  // Missing only in historical/older frontend results; null means no current quote.
  configuredPrice?: string | null;
  message: string;
}
export interface ConfigureProductResult {
  status: "applied" | "unsupported" | "uncertain" | "cancelled";
  productPath: string;
  message: string;
}
export type ProductConfigurationCall =
  | { name: "get_product_configuration"; arguments: { productPath: string } }
  | {
      name: "configure_product";
      arguments: {
        productPath: string;
        configurationId: string;
        controlId: string;
        optionId: string;
      };
    };
export type ProductConfigurationResult =
  ProductConfiguration | ConfigureProductResult;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controlId = /^c(?:[0-9]|1[0-9]|2[0-3])$/;
const optionId = /^o(?:[0-9]|[12][0-9]|3[01])$/;
const units = ["mm", "cm", "in"] as const;

export const productConfigurationToolDefinitions = [
  {
    type: "function",
    name: "get_product_configuration",
    description:
      "Read supported native options, dependencies, dimensions, per-unit native limits/choices and settled configuredPrice for the currently loaded verified productPath. Returns short-lived single-use configurationId/control/option IDs. Available choices only are mutable; parent IDs belong to this snapshot. option.priceLabel is a surcharge; configuredPrice excludes the separate measurement guarantee and null means unknown. Unsupported widgets and purchase controls are excluded.",
    strict: true,
    parameters: {
      type: "object",
      properties: { productPath: productPathSchema },
      required: ["productPath"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "configure_product",
    description:
      "Apply one available choice using IDs from the latest configuration snapshot and authorized customer intent. A measurement_guarantee requires explicit consent to its current fee and terms, even when preselected; apply an explicit yes/no to record that decision. Waits for the native update; no measurements, cart or purchase action. Snapshot must be read again before another change.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        productPath: productPathSchema,
        configurationId: { type: "string", pattern: uuid.source },
        controlId: { type: "string", pattern: controlId.source },
        optionId: { type: "string", pattern: optionId.source },
      },
      required: ["productPath", "configurationId", "controlId", "optionId"],
      additionalProperties: false,
    },
  },
] as const;

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Product configuration must be an object.");
  return input as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unexpected product configuration fields.");
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid product configuration text.");
  return value;
}
function id(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid product configuration identifier.");
  return value;
}
function nativeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  );
}
function parseNativeConstraint(input: unknown): NativeMeasurementConstraint {
  const value = object(input);
  if (value.kind === "select") {
    exact(value, ["kind", "values"]);
    if (
      !Array.isArray(value.values) ||
      !value.values.length ||
      value.values.length > MAX_NATIVE_MEASUREMENT_VALUES ||
      !value.values.every(nativeNumber) ||
      new Set(value.values).size !== value.values.length
    )
      throw new Error("Invalid native measurement choices.");
    return { kind: "select", values: [...value.values] };
  }
  exact(value, ["kind", "min", "max", "step", "stepBase"]);
  if (
    value.kind !== "number" ||
    (value.min !== null && !nativeNumber(value.min)) ||
    (value.max !== null && !nativeNumber(value.max)) ||
    (typeof value.min === "number" &&
      typeof value.max === "number" &&
      value.min > value.max) ||
    (value.step !== "any" && (!nativeNumber(value.step) || value.step <= 0)) ||
    !nativeNumber(value.stepBase)
  )
    throw new Error("Invalid native measurement limits.");
  return {
    kind: "number",
    min: value.min as number | null,
    max: value.max as number | null,
    step: value.step as number | "any",
    stepBase: value.stepBase,
  };
}
function parseMeasurementConstraints(
  input: unknown,
  available: readonly string[],
): ProductMeasurementConstraints[] {
  if (!Array.isArray(input) || input.length > 3)
    throw new Error("Invalid native measurement units.");
  const seen = new Set<string>();
  return input.map((entry): ProductMeasurementConstraints => {
    const value = object(entry);
    exact(value, [
      "unit",
      "width",
      "height",
      ...(value.unit === "in" ? ["fractions"] : []),
    ]);
    if (
      typeof value.unit !== "string" ||
      !units.includes(value.unit as (typeof units)[number]) ||
      !available.includes(value.unit) ||
      seen.has(value.unit)
    )
      throw new Error("Invalid native measurement unit.");
    seen.add(value.unit);
    const width = parseNativeConstraint(value.width),
      height = parseNativeConstraint(value.height);
    let fractions: ProductMeasurementConstraints["fractions"];
    if (value.unit === "in") {
      const parts = object(value.fractions);
      exact(parts, ["width", "height"]);
      fractions = {
        width: parseNativeConstraint(parts.width),
        height: parseNativeConstraint(parts.height),
      };
      if (
        [width, height].some(
          (part) =>
            part.kind === "select" &&
            part.values.some((value) => !Number.isInteger(value) || value < 0),
        ) ||
        [fractions.width, fractions.height].some(
          (part) =>
            part.kind === "select" &&
            part.values.some((value) => value < 0 || value >= 1),
        )
      )
        throw new Error("Invalid whole or fractional inch choices.");
    }
    return {
      unit: value.unit as ProductMeasurementConstraints["unit"],
      width,
      height,
      ...(fractions ? { fractions } : {}),
    };
  });
}
export function isProductConfigurationTool(
  name: string,
): name is ProductConfigurationToolName {
  return name === "get_product_configuration" || name === "configure_product";
}
export function parseProductConfigurationCall(
  name: ProductConfigurationToolName,
  input: unknown,
): ProductConfigurationCall {
  const value = object(input);
  exact(
    value,
    name === "get_product_configuration"
      ? ["productPath"]
      : ["productPath", "configurationId", "controlId", "optionId"],
  );
  const productPath = parseProductPath(value.productPath);
  if (name === "get_product_configuration")
    return { name, arguments: { productPath } };
  if (name !== "configure_product")
    throw new Error("Unknown product configuration tool.");
  return {
    name,
    arguments: {
      productPath,
      configurationId: id(value.configurationId, uuid),
      controlId: id(value.controlId, controlId),
      optionId: id(value.optionId, optionId),
    },
  };
}
export function parseProductConfigurationResult(
  name: "get_product_configuration",
  input: unknown,
): ProductConfiguration;
export function parseProductConfigurationResult(
  name: "configure_product",
  input: unknown,
): ConfigureProductResult;
export function parseProductConfigurationResult(
  name: ProductConfigurationToolName,
  input: unknown,
): ProductConfigurationResult;
export function parseProductConfigurationResult(
  name: ProductConfigurationToolName,
  input: unknown,
): ProductConfigurationResult {
  const value = object(input);
  const productPath = parseProductPath(value.productPath),
    message = text(value.message, 600);
  if (name === "configure_product") {
    exact(value, ["status", "productPath", "message"]);
    if (
      !["applied", "unsupported", "uncertain", "cancelled"].includes(
        value.status as string,
      )
    )
      throw new Error("Invalid product configuration outcome.");
    return {
      status: value.status as ConfigureProductResult["status"],
      productPath,
      message,
    };
  }
  if (name !== "get_product_configuration")
    throw new Error("Unknown product configuration tool.");
  exact(value, [
    "status",
    "productPath",
    "configurationId",
    "controls",
    "measurements",
    "message",
    ...(value.actions !== undefined ? ["actions"] : []),
    ...(value.configuredPrice !== undefined ? ["configuredPrice"] : []),
  ]);
  const configuredPrice =
    value.configuredPrice === undefined || value.configuredPrice === null
      ? value.configuredPrice
      : text(value.configuredPrice, 120);
  if (typeof configuredPrice === "string" && !/\d/.test(configuredPrice))
    throw new Error("Invalid configured product price.");
  let actions: ProductConfiguration["actions"];
  if (value.actions !== undefined) {
    const input = object(value.actions);
    exact(input, ["sampleAvailable"]);
    if (typeof input.sampleAvailable !== "boolean")
      throw new Error("Invalid product configuration actions.");
    actions = { sampleAvailable: input.sampleAvailable };
  }
  if (
    !["available", "unavailable"].includes(value.status as string) ||
    !Array.isArray(value.controls) ||
    value.controls.length > 24
  )
    throw new Error("Invalid product configuration controls.");
  const controls = value.controls.map(
    (entry, index): ProductConfigurationControl => {
      const control = object(entry);
      exact(control, [
        "id",
        "label",
        "kind",
        "options",
        ...(control.parent !== undefined ? ["parent"] : []),
        ...(control.purpose !== undefined ? ["purpose"] : []),
        ...(control.description !== undefined ? ["description"] : []),
      ]);
      let guarantee:
        | Pick<ProductConfigurationControl, "purpose" | "description">
        | undefined;
      if (control.purpose !== undefined || control.description !== undefined) {
        if (
          control.purpose !== "measurement_guarantee" ||
          control.kind !== "radio" ||
          control.parent !== undefined ||
          !Array.isArray(control.options) ||
          control.options.length !== 2
        )
          throw new Error("Invalid measurement guarantee control.");
        guarantee = {
          purpose: "measurement_guarantee",
          description: text(control.description, 1200),
        };
      }
      let parent: ProductConfigurationControl["parent"];
      if (control.parent !== undefined) {
        const dependency = object(control.parent);
        exact(dependency, ["controlId", "optionId"]);
        parent = {
          controlId: id(dependency.controlId, controlId),
          optionId: id(dependency.optionId, optionId),
        };
      }
      if (
        control.id !== `c${index}` ||
        !["radio", "select", "checkbox"].includes(control.kind as string) ||
        !Array.isArray(control.options) ||
        !control.options.length ||
        control.options.length > 32
      )
        throw new Error("Invalid product configuration control.");
      const options = control.options.map(
        (entry, index): ProductConfigurationChoice => {
          const option = object(entry);
          exact(option, [
            "id",
            "label",
            "selected",
            "available",
            ...(option.priceLabel !== undefined ? ["priceLabel"] : []),
          ]);
          if (
            option.id !== `o${index}` ||
            typeof option.selected !== "boolean" ||
            typeof option.available !== "boolean"
          )
            throw new Error("Invalid product configuration choice.");
          return {
            id: option.id as string,
            label: text(option.label, 160),
            selected: option.selected,
            available: option.available,
            ...(option.priceLabel !== undefined
              ? { priceLabel: text(option.priceLabel, 120) }
              : {}),
          };
        },
      );
      if (options.filter((option) => option.selected).length > 1)
        throw new Error(
          "Product configuration has conflicting selected choices.",
        );
      return {
        id: control.id as string,
        label: text(control.label, 160),
        kind: control.kind as ProductConfigurationControl["kind"],
        options,
        ...(parent ? { parent } : {}),
        ...guarantee,
      };
    },
  );
  // Dependencies describe only this bounded snapshot, never durable IDs or
  // permission to enable a choice the native form currently disables.
  for (const control of controls) {
    const seen = new Set([control.id]);
    let dependency = control.parent;
    while (dependency) {
      const ancestor = controls.find(({ id }) => id === dependency!.controlId);
      const option = ancestor?.options.find(
        ({ id }) => id === dependency!.optionId,
      );
      if (
        !ancestor ||
        !option ||
        seen.has(ancestor.id) ||
        (control.options.some(({ available }) => available) &&
          (!option.selected || !option.available))
      )
        throw new Error("Invalid product configuration dependency.");
      seen.add(ancestor.id);
      dependency = ancestor.parent;
    }
  }
  let measurements: ProductMeasurements | null = null;
  if (value.measurements !== null) {
    const current = object(value.measurements);
    exact(current, [
      "unit",
      "width",
      "height",
      "availableUnits",
      ...(current.entry !== undefined ? ["entry"] : []),
      ...(current.constraints !== undefined ? ["constraints"] : []),
    ]);
    if (
      (current.unit !== null &&
        !units.includes(current.unit as (typeof units)[number])) ||
      !Array.isArray(current.availableUnits) ||
      current.availableUnits.length > 3 ||
      new Set(current.availableUnits).size !== current.availableUnits.length ||
      current.availableUnits.some((unit) => !units.includes(unit))
    )
      throw new Error("Invalid product measurement units.");
    for (const key of ["width", "height"])
      if (
        current[key] !== null &&
        (typeof current[key] !== "number" ||
          !Number.isFinite(current[key]) ||
          (current[key] as number) <= 0 ||
          (current[key] as number) > Number.MAX_SAFE_INTEGER)
      )
        throw new Error("Invalid current product measurement.");
    if (
      current.entry !== undefined &&
      (current.entry !== "single_pair" ||
        current.unit === null ||
        !current.availableUnits.includes(current.unit))
    )
      throw new Error("Invalid native measurement entry.");
    const constraints =
      current.constraints === undefined
        ? undefined
        : parseMeasurementConstraints(
            current.constraints,
            current.availableUnits,
          );
    measurements = {
      ...(current.entry === "single_pair"
        ? { entry: "single_pair" as const }
        : {}),
      ...(constraints ? { constraints } : {}),
      unit: current.unit as ProductMeasurements["unit"],
      width: current.width as number | null,
      height: current.height as number | null,
      availableUnits: [...current.availableUnits],
    };
  }
  if (
    value.status === "unavailable" &&
    (value.configurationId !== null ||
      controls.length ||
      measurements !== null ||
      configuredPrice != null)
  )
    throw new Error(
      "Unavailable product configuration must not contain controls.",
    );
  return {
    status: value.status as ProductConfiguration["status"],
    productPath,
    configurationId:
      value.status === "available" ? id(value.configurationId, uuid) : null,
    controls,
    measurements,
    ...(actions ? { actions } : {}),
    ...(configuredPrice !== undefined ? { configuredPrice } : {}),
    message,
  };
}
