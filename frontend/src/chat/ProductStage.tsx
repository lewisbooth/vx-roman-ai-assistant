import { useEffect, useState, useSyncExternalStore } from "react";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { storefrontPageTitle } from "../session/page-title";
import { readProductConfigurationDisplay } from "../tools/product-configuration";
import { isCurrentProduct } from "../tools/product-controls";
import {
  readProductGallery,
  type ProductGallerySnapshot,
} from "../tools/product-image";
import { ProductStageView } from "./ProductStageView";

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
  gallery?: ProductGallerySnapshot;
  configuration: ReturnType<typeof readProductConfigurationDisplay>;
};

function readProductStage(path: string): ProductStageState | null {
  if (!isCurrentProduct(path)) return null;
  return {
    path,
    title: storefrontPageTitle(path),
    gallery: readProductGallery(document, window.location.href),
    configuration: readProductConfigurationDisplay(path),
  };
}

/** Selected imagery survives background navigation; configuration stays live. */
export function ProductStage({
  navigation,
  session,
  selectedPath,
  selectedTitle,
  hidden = false,
}: {
  navigation: StorefrontNavigation;
  session: Pick<ConversationClient, "loadProductGallery">;
  selectedPath: string;
  selectedTitle: string;
  hidden?: boolean;
}) {
  const page = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  const path = productPath(page.url);
  const [product, setProduct] = useState<ProductStageState | null>(null);
  const [imagery, setImagery] = useState<ProductGallerySnapshot>();

  useEffect(() => {
    // Keep the preceding product visible while navigation resolves. It cannot
    // supply an active quote until the new page and its theme controls settle.
    if (page.pending || hidden) return;
    if (!path || path !== selectedPath) {
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
        if (next?.gallery?.items.length)
          setImagery((previous) =>
            JSON.stringify(previous) === JSON.stringify(next.gallery)
              ? previous
              : next.gallery,
          );
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
        "style",
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
        "srcset",
        "data-src",
        "data-srcset",
        "alt",
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
  }, [path, page.url, page.pending, selectedPath, hidden]);

  useEffect(() => {
    if (hidden || page.pending || imagery?.productPath === selectedPath) return;
    const controller = new AbortController();
    let current = true;
    // Restore a selected blind even when this session opens on the cart or
    // another background page. The existing queue keeps display work optional.
    void Promise.resolve().then(async () => {
      if (!current) return;
      try {
        const gallery = await session.loadProductGallery(
          selectedPath,
          controller.signal,
        );
        if (current && !controller.signal.aborted)
          setImagery((previous) =>
            previous?.productPath === selectedPath && previous.items.length
              ? previous
              : gallery?.productPath === selectedPath
                ? gallery
                : { productPath: selectedPath, items: [] },
          );
      } catch {
        if (current && !controller.signal.aborted)
          setImagery((previous) =>
            previous?.productPath === selectedPath
              ? previous
              : { productPath: selectedPath, items: [] },
          );
      }
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [imagery?.productPath, page.pending, selectedPath, session, hidden]);

  const display = product?.path === selectedPath ? product : null;
  // Selection survives a temporary cart page, but only the matching live PDP
  // can supply a current configuration or price. Never replay settings here.
  const configuration =
    !page.pending && path === selectedPath ? display?.configuration : null;
  const gallery = imagery?.productPath === selectedPath ? imagery.items : [];
  const title = display?.title || selectedTitle;
  return (
    <ProductStageView
      key={selectedPath}
      title={title}
      configuration={configuration ?? null}
      gallery={gallery}
      pending={page.pending}
      hidden={hidden}
    />
  );
}
