import { parseProductPath, productPathSchema } from "./product-path";

export type MeasurementToolName = "set_measurements" | "get_measurements";

export type MeasurementInput = {
  productPath: string;
  width: number;
  height: number;
  unit: "mm" | "cm" | "in";
  kind: "window" | "order";
  mount: "recess" | "exact" | "unknown";
};

export interface MeasurementDraft extends MeasurementInput {
  updatedAt: string;
}

export type MeasurementCall =
  | { name: "set_measurements"; arguments: MeasurementInput }
  | { name: "get_measurements"; arguments: { productPath: string } };

export type MeasurementToolResult =
  | { status: "saved" | "found"; draft: MeasurementDraft }
  | { status: "not_found"; productPath: string };

export interface ApplyMeasurementsResult {
  status:
    | "applied"
    | "unsupported"
    | "needs_configuration"
    | "cancelled"
    | "uncertain";
  productPath: string;
  draftUpdatedAt: string;
  message: string;
}

export interface ApplyMeasurementsCommand {
  productPath: string;
  draft: MeasurementDraft;
}

const dimensionSchema = {
  type: "number",
  exclusiveMinimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

export const measurementToolDefinitions = [
  {
    type: "function",
    name: "set_measurements",
    description:
      "Save dimensions explicitly supplied by the customer for one verified product path. Width and height (drop) retain their exact units. Use kind window for unconfirmed notes and order for exact values the customer has confirmed for the chosen product inputs. Confirm width, drop and units together once; do not re-confirm an acknowledged pair or require a mounting answer. Preserve supplied mount, otherwise use unknown. For a configure/fill request, follow a successful save with apply_measurements; save-only requests stop here. Never convert, round, deduct allowances or infer a fit. Saving does not fill or submit the product form.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        productPath: productPathSchema,
        width: dimensionSchema,
        height: dimensionSchema,
        unit: { type: "string", enum: ["mm", "cm", "in"] },
        kind: { type: "string", enum: ["window", "order"] },
        mount: { type: "string", enum: ["recess", "exact", "unknown"] },
      },
      required: ["productPath", "width", "height", "unit", "kind", "mount"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_measurements",
    description:
      "Read this conversation's saved dimensions for one verified product path. No saved draft means the dimensions are unknown. Saved window measurements are not order dimensions and do not establish fitting suitability.",
    strict: true,
    parameters: {
      type: "object",
      properties: { productPath: productPathSchema },
      required: ["productPath"],
      additionalProperties: false,
    },
  },
] as const;

export const applyMeasurementsToolDefinition = {
  type: "function",
  name: "apply_measurements",
  description:
    "Fill the current product width and drop inputs after the customer has confirmed the pair and units in the conversation and chosen this product. Only an order-kind draft containing those confirmed input values can be applied. Use after set_measurements for configure/fill requests; there is no additional on-screen approval. This does not convert units, select mounting, validate fitting suitability, submit the form or add to cart. Window measurements must never be applied as order dimensions.",
  strict: true,
  parameters: {
    type: "object",
    properties: { productPath: productPathSchema },
    required: ["productPath"],
    additionalProperties: false,
  },
} as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Measurements must be an object.");
  return value as Record<string, unknown>;
}

export function parseMeasurementCall(
  name: string,
  input: unknown,
): MeasurementCall {
  const value = object(input);
  const productPath = parseProductPath(value.productPath);
  if (name === "get_measurements" && Object.keys(value).length === 1)
    return { name, arguments: { productPath } };
  if (
    name !== "set_measurements" ||
    Object.keys(value).length !== 6 ||
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    value.width > Number.MAX_SAFE_INTEGER ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    value.height > Number.MAX_SAFE_INTEGER ||
    !["mm", "cm", "in"].includes(value.unit as string) ||
    !["window", "order"].includes(value.kind as string) ||
    !["recess", "exact", "unknown"].includes(value.mount as string)
  )
    throw new Error(
      "Supply positive width and height, unit, kind and mount explicitly.",
    );
  return {
    name,
    arguments: {
      productPath,
      width: value.width,
      height: value.height,
      unit: value.unit as MeasurementInput["unit"],
      kind: value.kind as MeasurementInput["kind"],
      mount: value.mount as MeasurementInput["mount"],
    },
  };
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Measurements require a valid saved timestamp.");
  return value;
}

export function parseMeasurementDraft(input: unknown): MeasurementDraft {
  const value = object(input);
  const { updatedAt, ...measurements } = value;
  const call = parseMeasurementCall("set_measurements", measurements);
  if (call.name !== "set_measurements")
    throw new Error("Invalid measurement draft.");
  return { ...call.arguments, updatedAt: timestamp(updatedAt) };
}

export function parseApplyMeasurementsCommand(
  input: unknown,
): ApplyMeasurementsCommand {
  const value = object(input);
  const productPath = parseProductPath(value.productPath);
  const draft = parseMeasurementDraft(value.draft);
  if (
    Object.keys(value).length !== 2 ||
    draft.productPath !== productPath ||
    draft.kind !== "order"
  )
    throw new Error(
      "Applying measurements requires the saved order dimensions for this product.",
    );
  return { productPath, draft };
}

export function parseMeasurementToolResult(
  input: unknown,
): MeasurementToolResult {
  const value = object(input);
  if (Object.keys(value).length === 2) {
    if (value.status === "not_found")
      return {
        status: value.status,
        productPath: parseProductPath(value.productPath),
      };
    if (value.status === "saved" || value.status === "found")
      return {
        status: value.status,
        draft: parseMeasurementDraft(value.draft),
      };
  }
  throw new Error("Invalid measurement result.");
}

export function parseApplyMeasurementsResult(
  input: unknown,
): ApplyMeasurementsResult {
  const value = object(input);
  if (
    Object.keys(value).length !== 4 ||
    ![
      "applied",
      "unsupported",
      "needs_configuration",
      "cancelled",
      "uncertain",
    ].includes(value.status as string) ||
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.message.length > 500
  )
    throw new Error("Invalid measurement application result.");
  return {
    status: value.status as ApplyMeasurementsResult["status"],
    productPath: parseProductPath(value.productPath),
    draftUpdatedAt: timestamp(value.draftUpdatedAt),
    message: value.message.trim(),
  };
}
