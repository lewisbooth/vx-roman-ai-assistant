export const GALLERY_STORAGE_KEY = "roman-gallery-v1";

/** Private Gallery DTOs contain metadata only, never credentials or image bytes. */
export interface WindowPhotoDto {
  id: string;
  title: string;
  revision: number;
  width: number;
  height: number;
  cleanup: boolean;
  createdAt: string;
}

export const VISUALIZATION_STATUSES = [
  "awaiting_product", "preparing_assets", "generating", "saving",
  "completed", "failed", "unknown", "cancelled",
] as const;
export type VisualizationStatus = (typeof VISUALIZATION_STATUSES)[number];
export interface VisualizationJobDto {
  id: string;
  windowId: string;
  windowTitle: string;
  productPath: string;
  productTitle: string;
  status: VisualizationStatus;
  width: number;
  height: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  resultAvailable: boolean;
}
export interface GallerySnapshot {
  enabled: boolean;
  liveWindowIds: string[];
  liveVisualizationIds: string[];
  windows: WindowPhotoDto[];
  visualizations: VisualizationJobDto[];
  nextWindowsCursor: string | null;
  nextVisualizationsCursor: string | null;
}
export interface GalleryCredential {
  ownerId: string;
  token: string;
  apiBaseUrl: string;
}
export type ProductImageRole = "installation" | "detail" | "unknown";
export interface VisualizationReference {
  url: string;
  role: ProductImageRole;
  alt: string;
}
export interface VisualizationPreparation {
  productPath: string;
  references: VisualizationReference[];
}
export type PhotoPresentation =
  | { kind: "windows"; windowIds: string[] }
  | { kind: "upload"; suggestedTitle: string | null };
export type MediaPart =
  | { type: "media"; version: 1; kind: "window"; windowId: string; title: string; customerIntent: boolean }
  | { type: "media"; version: 1; kind: "visualization"; jobId: string; customerIntent: boolean }
  | { type: "media"; version: 1; kind: "windows"; windowIds: string[] }
  | { type: "media"; version: 1; kind: "upload"; suggestedTitle: string | null }
  | { type: "media"; version: 1; kind: "renamed"; windowId: string; previousTitle: string; title: string }
  | { type: "media"; version: 1; kind: "outcome"; jobId: string; status: VisualizationStatus };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const titleValid = (value: unknown, limit = 100) => typeof value === "string" && !!value.trim() && value.length <= limit && !/\p{Cc}/u.test(value);
export function isWindowPhotoDto(value: unknown): value is WindowPhotoDto {
  return object(value) && isMediaId(value.id) && titleValid(value.title) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && Number(value.width) > 0 && Number(value.height) > 0 && Number(value.width) < 2048 && Number(value.height) < 2048 && typeof value.cleanup === "boolean" && date(value.createdAt);
}
export function isVisualizationJobDto(value: unknown): value is VisualizationJobDto {
  return object(value) && isMediaId(value.id) && isMediaId(value.windowId) && titleValid(value.windowTitle) && titleValid(value.productTitle, 200) && typeof value.productPath === "string" && /^\/products\/[a-z0-9][a-z0-9-]*$/i.test(value.productPath) && typeof value.status === "string" && (VISUALIZATION_STATUSES as readonly string[]).includes(value.status) && typeof value.resultAvailable === "boolean" && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && Number(value.width) > 0 && Number(value.height) > 0 && Number(value.width) < 2048 && Number(value.height) < 2048 && date(value.createdAt) && (value.startedAt === null || date(value.startedAt)) && (value.completedAt === null || date(value.completedAt)) && (value.error === null || typeof value.error === "string" && value.error.length <= 500);
}
export function windowTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Name your window.");
  const title = value.trim();
  if (!title || title.length > 100 || /\p{Cc}/u.test(title))
    throw new Error("Use a window name between 1 and 100 characters.");
  return title;
}
export function parsePhotoPresentation(value: unknown): PhotoPresentation | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid photo presentation.");
  const v = value as Record<string, unknown>;
  if (v.kind === "windows" && Object.keys(v).length === 2 && Array.isArray(v.windowIds) &&
      v.windowIds.length > 0 && v.windowIds.length <= 10 && v.windowIds.every(isMediaId) &&
      new Set(v.windowIds).size === v.windowIds.length)
    return { kind: "windows", windowIds: v.windowIds };
  if (v.kind === "upload" && Object.keys(v).length === 2 &&
      (v.suggestedTitle === null || typeof v.suggestedTitle === "string"))
    return { kind: "upload", suggestedTitle: v.suggestedTitle === null ? null : windowTitle(v.suggestedTitle) };
  throw new Error("Invalid photo presentation.");
}
export function isMediaPart(value: unknown): value is MediaPart {
  if (!object(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "media" || v.version !== 1) return false;
  const exact = (keys: string[]) => Object.keys(v).length === keys.length + 3 && Object.keys(v).every((key) => ["type", "version", "kind", ...keys].includes(key));
  if (v.kind === "window") return exact(["windowId", "title", "customerIntent"]) && isMediaId(v.windowId) && titleValid(v.title) && typeof v.customerIntent === "boolean";
  if (v.kind === "visualization") return exact(["jobId", "customerIntent"]) && isMediaId(v.jobId) && typeof v.customerIntent === "boolean";
  if (v.kind === "windows") return exact(["windowIds"]) && Array.isArray(v.windowIds) && v.windowIds.length > 0 && v.windowIds.length <= 10 && v.windowIds.every(isMediaId) && new Set(v.windowIds).size === v.windowIds.length;
  if (v.kind === "upload") return exact(["suggestedTitle"]) && (v.suggestedTitle === null || titleValid(v.suggestedTitle));
  if (v.kind === "renamed") return exact(["windowId", "title", "previousTitle"]) && isMediaId(v.windowId) && titleValid(v.title) && titleValid(v.previousTitle);
  return v.kind === "outcome" && exact(["jobId", "status"]) && isMediaId(v.jobId) && VISUALIZATION_STATUSES.includes(v.status as VisualizationStatus);
}
export function isCustomerMediaIntent(part: MediaPart): boolean {
  return (part.kind === "window" || part.kind === "visualization") && part.customerIntent;
}
export const photoPresentationSchema = {
  anyOf: [
    { type: "null" },
    { type: "object", properties: { kind: { type: "string", enum: ["windows"] }, windowIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } }, required: ["kind", "windowIds"], additionalProperties: false },
    { type: "object", properties: { kind: { type: "string", enum: ["upload"] }, suggestedTitle: { type: ["string", "null"], maxLength: 100 } }, required: ["kind", "suggestedTitle"], additionalProperties: false },
  ],
} as const;
