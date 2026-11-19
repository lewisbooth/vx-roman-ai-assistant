import {
  isCatalogueProductDetailFile,
  isKnownProductDetailUrl,
  isShopifyProductAssetPath,
} from "../../../shared/product-reference-rules";
import type {
  ProductImageRole,
  VisualizationPreparation,
  VisualizationReference,
} from "../../../shared/visualizations";
import { currentProductPath } from "./product-controls";
import {
  loadProductPageMarkup,
  productMediaUrl,
  readProductResponseText,
} from "./product-image";

type ReferenceCandidate = { url: string; alt?: string };
const DETAIL_ALT = /^Colorized(?:FabricZoom|PLA)\b/i;
const NON_PRODUCT =
  /(?:swatch|sample|size[-_ ]?chart|diagram|guide|measure|instruction)/i;

/** Observed catalogue labels. A plain Zoom image does not establish its role. */
export function classifyShopifyImage(
  image: ReferenceCandidate,
): ProductImageRole {
  const alt = image.alt?.trim() ?? "";
  const fromAlt: ProductImageRole = DETAIL_ALT.test(alt)
    ? "detail"
    : /^Colorized(?:FullRoom|RoomAngle)?(?:\s|$)/i.test(alt)
      ? "installation"
      : "unknown";
  const file = new URL(image.url).pathname.split("/").at(-1) ?? "";
  const fromFile: ProductImageRole = isCatalogueProductDetailFile(file)
    ? "detail"
    : /_(?:FR|FullRoom|RoomAngle|Colorized)(?:_|\.)/i.test(file) ||
        /^PID-\d+_CID-\d+_R(?:_|\.)/i.test(file)
      ? "installation"
      : "unknown";
  if (fromAlt !== "unknown" && fromFile !== "unknown" && fromAlt !== fromFile)
    return "unknown";
  return fromAlt !== "unknown" ? fromAlt : fromFile;
}

export function selectVisualizationProductReferences(
  candidates: readonly ReferenceCandidate[],
): VisualizationReference[] {
  const references = [
    ...new Map(candidates.map((image) => [image.url, image])).values(),
  ]
    .filter(
      ({ url, alt }) =>
        !isKnownProductDetailUrl(new URL(url)) &&
        !DETAIL_ALT.test(alt?.trim() ?? ""),
    )
    .map((image) => ({
      url: image.url,
      alt: image.alt?.trim().slice(0, 200) ?? "",
      role: classifyShopifyImage(image),
    }))
    .filter((image) => image.role !== "detail");
  const primary = references.findIndex(
    (image) => image.role === "installation",
  );
  if (primary > 0) references.unshift(...references.splice(primary, 1));
  return references.slice(0, 4);
}

function shopifyId(value: unknown): string | undefined {
  const id =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  return typeof id === "string" && /^[1-9]\d{0,19}$/.test(id) ? id : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function title(value: unknown, maximum: number): string | undefined {
  if (
    typeof value === "string" &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  )
    return value.trim() || undefined;
}

function selectedProduct(source: ParentNode, pageUrl: string) {
  const roots = [
    ...source.querySelectorAll<HTMLElement>(
      'main main-product[update-url="true"]',
    ),
  ].filter((root) => !root.hasAttribute("data-product-card"));
  if (roots.length !== 1) return;
  const root = roots[0];
  const data = root.querySelector(
    'script[type="application/json"][data-selected-variant]',
  );
  const path = root.getAttribute("product-url");
  if (!data || !path) return;
  const url = new URL(path, pageUrl);
  if (
    url.origin !== window.location.origin ||
    url.username ||
    url.password ||
    /\/products\/[a-z0-9][a-z0-9-]*\/?$/i
      .exec(url.pathname)?.[0]
      ?.replace(/\/$/, "") !== new URL(pageUrl).pathname
  )
    return;
  const variantId = shopifyId(
    record(JSON.parse(data.textContent ?? ""))?.id,
  );
  if (!variantId) return;
  return { root, variantId };
}

function isAvailable(element: Element, live: boolean): boolean {
  if (element.closest("[hidden],.hidden,[data-feature-option-slide-holder]"))
    return false;
  if (live && typeof element.checkVisibility === "function")
    return element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  // An inert fetched page has no computed styles.
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    const style = live
      ? window.getComputedStyle(current)
      : (current as HTMLElement).style;
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.opacity === "0"
    )
      return false;
  }
  return true;
}

function visibleGallery(
  root: HTMLElement,
  live: boolean,
): HTMLElement | undefined {
  return [
    ...root.querySelectorAll<HTMLElement>("[data-main-product-media-gallery]"),
  ].find((gallery) => {
    if (gallery.closest("main-product") !== root || !isAvailable(gallery, live))
      return false;
    if (!live || typeof gallery.checkVisibility !== "function") return true;
    const { width, height } = gallery.getBoundingClientRect();
    return width > 0 && height > 0;
  });
}

