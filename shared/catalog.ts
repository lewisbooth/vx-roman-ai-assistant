export interface CatalogProduct {
  id: string;
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
  priceLabel?: string;
}

export interface CatalogMessage {
  type: "info" | "warning";
  code?: string;
  text: string;
}

export interface CatalogResult {
  products: CatalogProduct[];
  messages: CatalogMessage[];
}

const productId = /^gid:\/\/shopify\/Product\/\d+$/;
const codePattern = /^[a-zA-Z0-9_.-]{1,80}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, expected: string): never {
  // Paths and expectations come from this validator, never from response values.
  throw new Error(
    `Shopify returned an invalid catalog response: ${path} expected ${expected}.`,
  );
}

function origin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(
      "storefrontOrigin",
      "an HTTPS origin without credentials or a path",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== value
  )
    invalid(
      "storefrontOrigin",
      "an HTTPS origin without credentials or a path",
    );
  return url.origin;
}

function productUrl(
  value: unknown,
  storefrontOrigin: string,
): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value, storefrontOrigin);
    if (
      url.origin !== storefrontOrigin ||
      url.username ||
      url.password ||
      !/^\/products\/[^/]+\/?$/.test(url.pathname)
    )
      return;
    // Cards open the product configurator; catalog query strings are unnecessary.
    return `${url.origin}${url.pathname}`;
  } catch {
    return;
  }
}

function imageUrl(
  value: unknown,
  storefrontOrigin: string,
): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value, storefrontOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.origin !== storefrontOrigin &&
        url.origin !== "https://cdn.shopify.com")
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

function compact(value: string, limit: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- Strip non-printing catalog data before display.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit)
  );
}

function description(value: unknown): string {
  if (!object(value)) return "";
  if (typeof value.plain === "string") return compact(value.plain, 2000);
  if (typeof value.html !== "string") return "";
  // Convert to display text only; catalog HTML is never inserted into a DOM.
  const text = value.html
    .slice(0, 40_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (entity, name: string) => {
        const named: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        };
        if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity;
        const code =
          name[1].toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : " ";
      },
    );
  return compact(text, 2000);
}

function startingPrice(value: unknown): string | undefined {
  if (!object(value) || !object(value.min)) return;
  const { amount, currency } = value.min;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency)
  )
    return;
  try {
    const format = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "code",
    });
    const fractionDigits = format.resolvedOptions().maximumFractionDigits;
    if (fractionDigits === undefined) return;
    return `From ${format.format(amount / 10 ** fractionDigits)}`;
  } catch {
    return;
  }
}

function normalizeProduct(
  value: unknown,
  storefrontOrigin: string,
  path: string,
): CatalogProduct {
  if (!object(value)) invalid(path, "a product object");
  if (
    typeof value.id !== "string" ||
    value.id.length > 100 ||
    !productId.test(value.id)
  )
    invalid(`${path}.id`, "a Shopify Product GID of at most 100 characters");
  if (typeof value.title !== "string")
    invalid(`${path}.title`, "non-empty text");
  const title = compact(value.title, 200);
  if (!title) invalid(`${path}.title`, "non-empty text");
  const url = productUrl(value.url, storefrontOrigin);
  if (!url)
    invalid(`${path}.url`, "a current-storefront /products/<handle> URL");
  const media = Array.isArray(value.media) ? value.media : [];
  const variantMedia = Array.isArray(value.variants)
    ? value.variants.flatMap((variant) =>
        object(variant) && Array.isArray(variant.media) ? variant.media : [],
      )
    : [];
  const image = [...media, ...variantMedia]
    .filter((item) => object(item) && item.type === "image")
    .map((item) => imageUrl(item.url, storefrontOrigin))
    .find(Boolean);
  const priceLabel = startingPrice(value.price_range);
  return {
    id: value.id,
    title,
    description: description(value.description),
    url,
    ...(image ? { imageUrl: image } : {}),
    ...(priceLabel ? { priceLabel } : {}),
  };
}

/** Project the decoded UCP search, lookup or single-product result for one turn.
 * Store product IDs for later lookup, not this live catalog data. */
