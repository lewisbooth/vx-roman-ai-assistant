import { useEffect, useState, useSyncExternalStore } from "react";
import type { StorefrontNavigation } from "../navigation/shared";
import { storefrontPageTitle } from "../session/page-title";
import { readProductConfigurationDisplay } from "../tools/product-configuration";
import { isCurrentProduct } from "../tools/product-controls";
import { readProductMainImage } from "../tools/product-image";

function productPath(url: string): string | undefined {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return;
    return /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?(\/products\/[a-z0-9][a-z0-9-]*)\/?$/i.exec(
      parsed.pathname,
    )?.[1];
  } catch {
    return;
  }
}

type ProductStageState = {
  path: string;
  title: string;
  image?: string;
  configuration: ReturnType<typeof readProductConfigurationDisplay>;
};

function readProductStage(path: string): ProductStageState | null {
  if (!isCurrentProduct(path)) return null;
  return {
    path,
    title: storefrontPageTitle(path),
    image: readProductMainImage(document, window.location.href, 1200),
    configuration: readProductConfigurationDisplay(path),
  };
}

/** A display of the live theme, with no separate product/cart state or requests. */
export function ProductStage({
  navigation,
}: {
  navigation: StorefrontNavigation;
}) {
  const page = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const path = productPath(page.url);
  const [product, setProduct] = useState<ProductStageState | null>(null);
  const [failedImage, setFailedImage] = useState<string>();

  useEffect(() => {
    // Keep the preceding product visible while navigation resolves. It cannot
    // supply an active quote until the new page and its theme controls settle.
    if (page.pending) return;
    if (!path) {
      setProduct(null);
      return;
    }
    let disposed = false;
    let frame: number | undefined;
    let last = "";
    const read = () => {
      frame = undefined;
      if (disposed) return;
      let next: ProductStageState | null = null;
      try {
        next = readProductStage(path);
      } catch {
        // An unsupported/replacing theme must not take down the conversation.
      }
      const fingerprint = JSON.stringify(next);
      if (last !== fingerprint) {
        last = fingerprint;
        setProduct(next);
      }
    };
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(read);
    };
    read();
    const main = document.querySelector("app-provider > main#main");
    if (!main) return;
    // Native input properties need events; asynchronous price/option/gallery
    // rendering needs mutations. One frame coalesces a burst of theme updates.
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) => {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          return (
            record.type === "childList" ||
            !!element?.closest(
              "dynamic-pricing,h1,[data-main-product-media-gallery]",
            )
          );
        })
      )
        schedule();
    });
    observer.observe(main, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "hidden",
        "disabled",
        "checked",
        "selected",
        "value",
        "aria-disabled",
        "aria-hidden",
        "data-screen-disabled",
        "active",
        "data-active-input-measurement",
        "src",
      ],
    });
    main.addEventListener("input", schedule);
    main.addEventListener("change", schedule);
    return () => {
      disposed = true;
      observer.disconnect();
      main.removeEventListener("input", schedule);
      main.removeEventListener("change", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [path, page.url, page.pending]);

  if (!product || (!page.pending && product.path !== path)) return null;
  const configuration = page.pending ? null : product.configuration;
  const measurements = configuration?.measurements;
  const selected =
    configuration?.controls.flatMap((control) =>
      control.options
        .filter((option) => option.selected && option.available)
        .map((option) => ({
          key: control.id,
          label: control.label,
          value: option.label,
          separatePrice:
            control.purpose === "measurement_guarantee"
              ? option.priceLabel
              : undefined,
        })),
    ) ?? [];
  const image = product.image !== failedImage ? product.image : undefined;

  return (
    <aside
      className="roman-product-stage"
      aria-label="Your selected product"
      aria-busy={page.pending}
    >
      <div className="roman-product-stage-image">
        {image ? (
          <img
            src={image}
            alt={product.title}
            onError={() => setFailedImage(image)}
          />
        ) : (
          <span className="roman-product-stage-placeholder">
            Your selection
          </span>
        )}
        {page.pending && (
          <p className="roman-product-stage-loading" role="status">
            Opening your next page…
          </p>
        )}
      </div>
      <div className="roman-product-stage-content">
        <p className="roman-product-stage-eyebrow">
          {page.pending ? "Previously selected" : "Your selection"}
        </p>
        <h2>{product.title}</h2>
        {configuration?.configuredPrice && (
          <p className="roman-product-stage-price">
            <span>{configuration.configuredPrice}</span> Current product quote
          </p>
        )}
        {measurements?.unit &&
          measurements.width !== null &&
          measurements.height !== null && (
            <p className="roman-product-stage-measurements">
              {measurements.width} × {measurements.height} {measurements.unit}
              <span> Width × drop</span>
            </p>
          )}
        {selected.length > 0 && (
          <details className="roman-product-stage-configuration">
            <summary>
              Your configuration{" "}
              <span>
                {selected.length} {selected.length === 1 ? "option" : "options"}
              </span>
            </summary>
            <dl>
              {selected.map((option) => (
                <div key={option.key}>
                  <dt>{option.label}</dt>
                  <dd>
                    {option.value}
                    {option.separatePrice && (
                      <span> ({option.separatePrice}, charged separately)</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </aside>
  );
}
