export interface NavigationResult {
  status: "navigated";
  path: string;
  title?: string;
}

export interface NavigationPart {
  type: "navigation";
  version: 1;
  invocationId: string;
  path: string;
  title: string;
}

function navigationTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /\p{Cc}/u.test(value)
  )
    throw new Error("Navigation title must be a short plain-text page name.");
  return value.trim();
}

export function parseNavigationResult(input: unknown): NavigationResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid navigation result.");
  const value = input as Record<string, unknown>;
  if (
    value.status !== "navigated" ||
    Object.keys(value).some((key) => !["status", "path", "title"].includes(key))
  )
    throw new Error("Invalid navigation result.");
  return {
    status: "navigated",
    ...parseNavigationCall({ path: value.path }),
    ...(value.title !== undefined
      ? { title: navigationTitle(value.title) }
      : {}),
  };
}

export function parseNavigationPart(input: unknown): NavigationPart {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid navigation notification.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 5 ||
    value.type !== "navigation" ||
    value.version !== 1 ||
    typeof value.invocationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.invocationId,
    )
  )
    throw new Error("Invalid navigation notification.");
  const { path } = parseNavigationCall({ path: value.path });
  if (path.includes("?") || path.includes("#"))
    throw new Error("Navigation notifications omit page query and fragment.");
  return {
    type: "navigation",
    version: 1,
    invocationId: value.invocationId,
    path,
    title: navigationTitle(value.title),
  };
}

export const navigationToolDefinition = {
  type: "function",
  name: "navigate",
  description:
    "Open a verified public storefront page or the cart view when asked, or the PDP for the customer's clearly chosen product or one deliberately selected, verified recommendation. Do not navigate just because a catalog search returned one result. Respect requests to stay in chat. Use a catalog/conversation path. This tool cannot visit account, checkout, app/API, cart-action or cart-permalink URLs. Redirects and unsafe theme swaps require the customer to open a normal link; never retry them automatically.",
  strict: true,
  parameters: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 2048 } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export function parseNavigationCall(input: unknown): { path: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Navigation arguments must be an object.");
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).length !== 1 ||
    typeof args.path !== "string" ||
    args.path.length > 2048 ||
    !args.path.startsWith("/") ||
    args.path.startsWith("//") ||
    args.path.includes("\\") ||
    [...args.path].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Navigation requires a current-storefront path.");
  const url = new URL(args.path, "https://storefront.invalid");
  if (url.origin !== "https://storefront.invalid")
    throw new Error("Navigation requires a current-storefront path.");
  // Decode individual segments once; encoded separators, nested encodings and
  // dot segments must not change which Shopify endpoint receives the request.
  let segments: string[];
  try {
    segments = args.path.split(/[?#]/, 1)[0].split("/").slice(1);
    if (segments.at(-1) === "") segments.pop();
    segments = segments.map((segment) => decodeURIComponent(segment));
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          /[\\/%?#]/.test(segment) ||
          [...segment].some(
            (character) =>
              character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
          ),
      )
    )
      throw new Error();
  } catch {
    throw new Error("Navigation requires an unambiguous public page path.");
  }
  if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? "")) segments.shift();
  const [category] = segments;
  const count = segments.length;
  const product = category === "products" && count === 2;
  const collection =
    category === "collections" &&
    (count === 2 || count === 3 || (count === 4 && segments[2] === "products"));
  const allowed =
    count === 0 ||
    product ||
    collection ||
    (category === "cart" && count === 1) ||
    (category === "search" && count === 1) ||
    (category === "pages" && count === 2) ||
    (category === "policies" && count === 2) ||
    (category === "blogs" &&
      (count === 2 ||
        count === 3 ||
        (count === 4 && segments[2] === "tagged")));
  if (!allowed)
    throw new Error(
      "Roman can navigate public storefront pages and the cart view only.",
    );
  const queryKeys = new Set<string>();
  for (const [key, value] of url.searchParams) {
    const isProduct = product || (collection && count === 4);
    const valid =
      (key === "variant" && isProduct && /^\d{1,20}$/.test(value)) ||
      (key === "page" &&
        ["collections", "search", "blogs"].includes(category) &&
        /^\d{1,5}$/.test(value)) ||
      (key === "sort_by" &&
        ["collections", "search"].includes(category) &&
        /^[a-z-]{1,50}$/.test(value)) ||
      (key === "q" && category === "search" && value.length <= 500) ||
      (key === "type" &&
        category === "search" &&
        /^(product|article|page)(,(product|article|page))*$/.test(value)) ||
      (key === "options[prefix]" &&
        category === "search" &&
        /^(last|none)$/.test(value)) ||
      (/^filter\.[a-zA-Z0-9_.-]+$/.test(key) &&
        ["collections", "search"].includes(category) &&
        value.length <= 500);
    if (
      !valid ||
      queryKeys.has(key) ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error(
        "Roman navigation does not support this page query. Use a normal storefront link.",
      );
    queryKeys.add(key);
  }
  return { path: `${url.pathname}${url.search}${url.hash}` };
}
