type CatalogTool = "search_catalog" | "get_product" | "lookup_catalog";

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
  throw new Error("Shopify returned an invalid catalog response.");
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
    envelope = await response.json();
  } catch {
    signal.throwIfAborted();
    if (!response.ok)
      throw new Error(
        `Shopify catalog request failed (HTTP ${response.status}).`,
      );
    throw new Error(
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
    throw new Error(
      `Shopify catalog request failed (HTTP ${response.status})${detail}`,
    );
  }
  if (!isObject(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== id)
    throw new Error("Shopify returned an invalid catalog protocol response.");
  if ("error" in envelope) {
    throw new Error(
      `Shopify catalog request failed: ${protocolError(envelope.error)}`,
    );
  }
  if (!isObject(envelope.result))
    throw new Error("Shopify returned an invalid catalog protocol response.");
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

export async function searchProducts(
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
    throw new Error("Shopify returned a catalog response without products.");
  // Return public catalog data only, excluding the negotiated payment metadata.
  return {
    products: data.products,
    pagination: data.pagination,
    messages: data.messages,
  };
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