export function normalizeCatalogResult(
  value: unknown,
  storefrontOrigin: string,
): CatalogResult {
  const store = origin(storefrontOrigin);
  if (!object(value)) invalid("$", "a catalog result object");
  const productArray = Array.isArray(value.products);
  const products = Array.isArray(value.products)
    ? value.products
    : object(value.product)
      ? [value.product]
      : undefined;
  if (!products) invalid("$", "a products array or a product object");
  if (products.length > 10) invalid("products", "at most 10 products");
  const rawMessages = value.messages === undefined ? [] : value.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > 10)
    invalid("messages", "an array of at most 10 messages");
  const messages: CatalogMessage[] = rawMessages.map(
    (message: unknown, index) => {
      const path = `messages[${index}]`;
      if (!object(message)) invalid(path, "a message object");
      if (message.type !== "info" && message.type !== "warning")
        invalid(`${path}.type`, '"info" or "warning"');
      if (typeof message.content !== "string")
        invalid(`${path}.content`, "non-empty text");
      const text = compact(message.content, 300);
      if (!text) invalid(`${path}.content`, "non-empty text");
      return {
        type: message.type,
        ...(typeof message.code === "string" && codePattern.test(message.code)
          ? { code: message.code }
          : {}),
        text,
      };
    },
  );
  const unique = new Map<string, CatalogProduct>();
  for (const [index, value] of products.entries()) {
    const product = normalizeProduct(
      value,
      store,
      productArray ? `products[${index}]` : "product",
    );
    if (!unique.has(product.id)) unique.set(product.id, product);
  }
  return { products: [...unique.values()], messages };
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    invalid(path, `only these fields: ${keys.join(", ")}`);
}

function text(
  value: unknown,
  path: string,
  limit: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!allowEmpty && !value.trim())
  )
    invalid(
      path,
      `${allowEmpty ? "text" : "non-empty text"} of at most ${limit} characters`,
    );
  return value;
}

/** Validate the browser's projected tool result again at the server boundary. */
export function parseCatalogResult(
  value: unknown,
  storefrontOrigin: string,
): CatalogResult {
  const store = origin(storefrontOrigin);
  if (!object(value)) invalid("$", "a catalog result object");
  onlyKeys(value, ["products", "messages"], "$");
  if (!Array.isArray(value.products) || value.products.length > 10)
    invalid("products", "an array of at most 10 products");
  if (!Array.isArray(value.messages) || value.messages.length > 10)
    invalid("messages", "an array of at most 10 messages");
  const seen = new Set<string>();
  const products = value.products.map((product, index): CatalogProduct => {
    const path = `products[${index}]`;
    if (!object(product)) invalid(path, "a product object");
    onlyKeys(
      product,
      ["id", "title", "description", "url", "imageUrl", "priceLabel"],
      path,
    );
    const id = text(product.id, `${path}.id`, 100);
    if (!productId.test(id)) invalid(`${path}.id`, "a Shopify Product GID");
    if (seen.has(id)) invalid(`${path}.id`, "a unique Shopify Product GID");
    seen.add(id);
    const url = productUrl(product.url, store);
    if (!url || url !== product.url)
      invalid(
        `${path}.url`,
        "a canonical current-storefront /products/<handle> URL",
      );
    const image =
      product.imageUrl === undefined
        ? undefined
        : imageUrl(product.imageUrl, store);
    if (
      product.imageUrl !== undefined &&
      (!image || image !== product.imageUrl)
    )
      invalid(
        `${path}.imageUrl`,
        "a canonical HTTPS image URL on the storefront or cdn.shopify.com",
      );
    return {
      id,
      title: text(product.title, `${path}.title`, 200),
      description: text(product.description, `${path}.description`, 2000, true),
      url,
      ...(image ? { imageUrl: image } : {}),
      ...(product.priceLabel !== undefined
        ? { priceLabel: text(product.priceLabel, `${path}.priceLabel`, 100) }
        : {}),
    };
  });
  const messages = value.messages.map((message, index): CatalogMessage => {
    const path = `messages[${index}]`;
    if (!object(message)) invalid(path, "a message object");
    onlyKeys(message, ["type", "code", "text"], path);
    if (message.type !== "info" && message.type !== "warning")
      invalid(`${path}.type`, '"info" or "warning"');
    if (
      message.code !== undefined &&
      (typeof message.code !== "string" || !codePattern.test(message.code))
    )
      invalid(
        `${path}.code`,
        "1-80 letters, numbers, dots, underscores or hyphens",
      );
    return {
      type: message.type,
      text: text(message.text, `${path}.text`, 300),
      ...(typeof message.code === "string" ? { code: message.code } : {}),
    };
  });
  return { products, messages };
}
