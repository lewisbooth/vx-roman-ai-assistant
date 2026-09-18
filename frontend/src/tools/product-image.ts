const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 5000;
const MAX_GALLERY_IMAGES = 24;

export interface ProductGalleryImage {
  id: string;
  src: string;
  thumbnailSrc: string;
  zoomSrc: string;
  alt: string;
  width?: number;
  height?: number;
  kind: "product" | "feature";
}

export interface ProductGallerySnapshot {
  productPath: string;
  items: ProductGalleryImage[];
}

export function productImagePageUrl(value: string): string {
  const url = new URL(value, window.location.origin);
  if (
    url.protocol !== "https:" ||
    url.origin !== window.location.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.length > 2048 ||
    !/^\/products\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname)
  )
    throw new Error("Product images require a current-store product page.");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

function mediaUrl(src: string | null, pageUrl: string): string | undefined {
  if (!src || src.length > 2048) return;
  try {
    // Resolve against the requested page, never a fetched <base> element.
    const url = new URL(src, pageUrl);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ((url.origin === window.location.origin &&
        url.pathname.startsWith("/cdn/shop/")) ||
        (url.origin === "https://cdn.shopify.com" &&
          url.pathname.startsWith("/s/files/")))
    )
      return url.href;
  } catch {
    // An invalid display asset never becomes a browser request.
  }
}

/** Reuse Shopify's existing transform without inventing a different asset. */
export function productImageWidth(src: string, maxWidth: number): string {
  const selected = new URL(src);
  const widths = selected.searchParams.getAll("width");
  if (
    widths.length === 1 &&
    /^\d+$/.test(widths[0]) &&
    Number(widths[0]) > maxWidth
  )
    selected.searchParams.set("width", String(maxWidth));
  return selected.href;
}

function assetId(src: string): string {
  const url = new URL(src);
  url.searchParams.delete("width");
  return url.href;
}

function imageWidth(src: string): number {
  const width = Number(new URL(src).searchParams.get("width"));
  return width > 0 ? width : Infinity;
}