type ShopifyWindow = Window & { Shopify?: { routes?: { root?: unknown } } };

/** Read only the selected product, even when Roman is open over another page. */
export async function loadVisualizationProductPreparation(
  pageUrl: string,
  signal: AbortSignal,
): Promise<VisualizationPreparation | undefined> {
  const productPath = new URL(pageUrl).pathname;
  const live = currentProductPath() === productPath;
  const pageHref = window.location.href;
  const source = live ? document : await loadProductPageMarkup(pageUrl, signal);
  if (!source) return;
  try {
    const selected = selectedProduct(source, pageUrl);
    if (!selected) return;
    const queryVariant = live
      ? new URL(pageHref).searchParams.get("variant")
      : null;
    if (queryVariant !== null && queryVariant !== selected.variantId) return;

    const locale = (window as ShopifyWindow).Shopify?.routes?.root ?? "/";
    if (typeof locale !== "string" || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(locale))
      return;
    const endpoint = new URL(`${locale}${productPath.slice(1)}.js`, pageUrl);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const response = await fetch(endpoint.href, {
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    const body = await readProductResponseText(response, requestSignal);
    const product = body === undefined ? undefined : record(JSON.parse(body));
    const baseTitle = title(product?.title, 500);
    if (
      !baseTitle ||
      !shopifyId(product?.id) ||
      !Array.isArray(product?.variants)
    )
      return;
    const variants = product.variants.map(record);
    const ids = variants.map((variant) => shopifyId(variant?.id));
    const variantTitles = variants.map((variant) => title(variant?.title, 200));
    if (
      ids.some((id) => !id) ||
      new Set(ids).size !== ids.length ||
      variantTitles.some((value) => !value)
    )
      return;
    const variantIndex = ids.indexOf(selected.variantId);
    const variant = variants[variantIndex];
    const variantTitle = variantTitles[variantIndex];
    if (!variant || !variantTitle) return;
    const productTitle =
      variantTitle === "Default Title" ||
      baseTitle.toLocaleLowerCase().includes(variantTitle.toLocaleLowerCase())
        ? baseTitle
        : `${baseTitle} — ${variantTitle}`;
    if (productTitle.length > 500) return;

    const current = selectedProduct(source, pageUrl);
    if (
      current?.root !== selected.root ||
      current?.variantId !== selected.variantId ||
      (live && window.location.href !== pageHref)
    )
      return;
    const gallery = visibleGallery(selected.root, live);
    if (!gallery) return;

    const mediaAlts = new Map<string, string>();
    const referenceUrl = (value: unknown) => {
      if (typeof value !== "string" || /\s/.test(value)) return;
      const href = productMediaUrl(value, pageUrl);
      if (!href) return;
      const url = new URL(href);
      if (isShopifyProductAssetPath(url)) return url;
    };
    if (Array.isArray(product.media)) {
      for (const entry of product.media) {
        const media = record(entry);
        if (media?.media_type !== "image" || typeof media.alt !== "string")
          continue;
        const src = referenceUrl(media.src);
        if (src && media.alt.trim()) mediaAlts.set(src.href, media.alt);
      }
    }
    const candidates = new Map<string, ReferenceCandidate>();
    const add = (url: URL | undefined, galleryAlt?: string) => {
      if (!url) return;
      const file = url.pathname.split("/").at(-1)?.toLowerCase() ?? "";
      if (
        NON_PRODUCT.test(file) ||
        file.startsWith("ndhr_") ||
        (galleryAlt && NON_PRODUCT.test(galleryAlt))
      )
        return;
      const previous = candidates.get(file);
      const alt = galleryAlt || mediaAlts.get(url.href);
      if (!previous) candidates.set(file, { url: url.href, alt });
      else if (alt && (galleryAlt || !previous.alt))
        candidates.set(file, { ...previous, alt });
    };

    add(
      referenceUrl(
        record(variant.featured_image)?.src ?? variant.featured_image,
      ),
    );
    for (const image of gallery.querySelectorAll<HTMLImageElement>(
      "img[src]",
    )) {
      const src = image.getAttribute("src");
      if (
        !src ||
        image.closest("main-product") !== selected.root ||
        image.hasAttribute("data-feature-option-slide-image") ||
        !isAvailable(image, live)
      )
        continue;
      const declaredUrl = referenceUrl(src);
      const currentUrl = referenceUrl(image.currentSrc);
      // The browser can retain the previous variant's currentSrc while a changed src loads.
      add(
        currentUrl && currentUrl.pathname === declaredUrl?.pathname
          ? currentUrl
          : declaredUrl,
        image.alt,
      );
    }
    if (variants.length === 1 && Array.isArray(product.images))
      for (const value of product.images) add(referenceUrl(value));
    return {
      productPath,
      productTitle,
      references: selectVisualizationProductReferences([
        ...candidates.values(),
      ]),
    };
  } catch {
    signal.throwIfAborted();
    return;
  }
}
