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

const headings: Record<ProductGuideKind, RegExp> = {
  measuring: /^(?:measuring guide|measuring for .+)$/i,
  fitting: /^(?:easy )?(?:fitting|installation) guide$/i,
};

function label(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** null means absent; an empty list means present but not safely selectable. */
function primaryGuideAnchors(
  root: Element,
  kind: ProductGuideKind,
): HTMLAnchorElement[] | null {
  const panels = [...root.querySelectorAll('[role="region"][aria-labelledby]')]
    .filter((region) => region.closest("main-product") === root)
    .map((region) => {
      const ids = region.getAttribute("aria-labelledby")!.trim().split(/\s+/);
      // Resolve only inside this accordion, never another page section's title.
      const titles = [...region.parentElement!.querySelectorAll("h2[id]")].filter(
        (title) =>
          ids.includes(title.id) &&
          !region.contains(title) &&
          title.closest("main-product") === root,
      );
      return { region, titles, ids };
    })
    .filter(({ titles }) =>
      titles.some((title) => headings[kind].test(label(title))),
    );
  if (!panels.length) return null;
  if (panels.length !== 1) return [];
  const { region, titles, ids } = panels[0];
  if (titles.length !== 1 || ids.length !== 1) return [];
  return [...region.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(
    (anchor) =>
      anchor.closest("main-product") === root &&
      anchor.closest('[role="region"]') === region &&
      ["download guide", PRODUCT_GUIDE_LABELS[kind].toLowerCase()].includes(
        label(anchor).toLowerCase(),
      ),
  );
}

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
  // The theme also renders main-product inside recommendation/search cards.
  // Only the URL-owning PDP component can supply this page's guide sections.
  const primaryRoots = document.querySelectorAll(
    'app-provider > main#main main-product[update-url="true"]:not([data-product-card]):not([section-id="product-card"])',
  );
  if (
    primaryRoots.length > 1 ||
    (primaryRoots.length === 1 &&
      primaryRoots[0].getAttribute("product-url") !== productPath)
  )
    return unavailable;
  const legacyRoots = document.querySelectorAll(
    "app-provider > main#main product-accordions",
  );
  for (const kind of ["measuring", "fitting"] as const) {
    let anchors = primaryRoots.length
      ? primaryGuideAnchors(primaryRoots[0], kind)
      : null;
    // Some themes still expose only the separate product-accordions controls.
    // Fall back only when the primary kind is absent, never when it is invalid.
    if (anchors === null && legacyRoots.length === 1)
      anchors = [
        ...legacyRoots[0].querySelectorAll<HTMLAnchorElement>(
          `${sections[kind]} a[href]`,
        ),
      ].filter(
        (anchor) =>
          label(anchor).toLowerCase() === PRODUCT_GUIDE_LABELS[kind].toLowerCase(),
      );
    // Never guess which link is authoritative when a section has duplicates.
    if (anchors?.length !== 1) continue;
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
