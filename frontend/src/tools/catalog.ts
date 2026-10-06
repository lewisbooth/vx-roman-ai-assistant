import {
  MAX_CATALOG_RESULT_BYTES,
  normalizeCatalogResult,
  parseCatalogResult,
  type CatalogProduct,
  type CatalogQueryError,
  type CatalogQueryOutcome,
  type CatalogResult,
} from "../../../shared/catalog";
import { parseCatalogCall } from "../../../shared/catalog-tools";

type CatalogTool = "search_catalog" | "get_product" | "lookup_catalog";

const MAX_CATALOG_RESPONSE_BYTES = 1024 * 1024;

class CatalogRequestError extends Error {
  constructor(
    readonly code: CatalogQueryError,
    message: string,
  ) {
    super(message);
  }
}

function httpErrorCode(status: number): CatalogQueryError {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "service_unavailable";
  return "request_failed";
}

async function readCatalogEnvelope(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Shopify returned an empty catalog response.");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const length = response.headers.get("content-length");
    if (
      length &&
      (!/^\d+$/.test(length) || Number(length) > MAX_CATALOG_RESPONSE_BYTES)
    )
      throw new Error("Shopify catalog response exceeds the size limit.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CATALOG_RESPONSE_BYTES)
        throw new Error("Shopify catalog response exceeds the size limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

const productIdPattern = /^gid:\/\/shopify\/(?:Product|ProductVariant)\/\d+$/;

let nextRequestId = 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileUrl(value: string | undefined): string {
  let url: URL;
  try {
    if (!value?.trim()) throw new Error();
    url = new URL(value, window.location.href);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error();
  } catch {
    throw new Error(
      "Publish Roman's agent profile and configure data-agent-profile-url before using Shopify catalog tools.",
    );
  }
  return url.href;
}

function errorMessage(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const message = value.content ?? value.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : undefined;
}

function protocolError(value: unknown): string {
  if (!isObject(value)) return "JSON-RPC error.";
  const data = isObject(value.data) ? value.data : undefined;
  const details = [errorMessage(value), errorMessage(data)];
  const message = [...new Set(details.filter(Boolean))].join(": ");
  const code =
    typeof data?.code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(data.code)
      ? ` [${data.code}]`
      : "";
  // Only diagnostic strings are returned; never serialize the full response
  // data, which can include URLs or unrelated request/customer information.
  return `${message || "JSON-RPC error."}${code}`;
}

function readCatalog(result: Record<string, unknown>): Record<string, unknown> {
  if ("structuredContent" in result) {
    if (isObject(result.structuredContent)) return result.structuredContent;
  } else if (Array.isArray(result.content)) {
    // MCP also permits the structured response as a JSON text content block.
    const content = result.content.filter(
      (item) => isObject(item) && item.type === "text",
    );
    if (content.length === 1 && typeof content[0].text === "string") {
      try {
        const value: unknown = JSON.parse(content[0].text);
        if (isObject(value)) return value;
      } catch {
        // Report the invalid protocol response without rendering remote markup.
      }
    }
  }
  throw new CatalogRequestError(
    "invalid_response",
    "Shopify returned an invalid catalog response.",
  );
}

async function callCatalog(
  name: CatalogTool,
  catalog: Record<string, unknown>,
  signal: AbortSignal,
  agentProfileUrl: string | undefined,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const profile = profileUrl(agentProfileUrl);
  const id = ++nextRequestId;
  let response: Response;
  try {
    response = await fetch(new URL("/api/ucp/mcp", window.location.origin), {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: { meta: { "ucp-agent": { profile } }, catalog },
        },
      }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Could not reach this storefront's Shopify catalog.");
  }
  signal.throwIfAborted();
  let envelope: unknown;
  try {
    envelope = await readCatalogEnvelope(response, signal);
  } catch {
    signal.throwIfAborted();
    if (!response.ok)
      throw new CatalogRequestError(
        httpErrorCode(response.status),
        `Shopify catalog request failed (HTTP ${response.status}).`,
      );
    throw new CatalogRequestError(
      "invalid_response",
      "Shopify catalog did not return JSON. Check storefront access.",
    );
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const detail =
      isObject(envelope) &&
      envelope.jsonrpc === "2.0" &&
      envelope.id === id &&
      "error" in envelope
        ? `: ${protocolError(envelope.error)}`
        : ".";
    throw new CatalogRequestError(
      httpErrorCode(response.status),
      `Shopify catalog request failed (HTTP ${response.status})${detail}`,
    );
  }
  if (!isObject(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id)
    throw new CatalogRequestError(
      "invalid_response",
      "Shopify returned an invalid catalog protocol response.",
    );
  if ("error" in envelope) {
    throw new Error(
      `Shopify catalog request failed: ${protocolError(envelope.error)}`,
    );
  }
  if (!isObject(envelope.result))
    throw new CatalogRequestError(
      "invalid_response",
      "Shopify returned an invalid catalog protocol response.",
    );
  if (envelope.result.isError === true)
    throw new Error(
      "Shopify could not run the catalog tool. Check Roman's published agent profile and storefront access.",
    );

  const data = readCatalog(envelope.result);
  const failure = Array.isArray(data.messages)
    ? data.messages.find(
        (message) => isObject(message) && message.type === "error",
      )
    : undefined;
  if (
    failure ||
    (isObject(data.ucp) &&
      data.ucp.status !== undefined &&
      data.ucp.status !== "success")
  ) {
    throw new Error(
      `Shopify catalog could not complete the request: ${errorMessage(failure) ?? "UCP negotiation or catalog lookup failed."}`,
    );
  }
  return data;
}

async function searchQuery(
  query: string,
  signal: AbortSignal,
  agentProfileUrl: string | undefined,
): Promise<unknown> {
  const text = query.trim();
  if (!text || text.length > 500)
    throw new Error("Enter a product search between 1 and 500 characters.");
  const data = await callCatalog(
    "search_catalog",
    { query: text, pagination: { limit: 10 } },
    signal,
    agentProfileUrl,
  );
  if (!Array.isArray(data.products))
    throw new CatalogRequestError(
      "invalid_response",
      "Shopify returned a catalog response without products.",
    );
  // Return public catalog data only, excluding the negotiated payment metadata.
  return {
    products: data.products,
    pagination: data.pagination,
    messages: data.messages,
  };
}

/** One public tool operation; independent read-only Shopify calls share a deadline. */
export async function searchProducts(
  input: readonly string[],
  signal: AbortSignal,
  agentProfileUrl: string | undefined,
): Promise<CatalogResult> {
  const queries = parseCatalogCall("search_products", { queries: input })
    .arguments.queries as string[];
  signal.throwIfAborted();
  // Configuration errors are operation failures, not misleading empty searches.
  profileUrl(agentProfileUrl);
  const request = new AbortController();
  const abort = () => request.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    request.abort(
      new DOMException("Catalog search timed out.", "TimeoutError"),
    );
  }, 20000);
  try {
    const results = await Promise.all(
      queries.map(
        async (
          query,
        ): Promise<{
          result?: CatalogResult;
          outcome: CatalogQueryOutcome;
        }> => {
          try {
            const raw = await searchQuery(
              query,
              request.signal,
              agentProfileUrl,
            );
            let result: CatalogResult;
            try {
              result = normalizeCatalogResult(raw, window.location.origin);
            } catch {
              return {
                outcome: {
                  query,
                  status: "failed",
                  productIds: [],
                  error: "invalid_response",
                },
              };
            }
            return {
              result,
              outcome: {
                query,
                status: "succeeded",
                productIds: result.products.map(({ id }) => id),
              },
            };
          } catch (error) {
            signal.throwIfAborted();
            return {
              outcome: {
                query,
                status: "failed",
                productIds: [],
                error: timedOut
                  ? "timeout"
                  : error instanceof CatalogRequestError
                    ? error.code
                    : "request_failed",
              },
            };
          }
        },
      ),
    );
    signal.throwIfAborted();
    const products = new Map<string, CatalogProduct>();
    const messages: CatalogResult["messages"] = [];
    for (const { result } of results) {
      for (const product of result?.products ?? [])
        if (!products.has(product.id)) products.set(product.id, product);
      messages.push(...(result?.messages ?? []));
    }
    const merged: CatalogResult = {
      products: [...products.values()],
      messages,
      queries: results.map(({ outcome }) => outcome),
    };
    // Descriptions and URLs are independently bounded; the complete projection
    // also has a byte budget so multibyte catalog content cannot inflate a turn.
    const size = () =>
      new TextEncoder().encode(JSON.stringify(merged)).byteLength;
    if (size() > MAX_CATALOG_RESULT_BYTES) {
      merged.messages = messages.slice(0, 29);
      const warning = {
        type: "warning",
        code: "result_size_limit",
        text: "Catalog descriptions, optional imagery or diagnostics were shortened or omitted to preserve every candidate within the result size limit.",
      } as const;
      merged.messages.push(warning);
      const descriptions = merged.products.map(({ description }) =>
        Array.from(description),
      );
      const applyDescriptionFraction = (fraction: number) => {
        merged.products.forEach((product, index) => {
          const description = descriptions[index];
          product.description = description
            .slice(0, Math.floor((description.length * fraction) / 1000))
            .join("");
        });
      };
      applyDescriptionFraction(0);
      if (size() > MAX_CATALOG_RESULT_BYTES)
        for (const product of merged.products) delete product.imageUrl;
      if (size() > MAX_CATALOG_RESULT_BYTES) merged.messages = [warning];
      if (size() > MAX_CATALOG_RESULT_BYTES)
        throw new Error(
          "Verified catalog product references exceed the result size limit.",
        );
      // Preserve all IDs, titles, paths and query provenance. Share the remaining
      // description budget proportionally rather than dropping the last category.
      // Code-point slices retain Unicode characters; the measured JSON byte size
      // also accounts for escaping and leaves the complete HTTP envelope bounded.
      let low = 0;
      let high = 1000;
      while (low < high) {
        const fraction = Math.ceil((low + high) / 2);
        applyDescriptionFraction(fraction);
        if (size() <= MAX_CATALOG_RESULT_BYTES) low = fraction;
        else high = fraction - 1;
      }
      applyDescriptionFraction(low);
    }
    return parseCatalogResult(merged, window.location.origin);
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export async function getProduct(
  id: string,
  signal: AbortSignal,
  agentProfileUrl: string | undefined,
): Promise<unknown> {
  const productId = id.trim();
  if (!productIdPattern.test(productId))
    throw new Error(
      "Enter a Shopify product or variant GID returned by product search.",
    );
  const data = await callCatalog(
    "get_product",
    { id: productId },
    signal,
    agentProfileUrl,
  );
  if (!isObject(data.product))
    throw new Error(
      "Shopify did not return this product. Check the ID and storefront.",
    );
  return { product: data.product, messages: data.messages };
}

export async function lookupCatalog(
  ids: readonly string[],
  signal: AbortSignal,
  agentProfileUrl: string | undefined,
): Promise<unknown> {
  const productIds = Array.isArray(ids)
    ? Array.from(ids, (id: unknown) =>
        typeof id === "string" ? id.trim() : "",
      )
    : [];
  if (
    productIds.length < 1 ||
    productIds.length > 10 ||
    !productIds.every((id) => productIdPattern.test(id))
  )
    throw new Error(
      "Enter between 1 and 10 Shopify product or variant GIDs returned by product search.",
    );
  const data = await callCatalog(
    "lookup_catalog",
    { ids: productIds },
    signal,
    agentProfileUrl,
  );
  if (!Array.isArray(data.products))
    throw new Error("Shopify returned a catalog response without products.");
  // Keep per-variant input matches and not_found messages: a batch may resolve
  // only some identifiers, with several identifiers grouped under one product.
  return { products: data.products, messages: data.messages };
}
