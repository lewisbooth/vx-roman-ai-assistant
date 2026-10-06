import {
  parseCheckoutCall,
  parseCheckoutResult,
  type CheckoutResult,
} from "../../../shared/checkout";
import { storefrontPageTitle } from "./page-title";
import {
  normalizeCatalogResult,
  parseCatalogResult,
  assertCatalogQueryProvenance,
  type CatalogMessage,
  type CatalogProduct,
  type CatalogResult,
} from "../../../shared/catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import {
  parseViewCall,
  parseViewResult,
  type ViewResult,
} from "../../../shared/assistant-view";
import type { CatalogToolName } from "../../../shared/conversation";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../../shared/navigation-tool";
import type { AssistantTools } from "../tools";
import { isSampleAvailable } from "../tools/product-sample";
import {
  parseProductGuidesCall,
  parseProductGuidesResult,
  type ProductGuidesResult,
} from "../../../shared/product-guides";
import {
  parseGuideLibraryCall,
  parseGuideLibraryResult,
  type GuideLibraryResult,
} from "../../../shared/guide-library";
import {
  parseStoreSupportCall,
  parseStoreSupportResult,
  type StoreSupportResult,
} from "../../../shared/store-support";
import {
  parseCartCall,
  parseCartResult,
  type CartToolResult,
} from "../../../shared/cart-tools";
import {
  isProductConfigurationTool,
  parseProductConfigurationCall,
  parseProductConfigurationResult,
  type ProductConfigurationResult,
} from "../../../shared/product-configuration";
import {
  parseApplyMeasurementsCommand,
  parseApplyMeasurementsResult,
  type ApplyMeasurementsResult,
} from "../../../shared/measurements";
import { applyMeasurements } from "../tools/measurements";
import {
  loadProductPageGallery,
  productImagePageUrl,
  productImageWidth,
  type ProductGallerySnapshot,
} from "../tools/product-image";
import { inspectConfiguredProduct } from "../tools/product";
import { selectVisualizationProductReferences } from "../tools/product-references";
import type { VisualizationPreparation } from "../../../shared/visualizations";

export type BrowserToolResult =
  | CatalogResult
  | NavigationResult
  | ViewResult
  | CheckoutResult
  | CartToolResult
  | ProductConfigurationResult
  | ApplyMeasurementsResult
  | ProductGuidesResult
  | GuideLibraryResult
  | StoreSupportResult;

const DISPLAY_CACHE_MS = 60_000;
const MAX_DISPLAY_PRODUCTS = 60;
const MAX_FOREGROUND_JOBS = 12;
// Bound queued image work; visibility normally keeps this much lower.
const MAX_DISPLAY_JOBS = 40;
const MAX_IMAGE_JOBS = 12;

