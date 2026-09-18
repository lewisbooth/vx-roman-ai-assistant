const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 5000;

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

export function readProductMainImage(
  source: ParentNode,
  pageUrl: string,
  maxWidth = 480,
): string | undefined {
  const roots = source.querySelectorAll("app-provider > main#main");
  if (roots.length !== 1) return;
  // These are the theme's initial PDP galleries, not swatches, zoom views,
  // recommendation cards or the catalog's separate listing featured image.
  const galleries = roots[0].querySelectorAll(
    '[data-main-product-media-gallery] swiper-container[id$="-main-swiper-initial"]',
  );
  const images = new Set<string>();
  for (const gallery of galleries) {
    const image = gallery.querySelector<HTMLImageElement>(
      'img[data-testid="pdp-product-image-main"]',
    );
    const src = image?.getAttribute("src");
    if (!src || src.length > 2048) continue;
    try {
      // Resolve against the requested page, never remote <base> markup.
      const url = new URL(src, pageUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !(
          (url.origin === window.location.origin &&
            url.pathname.startsWith("/cdn/shop/")) ||
          (url.origin === "https://cdn.shopify.com" &&
            url.pathname.startsWith("/s/files/"))
        )
      )
        continue;
      images.add(url.href);
    } catch {
      // Unsupported media leaves the existing catalog image in place.
    }
  }
  // Responsive copies agree on the first image. Do not choose between
  // conflicting product galleries or infer a URL from an image filename.
  if (images.size !== 1) return;
  const selected = new URL([...images][0]);
  const widths = selected.searchParams.getAll("width");
  // The theme already uses Shopify's width transform. Keep that exact asset
  // and version while avoiding a full PDP-sized download for a 176px card.
  if (
    widths.length === 1 &&
    /^\d+$/.test(widths[0]) &&
    Number(widths[0]) > maxWidth
  )
    selected.searchParams.set("width", String(maxWidth));
  return selected.href;
}

/** Resolve the theme's first product image; never execute fetched page assets. */
export async function loadProductPageImage(
  input: string,
  signal: AbortSignal,
  maxWidth: 480 | 1200 = 480,
): Promise<string | undefined> {
  const pageUrl = productImagePageUrl(input);
  signal.throwIfAborted();
  const current =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?(\/products\/[^/]+)\/?$/i.exec(
      window.location.pathname,
    );
  if (current?.[1] === new URL(pageUrl).pathname) {
    const image = readProductMainImage(document, pageUrl, maxWidth);
    if (image) return image;
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
    return readProductMainImage(template.content, pageUrl, maxWidth);
  } catch {
    signal.throwIfAborted();
    // A display-only timeout/unavailable PDP must not hide its catalog card.
    return;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
