import type {
  ProductImageRole,
  VisualizationReference,
} from "../../../shared/visualizations";
import type { ProductGalleryImage } from "./product-image";

/** Observed catalogue labels; a plain Zoom image does not establish its role. */
export function classifyShopifyImage(image: { url: string; alt?: string }): ProductImageRole {
  const alt = image.alt?.trim() ?? "";
  const fromAlt: ProductImageRole = /^Colorized(?:FabricZoom|PLA)\b/i.test(alt)
    ? "detail"
    : /^Colorized(?:FullRoom|RoomAngle)?(?:\s|$)/i.test(alt)
      ? "installation"
      : "unknown";
  const file = new URL(image.url).pathname.split("/").at(-1) ?? "";
  const fromFile: ProductImageRole = /_(?:FZ|FabricZoom)(?:_|\.)/i.test(file)
    ? "detail"
    : /_(?:FR|FullRoom|RoomAngle|Colorized)(?:_|\.)/i.test(file) ||
        /^PID-\d+_CID-\d+_R(?:_|\.)/i.test(file)
      ? "installation"
      : "unknown";
  if (fromAlt !== "unknown" && fromFile !== "unknown" && fromAlt !== fromFile)
    return "unknown";
  return fromAlt !== "unknown" ? fromAlt : fromFile;
}

/** Gallery URLs are already validated by the product-image owner. */
export function selectVisualizationProductReferences(
  items: readonly ProductGalleryImage[],
): VisualizationReference[] {
  const candidates = [...new Map(items.filter((item) => item.kind === "product")
    .map((item) => {
      const url = item.zoomSrc || item.src;
      return [url, { url, alt: item.alt }] as const;
    })).values()];
  const references = candidates.map((image) => ({
    url: image.url,
    alt: image.alt.slice(0, 200),
    role: classifyShopifyImage(image),
  }));
  // Identify scale and fabric context before capping; unknown photos remain eligible.
  const primary = references.findIndex((image) => image.role === "installation");
  const order = references.map((_, index) => index);
  if (primary > 0) {
    order.splice(primary, 1);
    order.unshift(primary);
  }
  const selected = order.slice(0, 4);
  const detail = references.findIndex((image) => image.role === "detail");
  if (detail >= 0 && !selected.includes(detail) && selected.length === 4)
    selected[3] = detail;
  return selected.map((index) => references[index]);
}
