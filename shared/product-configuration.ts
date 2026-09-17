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
}
export interface ProductMeasurements {
  unit: "mm" | "cm" | "in" | null;
  width: number | null;
  height: number | null;
  availableUnits: ("mm" | "cm" | "in")[];
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
      "Read supported native customization choices, their parent-option dependencies, current measurements and the settled displayed configuredPrice on the currently open product. Navigate to the verified product first. Read again after every change to discover newly revealed or enabled choices. Resolve them using established context or a suitable default; ask a short follow-up when a meaningful preference remains unknown. A preselected default alone does not establish customer intent. Only returned available options can be changed; hidden/disabled choices may need the customer's product-page steps. Parent IDs belong to this snapshot only. An option's priceLabel is its native displayed charge: mention it when offering that choice, without confusing it with the total. configuredPrice is the current displayed product price, not a catalog starting price or cart total; null or missing means unknown. Never invent missing prices. The configurationId is short-lived and single-use. Unsupported custom widgets, insurance, quantity and purchase controls are excluded. Measurements must use the confirmed set_measurements/apply_measurements flow, never configure_product.",
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
      "Apply one available customization choice requested by the customer or unambiguously established by their intent and the measuring method, using IDs from the latest get_product_configuration result. For example, outside-recess fitting can map to Exact, and a full width including brackets to Bracket to Bracket. Combine the relevant guide with actual PDP choices; the guide need not use the PDP's exact labels. Read again after every change, including newly exposed choices, before continuing. Ask only when the intended option is unclear. Never invent IDs, choose arbitrary defaults, infer physical suitability, change dimensions or allowances, enable unavailable controls, or retry an uncertain change. This waits for the native update; it does not enter measurements, purchase, add to cart or select insurance.",
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
      ]);
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
    exact(current, ["unit", "width", "height", "availableUnits"]);
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
    measurements = {
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
