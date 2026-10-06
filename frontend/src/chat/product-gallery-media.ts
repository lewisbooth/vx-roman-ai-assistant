import type { ImageSource } from "../../../shared/visualizations/ImageComparison";
import type { ProductGalleryImage } from "../tools/product-image";

/** Private previews are a chat presentation, never public catalogue evidence. */
export type ProductGalleryPreview = {
  kind: "visualization";
  id: string;
  alt: string;
  width: number;
  height: number;
  sourceKey: string;
  source: () => ImageSource;
  onOpen: () => void;
};
export type ProductGalleryMedia = ProductGalleryImage | ProductGalleryPreview;

export const galleryMediaKey = (image: ProductGalleryMedia, zoom = false) =>
  image.kind === "visualization"
    ? `${image.id}:${image.sourceKey}`
    : `${image.id}:${image.src}:${zoom ? image.zoomSrc : ""}`;
