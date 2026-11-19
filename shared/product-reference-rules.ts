export function isCatalogueProductDetailFile(file: string): boolean {
  return (
    /_(?:FZ|FabricZoom)(?:_|\.)/i.test(file) ||
    /^PID-\d+_CID-\d+_P\d*(?:_|\.)/i.test(file)
  );
}

/** Catalogue markers shared with VX Visualizer. Plain Z/Zoom stays eligible. */
export function isKnownProductDetailUrl(url: URL): boolean {
  const file = url.pathname.split("/").at(-1) ?? "";
  return (
    isCatalogueProductDetailFile(file) ||
    /(?:^|-)(?:fabric|pleated)-\d+(?:-zoom)?\.(?:jpe?g|png|webp)$/i.test(
      file,
    ) ||
    /-(?:detalle|zoom-bottom)(?:-|\.)/i.test(file) ||
    (url.hostname === "img.selectblindscanada.ca" &&
      /^\/images\/colourization\/[^/]+_a2\.(?:jpe?g|png|webp)$/i.test(
        url.pathname,
      ))
  );
}

/** Path policy for generation references. The caller validates the origin. */
export function isShopifyProductAssetPath(url: URL): boolean {
  const cdn =
    /^\/s\/files\/(?:\d+\/)+(?:files|products)\/[^/]+\.(?:jpe?g|png|webp)$/i;
  const storefront =
    /^\/cdn\/shop\/(?:files|products)\/[^/]+\.(?:jpe?g|png|webp)$/i;
  return (
    (url.hostname === "cdn.shopify.com" ? cdn : storefront).test(
      url.pathname,
    ) && !/(?:%2f|%5c|%00|\\)/i.test(url.pathname)
  );
}
