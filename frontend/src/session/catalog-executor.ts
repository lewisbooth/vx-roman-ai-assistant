import {
  normalizeCatalogResult,
  type CatalogResult,
} from "../../../shared/catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import type { AssistantTools } from "../tools";

// Model lookups and visible cards share the theme tool owner's single-flight
// contract. Keep a small queue; never replay a request or cache catalog results.
export function createCatalogExecutor(tools: Pick<AssistantTools, "execute">) {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let disposed = false;
  return {
    execute(name: string, input: unknown): Promise<CatalogResult> {
      if (disposed || queued >= 12)
        return Promise.reject(
          new Error(
            "Please wait for the current product lookups, then try again.",
          ),
        );
      const call = parseCatalogCall(name, input);
      queued++;
      const result = tail
        .then(async () => {
          if (disposed) throw new Error("Roman has been removed.");
          const raw = await tools.execute(call.name, call.arguments);
          if (disposed) throw new Error("Roman has been removed.");
          return normalizeCatalogResult(raw, window.location.origin);
        })
        .finally(() => {
          queued--;
        });
      tail = result.catch(() => undefined);
      return result;
    },
    dispose() {
      disposed = true;
    },
  };
}
