import {
  normalizeCatalogResult,
  type CatalogMessage,
  type CatalogProduct,
  type CatalogResult,
} from "../../../shared/catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import type { CatalogToolName } from "../../../shared/conversation";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../../shared/navigation-tool";
import type { AssistantTools } from "../tools";

const DISPLAY_CACHE_MS = 60_000;
const MAX_DISPLAY_PRODUCTS = 60;

// Only card hydration reuses recent public products. Model tools always fetch
// Shopify, and all network work shares the theme owner's single-flight queue.
export function createStorefrontExecutor(
  tools: Pick<AssistantTools, "execute">,
) {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let disposed = false;
  const storefrontOrigin = window.location.origin;
  const displayProducts = new Map<
    string,
    { product: CatalogProduct; messages: CatalogMessage[]; expiresAt: number }
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

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (disposed || queued >= 12)
      return Promise.reject(
        new Error(
          "Please wait for the current storefront tools, then try again.",
        ),
      );
    queued++;
    const result = tail
      .then(() => {
        requireCurrentStore();
        return operation();
      })
      .finally(() => {
        queued--;
      });
    tail = result.catch(() => undefined);
    return result;
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
      const result = normalizeCatalogResult(raw, storefrontOrigin);
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
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CatalogResult | NavigationResult> {
    const call =
      name === "navigate"
        ? { name: "navigate" as const, arguments: parseNavigationCall(input) }
        : parseCatalogCall(name, input);
    return enqueue(async () => {
      signal?.throwIfAborted();
      if (call.name !== "navigate") return fetchCatalog(call, signal);
      const raw = await tools.execute(call.name, call.arguments, signal);
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
        throw new Error("Storefront navigation returned an invalid page URL.");
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
      return { status: "navigated" as const, path };
    });
  }
  return {
    execute,
    async loadProducts(ids: readonly string[]): Promise<CatalogResult> {
      requireCurrentStore();
      const call = parseCatalogCall("lookup_catalog", { ids: [...ids] });
      const selectedIds = call.arguments.ids as string[];
      const cached = displaySelection(selectedIds);
      if (!cached.missing.length)
        return {
          products: [...cached.products.values()],
          messages: [...cached.messages.values()],
        };
      return enqueue(async () => {
        // Earlier queued work may have fetched these products while we waited.
        const { products, messages, missing } = displaySelection(selectedIds);
        if (missing.length) {
          const fresh = await fetchCatalog(
            parseCatalogCall("lookup_catalog", { ids: missing }),
          );
          for (const product of fresh.products)
            if (missing.includes(product.id)) products.set(product.id, product);
          for (const message of fresh.messages)
            messages.set(JSON.stringify(message), message);
        }
        return {
          products: selectedIds.flatMap((id) => products.get(id) ?? []),
          messages: [...messages.values()],
        };
      });
    },
    dispose() {
      disposed = true;
      displayProducts.clear();
    },
  };
}
