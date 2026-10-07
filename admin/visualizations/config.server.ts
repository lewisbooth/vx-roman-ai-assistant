import { resolve } from "node:path";

export const MEDIA_CONSENT_VERSION = "roman-window-photo-v2";
// v1 permitted visualization; v2 additionally covers advisory image analysis.
export const VISUALIZATION_CONSENT_VERSIONS = ["roman-window-photo-v1", MEDIA_CONSENT_VERSION];
export const ACTIVE_JOB_STATUSES = ["awaiting_product", "preparing_assets", "generating", "saving"];
export const MAX_GALLERY_BYTES = 500 * 1024 * 1024;
export const MAX_STORE_BYTES = 20 * 1024 * 1024 * 1024;
export const RESULT_RESERVATION_BYTES = 10 * 1024 * 1024;
export const JOB_DEADLINE_MS = 210_000;
export function mediaRoot() {
  const root = process.env.ROMAN_MEDIA_ROOT;
  if (!root) throw new Error("ROMAN_MEDIA_ROOT is required for the private gallery.");
  return resolve(root);
}
export function visualizationsEnabled(shop?: string) {
  const shops = process.env.ROMAN_VISUALIZATIONS_SHOPS?.split(",").map((value) => value.trim()).filter(Boolean);
  return process.env.ROMAN_VISUALIZATIONS_ENABLED === "true" && !!process.env.OPENAI_IMAGE_API_KEY?.trim() && !!process.env.ROMAN_MEDIA_ROOT && (!shop || !shops?.length || shops.includes(shop));
}