/** Theme order and media URLs, without mounting its slider or its scripts. */
export function readProductGallery(
  source: ParentNode,
  pageUrl: string,
): ProductGallerySnapshot | undefined {
  const url = new URL(pageUrl, window.location.origin);
  const productPath = /\/products\/[a-z0-9][a-z0-9-]*\/?$/i
    .exec(url.pathname)?.[0]
    .replace(/\/$/, "");
  if (url.origin !== window.location.origin || !productPath) return;
  const roots = source.querySelectorAll("app-provider > main#main");
  if (roots.length !== 1) return;
  const primary = roots[0].querySelectorAll('main-product[update-url="true"]');
  if (
    primary.length > 1 ||
    (primary.length === 1 &&
      primary[0].getAttribute("product-url") !== productPath)
  )
    return;
  const root = primary[0] ?? roots[0];
  const belongs = (element: Element) => {
    const product = element.closest("main-product");
    return !product || product === root;
  };
  const galleries = [
    ...root.querySelectorAll(
      '[data-main-product-media-gallery] swiper-container[id$="-main-swiper-initial"]',
    ),
  ].filter(belongs);
  let productImages:
    { image: HTMLImageElement; src: string; id: string }[] | undefined;
  const features = new Map<
    string,
    { image: HTMLImageElement; src: string; id: string }
  >();
  for (const gallery of galleries) {
    const images = [
      ...gallery.querySelectorAll<HTMLImageElement>(
        'img[data-testid="pdp-product-image-main"]',
      ),
    ].filter(belongs);
    if (!images.length || images.length > MAX_GALLERY_IMAGES) return;
    const entries = images.map((image) => {
      const src = mediaUrl(image.getAttribute("src"), pageUrl);
      return src ? { image, src, id: assetId(src) } : undefined;
    });
    if (entries.some((entry) => !entry)) return;
    const unique = [
      ...new Map(entries.map((entry) => [entry!.id, entry!])).values(),
    ];
    // Responsive copies must agree on product and order. Zoom/thumb copies
    // supply sizes below, but never add swatches or recommended-product media.
    if (
      productImages &&
      JSON.stringify(productImages.map((e) => e.id)) !==
        JSON.stringify(unique.map((e) => e.id))
    )
      return;
    productImages ??= unique;
    for (const image of gallery.querySelectorAll<HTMLImageElement>(
      "img[data-feature-option-slide-image]",
    )) {
      const holder = image.closest("[data-feature-option-slide-holder]");
      if (
        !holder ||
        holder.matches('[hidden],[aria-hidden="true"],.hidden') ||
        (holder as HTMLElement).style.display === "none"
      )
        continue;
      const src = mediaUrl(image.getAttribute("src"), pageUrl);
      if (src) features.set(assetId(src), { image, src, id: assetId(src) });
    }
  }
  if (!productImages?.length) return;
  const sizes = new Map<string, string[]>();
  for (const image of root.querySelectorAll<HTMLImageElement>(
    "swiper-container img[src]",
  )) {
    if (!belongs(image)) continue;
    const container = image.closest("swiper-container");
    if (!container?.id.match(/-(?:main|thumbs)-swiper-(?:initial|zoom)$/))
      continue;
    const src = mediaUrl(image.getAttribute("src"), pageUrl);
    if (!src) continue;
    const id = assetId(src);
    const choices = sizes.get(id) ?? [];
    choices.push(src);
    sizes.set(id, choices);
  }
  const item = (
    { image, src, id }: (typeof productImages)[number],
    kind: ProductGalleryImage["kind"],
  ): ProductGalleryImage => {
    const choices = sizes.get(id) ?? [src];
    const ordered = [...new Set(choices)].sort(
      (a, b) => imageWidth(a) - imageWidth(b),
    );
    const width = Number(image.getAttribute("width"));
    const height = Number(image.getAttribute("height"));
    return {
      id: `${kind}:${id}`,
      src: productImageWidth(src, 1200),
      thumbnailSrc: productImageWidth(ordered[0], 120),
      zoomSrc: productImageWidth(ordered.at(-1)!, 2000),
      alt: (image.getAttribute("alt") ?? "").trim().slice(0, 500),
      ...(width > 0 && height > 0 ? { width, height } : {}),
      kind,
    };
  };
  return {
    productPath,
    items: [
      // Only an unambiguous, currently enabled native feature slide can lead.
      ...(features.size === 1
        ? [item([...features.values()][0], "feature")]
        : []),
      ...productImages.map((image) => item(image, "product")),
    ],
  };
}

/** Read the selected product independently of the underlying page. */
export async function loadProductPageGallery(
  input: string,
  signal: AbortSignal,
): Promise<ProductGallerySnapshot | undefined> {
  const pageUrl = productImagePageUrl(input);
  signal.throwIfAborted();
  const current =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?(\/products\/[^/]+)\/?$/i.exec(
      window.location.pathname,
    );
  if (current?.[1] === new URL(pageUrl).pathname) {
    const gallery = readProductGallery(document, pageUrl);
    if (gallery) return gallery;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "text/html" },
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/html") ||
      Number(response.headers.get("content-length")) > MAX_PAGE_BYTES ||
      !response.body
    ) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let html = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PAGE_BYTES) {
          await reader.cancel();
          return;
        }
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    // Template contents are inert: scripts/custom elements/resources from the
    // fetched storefront never mount or run while selecting one image URL.
    const template = document.createElement("template");
    template.innerHTML = html;
    const canonical = template.content
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href");
    if (!canonical || productImagePageUrl(canonical) !== pageUrl) return;
    return readProductGallery(template.content, pageUrl);
  } catch {
    signal.throwIfAborted();
    // A display-only timeout/unavailable PDP must not hide its catalog card.
    return;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
