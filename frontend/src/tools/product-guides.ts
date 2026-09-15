import {
  parseProductGuidesCall,
  parseProductGuideUrl,
  parseProductGuidesResult,
  PRODUCT_GUIDE_LABELS,
  type ProductGuide,
  type ProductGuideKind,
  type ProductGuidesResult,
} from "../../../shared/product-guides";

const sections: Record<ProductGuideKind, string> = {
  measuring: "#Details-measuring",
  fitting: "#Details-installing",
};

/** Read only the current product's own guide anchors, never generic site links. */
export async function getProductGuides(
  productPath: string,
  signal: AbortSignal,
): Promise<ProductGuidesResult> {
  signal.throwIfAborted();
  parseProductGuidesCall({ productPath });
  const guides: ProductGuide[] = [];
  const unavailable: ProductGuidesResult = {
    status: "unavailable",
    productPath,
    guides,
  };
  const current =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i.exec(
      window.location.pathname,
    );
  if (
    !current ||
    `/products/${current[1]}` !== productPath ||
    !document.body.classList.contains("template-product")
  )
    return unavailable;
  const roots = document.querySelectorAll(
    "app-provider > main#main product-accordions",
  );
  if (roots.length !== 1) return unavailable;
  for (const kind of ["measuring", "fitting"] as const) {
    const anchors = [
      ...roots[0].querySelectorAll<HTMLAnchorElement>(
        `${sections[kind]} a[href]`,
      ),
    ].filter(
      (anchor) =>
        anchor.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ===
        PRODUCT_GUIDE_LABELS[kind].toLowerCase(),
    );
    // Never guess which link is authoritative when a section has duplicates.
    if (anchors.length !== 1) continue;
    try {
      guides.push({
        kind,
        url: parseProductGuideUrl(
          anchors[0].getAttribute("href"),
          window.location.origin,
        ),
      });
    } catch {
      // An unsupported URL is missing evidence, not permission to use a fallback.
    }
  }
  signal.throwIfAborted();
  return parseProductGuidesResult(
    { status: guides.length ? "found" : "unavailable", productPath, guides },
    window.location.origin,
  );
}
