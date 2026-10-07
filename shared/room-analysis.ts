export const PHOTO_ANALYSIS_STATUSES = ["queued", "analyzing", "completed", "failed"] as const;
export const ROOM_ANALYSIS_WAIT_MS = 10_000;
export interface PhotoAnalysisStatusDto {
  status: (typeof PHOTO_ANALYSIS_STATUSES)[number];
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
type Confidence = "high" | "medium" | "low";
export interface RoomOpening {
  id: number;
  location: string;
  opening_type: "standard_window" | "bifold" | "patio" | "skylight" | "other" | "unknown";
  opening_type_confidence: Confidence;
  recess: "recess" | "no_recess" | "unknown";
  recess_confidence: Confidence;
  aspect_ratio_width_over_height: number | null;
  aspect_ratio_confidence: Confidence;
  visibility: "full" | "partially_occluded" | "cropped" | "cropped_and_occluded";
  current_coverings: string[];
  uncertainties: string[];
}
export interface RoomAnalysis {
  image_kind: "room_photo" | "illustration_or_design" | "other" | "unclear";
  summary: string;
  colours: string[];
  decor_style: string[];
  notable_features: string[];
  windows: { visible_count: number; count_confidence: Confidence; count_note: string; items: RoomOpening[] };
  limitations: string[];
}
const text = { type: "string", maxLength: 400 } as const;
const choice = (values: readonly string[]) => ({ type: "string", enum: values } as const);
const list = (maxItems: number) => ({ type: "array", items: text, maxItems } as const);
const confidence = choice(["high", "medium", "low"]);
const openingProperties = {
  id: { type: "integer", minimum: 1, maximum: 30 },
  location: text,
  opening_type: choice(["standard_window", "bifold", "patio", "skylight", "other", "unknown"]),
  opening_type_confidence: confidence,
  recess: choice(["recess", "no_recess", "unknown"]),
  recess_confidence: confidence,
  aspect_ratio_width_over_height: { type: ["number", "null"], minimum: 0.05, maximum: 20 },
  aspect_ratio_confidence: confidence,
  visibility: choice(["full", "partially_occluded", "cropped", "cropped_and_occluded"]),
  current_coverings: list(3),
  uncertainties: list(2),
} as const;
const properties = {
  image_kind: choice(["room_photo", "illustration_or_design", "other", "unclear"]),
  summary: text,
  colours: list(5),
  decor_style: list(3),
  notable_features: list(4),
  windows: {
    type: "object",
    properties: {
      visible_count: { type: "integer", minimum: 0, maximum: 30 },
      count_confidence: confidence,
      count_note: text,
      items: { type: "array", maxItems: 30, items: { type: "object", properties: openingProperties, required: Object.keys(openingProperties), additionalProperties: false } },
    },
    required: ["visible_count", "count_confidence", "count_note", "items"],
    additionalProperties: false,
  },
  limitations: list(3),
} as const;
export const roomAnalysisSchema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false } as const;

// Validate the same bounded contract sent to the provider, including cached JSON.
type Rule = { type: string | readonly string[]; enum?: readonly string[]; minimum?: number; maximum?: number; maxLength?: number; maxItems?: number; items?: Rule; properties?: Record<string, Rule> };
function matches(value: unknown, rule: Rule): boolean {
  const types = typeof rule.type === "string" ? [rule.type] : rule.type;
  if (value === null) return types.includes("null");
  if (typeof value === "string") return types.includes("string") && (!rule.enum || rule.enum.includes(value)) && value.length <= (rule.maxLength ?? 400) && !/\p{Cc}/u.test(value);
  if (typeof value === "number") return Number.isFinite(value) && (types.includes("number") || types.includes("integer") && Number.isInteger(value)) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
  if (Array.isArray(value)) return types.includes("array") && value.length <= (rule.maxItems ?? 30) && !!rule.items && value.every((item) => matches(item, rule.items!));
  if (typeof value !== "object" || !types.includes("object") || !rule.properties) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(rule.properties).length && Object.entries(rule.properties).every(([key, child]) => matches(record[key], child));
}
export function parseRoomAnalysis(value: unknown): RoomAnalysis {
  if (!matches(value, roomAnalysisSchema)) throw new Error("Invalid room analysis.");
  const result = value as RoomAnalysis;
  if (result.windows.visible_count !== result.windows.items.length || result.windows.items.some((window, index) => window.id !== index + 1)) throw new Error("Invalid room opening inventory.");
  return result;
}
export function isPhotoAnalysisStatusDto(value: unknown): value is PhotoAnalysisStatusDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const date = (entry: unknown) => typeof entry === "string" && entry.length <= 40 && Number.isFinite(Date.parse(entry));
  return Object.keys(v).length === 4 && PHOTO_ANALYSIS_STATUSES.includes(v.status as PhotoAnalysisStatusDto["status"]) && date(v.queuedAt) && (v.startedAt === null || date(v.startedAt)) && (v.completedAt === null || date(v.completedAt));
}