interface StorefrontJob {
  kind: "foreground" | "display" | "image";
  operation(signal: AbortSignal): Promise<unknown>;
  controller?: AbortController;
  preempted: boolean;
  cancelled: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

// Only card hydration reuses recent public products. Model tools always fetch
// Shopify, and all network work shares the theme owner's single-flight queue.
export function createStorefrontExecutor(
  tools: Pick<AssistantTools, "execute">,
) {
  const jobs = new Set<StorefrontJob>();
  const foreground: StorefrontJob[] = [];
  const display: StorefrontJob[] = [];
  const images: StorefrontJob[] = [];
  let active: StorefrontJob | undefined;
  let disposed = false;
  const storefrontOrigin = window.location.origin;
  const displayProducts = new Map<
    string,
    { product: CatalogProduct; messages: CatalogMessage[]; expiresAt: number }
  >();
  const productGalleries = new Map<
    string,
    { gallery: ProductGallerySnapshot | undefined; expiresAt: number }
  >();

  function requireCurrentStore() {
    if (disposed) throw new Error("Roman has been removed.");
    if (window.location.origin !== storefrontOrigin)
      throw new Error("Roman's storefront changed. Refresh before continuing.");
  }

  function rememberProducts(result: CatalogResult) {
    const now = Date.now();
    for (const [id, entry] of displayProducts)
      if (entry.expiresAt <= now) displayProducts.delete(id);
    for (const product of result.products) {
      displayProducts.delete(product.id);
      displayProducts.set(product.id, {
        product: { ...product },
        messages: result.messages.map((message) => ({ ...message })),
        expiresAt: now + DISPLAY_CACHE_MS,
      });
    }
    for (const id of displayProducts.keys()) {
      if (displayProducts.size <= MAX_DISPLAY_PRODUCTS) break;
      displayProducts.delete(id);
    }
  }

  function displaySelection(ids: readonly string[]) {
    const now = Date.now();
    const products = new Map<string, CatalogProduct>();
    const messages = new Map<string, CatalogMessage>();
    const missing: string[] = [];
    for (const id of ids) {
      const entry = displayProducts.get(id);
      if (entry && entry.expiresAt > now) {
        products.set(id, { ...entry.product });
        for (const message of entry.messages)
          messages.set(JSON.stringify(message), { ...message });
      } else missing.push(id);
    }
    return { products, messages, missing };
  }

  function pump() {
    if (active || disposed) return;
    const job = foreground.shift() ?? display.shift() ?? images.shift();
    if (!job) return;
    active = job;
    job.preempted = false;
    const controller = new AbortController();
    job.controller = controller;
    void Promise.resolve()
      .then(() => {
        requireCurrentStore();
        controller.signal.throwIfAborted();
        return job.operation(controller.signal);
      })
      .then((value) => {
        controller.signal.throwIfAborted();
        job.resolve(value);
      })
      .catch((error) => {
        if (job.preempted && !job.cancelled && !disposed)
          (job.kind === "image" ? images : display).unshift(job);
        else job.reject(error);
      })
      .finally(() => {
        if (!job.preempted || job.cancelled || disposed) {
          jobs.delete(job);
          job.cleanup();
        }
        active = undefined;
        pump();
      });
  }

  function enqueue<T>(
    kind: StorefrontJob["kind"],
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const limit =
      kind === "foreground"
        ? MAX_FOREGROUND_JOBS
        : kind === "image"
          ? MAX_IMAGE_JOBS
          : MAX_DISPLAY_JOBS;
    if (
      disposed ||
      [...jobs].filter((job) => job.kind === kind).length >= limit
    )
      return Promise.reject(
        new Error(
          "Please wait for the current storefront tools, then try again.",
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const queue =
        kind === "foreground"
          ? foreground
          : kind === "image"
            ? images
            : display;
      const job: StorefrontJob = {
        kind,
        operation,
        preempted: false,
        cancelled: false,
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      const cancel = () => {
        job.cancelled = true;
        job.controller?.abort(signal?.reason);
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
        jobs.delete(job);
        job.cleanup();
        reject(
          signal?.reason ??
            new DOMException("Product loading cancelled", "AbortError"),
        );
      };
      jobs.add(job);
      queue.push(job);
      signal?.addEventListener("abort", cancel, { once: true });
      // Read-only images also yield to card hydration. No visible carousel or
      // foreground action waits for decorative PDP fetching to finish.
      if (
        (kind === "foreground" && active?.kind === "display") ||
        (kind !== "image" && active?.kind === "image")
      ) {
        active.preempted = true;
        active.controller?.abort(
          new DOMException("Display loading yielded to a tool", "AbortError"),
        );
      }
      pump();
    });
  }

  function catalogGallery(pageUrl: string): ProductGallerySnapshot | undefined {
    const now = Date.now();
    for (const { product, expiresAt } of displayProducts.values()) {
      if (expiresAt <= now || product.url !== pageUrl || !product.imageUrl)
        continue;
      return {
        productPath: new URL(pageUrl).pathname,
        items: [
          {
            id: `product:${product.imageUrl}`,
            src: product.imageUrl,
            thumbnailSrc: product.imageUrl,
            zoomSrc: product.imageUrl,
            alt: product.title,
            kind: "product",
          },
        ],
      };
    }
  }

  async function loadProductGallery(url: string, signal: AbortSignal) {
    requireCurrentStore();
    signal.throwIfAborted();
    const pageUrl = productImagePageUrl(url);
    const cached = productGalleries.get(pageUrl);
    if (cached && cached.expiresAt > Date.now())
      return cached.gallery ?? catalogGallery(pageUrl);
    return enqueue("image", (signal) => loadGalleryNow(pageUrl, signal), signal);
  }

  // Runs inside the owner's existing operation. Never enqueue recursively.
  async function loadGalleryNow(pageUrl: string, signal: AbortSignal) {
        const cached = productGalleries.get(pageUrl);
        if (cached && cached.expiresAt > Date.now())
          return cached.gallery ?? catalogGallery(pageUrl);
        const gallery = await loadProductPageGallery(pageUrl, signal);
        requireCurrentStore();
        signal.throwIfAborted();
        const now = Date.now();
        for (const [url, entry] of productGalleries)
          if (entry.expiresAt <= now) productGalleries.delete(url);
        productGalleries.delete(pageUrl);
        // Cache product media once for cards and the stage. Native feature imagery
        // belongs to the stage's live configuration snapshot, not a path-only cache.
        productGalleries.set(pageUrl, {
          gallery: gallery && {
            ...gallery,
            items: gallery.items.filter((item) => item.kind === "product"),
          },
          expiresAt: now + DISPLAY_CACHE_MS,
        });
        for (const url of productGalleries.keys()) {
          if (productGalleries.size <= MAX_DISPLAY_PRODUCTS) break;
          productGalleries.delete(url);
        }
        return gallery ?? catalogGallery(pageUrl);
  }

  function prepareVisualizationProduct(path: string, signal: AbortSignal): Promise<VisualizationPreparation> {
    const pageUrl = productImagePageUrl(path);
    return enqueue("foreground", async (signal) => {
      requireCurrentStore();
      const gallery = await loadGalleryNow(pageUrl, signal);
      const references = selectVisualizationProductReferences(gallery?.items ?? []);
      if (!references.length) throw new Error("This blind has no usable product images.");
      return { productPath: new URL(pageUrl).pathname, references };
    }, signal);
  }

  async function fetchCatalog(
    call: ReturnType<typeof parseCatalogCall>,
    signal?: AbortSignal,
  ): Promise<CatalogResult> {
    // A fresh targeted lookup supersedes earlier display data, including when
    // the requested product is now missing. Never substitute cached tool data.
    if (call.name === "get_product")
      displayProducts.delete(call.arguments.id as string);
    else if (call.name === "lookup_catalog")
      for (const id of call.arguments.ids as string[])
        displayProducts.delete(id);
    const raw = await tools.execute(call.name, call.arguments, signal);
    requireCurrentStore();
    signal?.throwIfAborted();
    try {
      const result =
        call.name === "search_products"
          ? parseCatalogResult(raw, storefrontOrigin)
          : normalizeCatalogResult(raw, storefrontOrigin);
      if (call.name === "search_products")
        assertCatalogQueryProvenance(
          result,
          call.arguments.queries as string[],
        );
      rememberProducts(result);
      return result;
    } catch (error) {
      // Validation diagnostics contain controlled field paths, not catalog data.
      console.warn("[Roman] Catalog response rejected.", {
        tool: call.name,
        reason:
          error instanceof Error ? error.message : "Invalid catalog data.",
      });
      throw error;
    }
  }

  function execute(
    name: CatalogToolName,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CatalogResult>;
  function execute(
    name: "navigate",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<NavigationResult>;
  function execute(
    name: "open_checkout",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CheckoutResult>;
  function execute(
    name: "show_view",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ViewResult>;
  function execute(
    name:
      | "get_cart"
      | "add_to_cart"
      | "add_sample_to_cart"
      | "remove_from_cart"
      | "set_cart_quantity"
      | "clear_cart",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CartToolResult>;
  function execute(
    name: "get_product_configuration" | "configure_product",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProductConfigurationResult>;
  function execute(
    name: "get_product_guides" | "discover_guides" | "get_store_support",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProductGuidesResult | GuideLibraryResult | StoreSupportResult>;
  function execute(
    name: "apply_measurements",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ApplyMeasurementsResult>;
  function execute(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<BrowserToolResult> {
    if (name === "open_checkout") {
      const call = parseCheckoutCall(input);
      return enqueue(
        "foreground",
        async (signal) => {
          requireCurrentStore();
          signal.throwIfAborted();
          return parseCheckoutResult(await tools.execute(name, call, signal));
        },
        signal,
      );
    }
    if (name === "show_view") {
      const call = parseViewCall(input);
      return enqueue(
        "foreground",
        async (signal) => {
          const result = parseViewResult(
            await tools.execute(name, call, signal),
          );
          requireCurrentStore();
          signal.throwIfAborted();
          if (result.view !== call.view)
            throw new Error("The browser showed a different Roman view.");
          return result;
        },
        signal,
      );
    }
    if (name === "discover_guides") {
      const call = parseGuideLibraryCall(input);
      return enqueue(
        "foreground",
        async (signal) => {
          const raw = await tools.execute(name, call, signal);
          requireCurrentStore();
          signal.throwIfAborted();
          const result = parseGuideLibraryResult(raw, storefrontOrigin);
          if (result.library !== call.library)
            throw new Error(
              "The storefront returned a different guide library.",
            );
          return result;
        },
        signal,
      );
    }
    if (name === "get_store_support") {
      const call = parseStoreSupportCall(input);
      return enqueue(
        "foreground",
        async (signal) => {
          const raw = await tools.execute(name, call, signal);
          requireCurrentStore();
          signal.throwIfAborted();
          return parseStoreSupportResult(raw, storefrontOrigin);
        },
        signal,
      );
    }
    if (name === "apply_measurements") {
      const command = parseApplyMeasurementsCommand(input);
      return enqueue(
        "foreground",
        async (signal) => {
          // Apply and capture fresh controls within the same foreground slot.
          const result = await applyMeasurements(command.draft, signal);
          if (result.status !== "applied") return parseApplyMeasurementsResult(result);
          requireCurrentStore();
          signal.throwIfAborted();
          const configuration = parseProductConfigurationResult(
            "get_product_configuration",
            await tools.execute("get_product_configuration", { productPath: command.productPath }, signal),
          );
          requireCurrentStore();
          signal.throwIfAborted();
          if (configuration.status === "available" && (
            configuration.measurements?.width !== command.draft.width ||
            configuration.measurements?.height !== command.draft.height ||
            configuration.measurements?.unit !== command.draft.unit
          ))
            return parseApplyMeasurementsResult({
              ...result, status: "uncertain",
              message: "The native measurements changed during configuration readback. Do not replay the application or add this blind until the current values are resolved.",
            });
          return parseApplyMeasurementsResult({ ...result, configuration });
        },
        signal,
      );
    }
    if (name === "get_product_guides") {
      const call = parseProductGuidesCall(input);
      return enqueue(
        "foreground",
        async (signal) => {
          const raw = await tools.execute(name, call, signal);
          requireCurrentStore();
          signal.throwIfAborted();
          const result = parseProductGuidesResult(raw, storefrontOrigin);
          if (result.productPath !== call.productPath)
            throw new Error(
              "The storefront returned guides for a different product.",
            );
          return result;
        },
        signal,
      );
    }
    if (name === "get_cart") {
      const call = parseCartCall(name, input);
      return enqueue(
        "foreground",
        async (signal) =>
          parseCartResult(
            call.name,
            await tools.execute(call.name, call.arguments, signal),
          ),
        signal,
      );
    }
    if (name === "add_to_cart") {
      const call = parseCartCall(name, input);
      return enqueue(
        "foreground",
        async (signal) => {
          // Check after queue admission; the shopper may have changed pages.
          inspectConfiguredProduct(call.arguments.productPath as string);
          signal.throwIfAborted();
          return parseCartResult(
            call.name,
            await tools.execute(
              call.name,
              { quantity: call.arguments.quantity },
              signal,
            ),
          );
        },
        signal,
      );
    }
    if (
      name === "add_sample_to_cart" ||
      name === "remove_from_cart" ||
      name === "set_cart_quantity" ||
      name === "clear_cart"
    ) {
      const call = parseCartCall(name, input);
      return enqueue(
        "foreground",
        async (signal) => {
          signal.throwIfAborted();
          // Removal's owner validates the full key set, then serializes native
          // theme actions with fresh cart/control checks inside this operation.
          return parseCartResult(
            call.name,
            await tools.execute(call.name, call.arguments, signal),
          );
        },
        signal,
      );
    }
    if (isProductConfigurationTool(name)) {
      const call = parseProductConfigurationCall(name, input);
      return enqueue(
        "foreground",
        async (signal) => {
          const result = parseProductConfigurationResult(
            call.name,
            await tools.execute(call.name, call.arguments, signal),
          );
          if (result.productPath !== call.arguments.productPath)
            throw new Error(
              "The storefront returned choices for a different product.",
            );
          return result;
        },
        signal,
      );
    }
    const call =
      name === "navigate"
        ? { name: "navigate" as const, arguments: parseNavigationCall(input) }
        : parseCatalogCall(name, input);
    return enqueue(
      "foreground",
      async (signal) => {
        signal?.throwIfAborted();
        if (call.name !== "navigate") return fetchCatalog(call, signal);
        const raw = await tools.execute(call.name, call.arguments, signal, {
          navigationSource: "model",
        });
        requireCurrentStore();
        signal?.throwIfAborted();
        if (
          !raw ||
          typeof raw !== "object" ||
          !("url" in raw) ||
          typeof raw.url !== "string" ||
          !("pending" in raw) ||
          raw.pending !== false ||
          !("status" in raw) ||
          raw.status !== "navigated"
        )
          throw new Error(
            "Storefront navigation did not finish. Check the page before trying again.",
          );
        let url: URL;
        try {
          url = new URL(raw.url);
        } catch {
          throw new Error(
            "Storefront navigation returned an invalid page URL.",
          );
        }
        if (
          url.origin !== window.location.origin ||
          url.username ||
          url.password ||
          url.href !== window.location.href
        )
          throw new Error(
            "Storefront navigation did not finish. Check the page before trying again.",
          );
        const { path } = parseNavigationCall({
          path: `${url.pathname}${url.search}${url.hash}`,
        });
        let sampleAvailable = false;
        if (
          /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/[^/?#]+\/?(?:\?variant=\d+)?$/i.test(
            path,
          )
        )
          sampleAvailable = isSampleAvailable(path.split("?", 1)[0]);
        return {
          status: "navigated" as const,
          path,
          title: storefrontPageTitle(url.pathname),
          ...(path.includes("/products/")
            ? { actions: { sampleAvailable } }
            : {}),
        };
      },
      signal,
    );
  }
  return {
    execute,
    getCachedProducts(ids: readonly string[]): CatalogProduct[] {
      if (disposed || window.location.origin !== storefrontOrigin) return [];
      return [...displaySelection(ids).products.values()];
    },
    async loadProducts(
      ids: readonly string[],
      signal?: AbortSignal,
    ): Promise<CatalogResult> {
      requireCurrentStore();
      signal?.throwIfAborted();
      const call = parseCatalogCall("lookup_catalog", { ids: [...ids] });
      const selectedIds = call.arguments.ids as string[];
      const cached = displaySelection(selectedIds);
      if (!cached.missing.length)
        return {
          products: [...cached.products.values()],
          messages: [...cached.messages.values()],
        };
      return enqueue(
        "display",
        async (signal) => {
          // Earlier queued work may have fetched these products while we waited.
          const { products, messages, missing } = displaySelection(selectedIds);
          if (missing.length) {
            const fresh = await fetchCatalog(
              parseCatalogCall("lookup_catalog", { ids: missing }),
              signal,
            );
            for (const product of fresh.products)
              if (missing.includes(product.id))
                products.set(product.id, product);
            for (const message of fresh.messages)
              messages.set(JSON.stringify(message), message);
          }
          return {
            products: selectedIds.flatMap((id) => products.get(id) ?? []),
            messages: [...messages.values()],
          };
        },
        signal,
      );
    },
    async loadProductImage(
      url: string,
      signal: AbortSignal,
      maxWidth: 480 | 1200 = 480,
    ) {
      const gallery = await loadProductGallery(url, signal);
      const image = gallery?.items.find((item) => item.kind === "product");
      return image && productImageWidth(image.src, maxWidth);
    },
    loadProductGallery,
    prepareVisualizationProduct,
    dispose() {
      disposed = true;
      for (const job of jobs) {
        job.cancelled = true;
        job.controller?.abort();
        job.cleanup();
        job.reject(new Error("Roman has been removed."));
      }
      jobs.clear();
      foreground.length = 0;
      display.length = 0;
      images.length = 0;
      displayProducts.clear();
      productGalleries.clear();
    },
  };
}
