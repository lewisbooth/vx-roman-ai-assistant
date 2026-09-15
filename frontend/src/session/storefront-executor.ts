import {
  normalizeCatalogResult,
  type CatalogResult,
} from "../../../shared/catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import type { CatalogToolName } from "../../../shared/conversation";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../../shared/navigation-tool";
import type { AssistantTools } from "../tools";

// Model tools and visible cards share the theme owner's single-flight contract.
// Keep a small queue; never replay a request or cache catalog results.
export function createStorefrontExecutor(
  tools: Pick<AssistantTools, "execute">,
) {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let disposed = false;
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
    if (disposed || queued >= 12)
      return Promise.reject(
        new Error(
          "Please wait for the current storefront tools, then try again.",
        ),
      );
    const call =
      name === "navigate"
        ? { name: "navigate" as const, arguments: parseNavigationCall(input) }
        : parseCatalogCall(name, input);
    queued++;
    const result = tail
      .then(async () => {
        if (disposed) throw new Error("Roman has been removed.");
        signal?.throwIfAborted();
        const raw = await tools.execute(call.name, call.arguments, signal);
        if (disposed) throw new Error("Roman has been removed.");
        signal?.throwIfAborted();
        if (call.name === "navigate") {
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
          return { status: "navigated" as const, path };
        }
        try {
          return normalizeCatalogResult(raw, window.location.origin);
        } catch (error) {
          // Validation diagnostics contain controlled field paths, not catalog data.
          console.warn("[Roman] Catalog response rejected.", {
            tool: call.name,
            reason:
              error instanceof Error ? error.message : "Invalid catalog data.",
          });
          throw error;
        }
      })
      .finally(() => {
        queued--;
      });
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    execute,
    dispose() {
      disposed = true;
    },
  };
}
