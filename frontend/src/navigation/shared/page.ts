import type { StorefrontTheme, ThemePageHooks } from "./types";
import { checkWalletElements } from "./wallets";
import { loadPayPalSdk, preservePayPalSdk, takePayPalSdk } from "./paypal";

type JsonObject = Record<string, unknown>;
type PageGlobals = {
  collectionId: string;
  cart: JsonObject;
  cartSwatches: JsonObject;
  meta: JsonObject;
};
type ThemeWindow = Window & {
  __ADMIN_COLLECTION_ID__?: string;
  __CART__?: JsonObject;
  __CART_COLOR_SWATCHES__?: JsonObject;
  ShopifyAnalytics?: { meta?: JsonObject };
  Shopify?: { PaymentButton?: { init?: () => void } };
};

export type PreparedPage = {
  document: Document;
  url: URL;
  main: HTMLElement;
  title: string;
  globals: PageGlobals | null;
  scripts: URL[];
  styles: URL[];
  paypalSdk: URL | null;
  integration: ThemePageHooks;
};

const themeWindow = window as ThemeWindow;
const preview = document.documentElement.dataset.romanPreview === "true";
const initialThemeDirectory = Array.from(
  document.querySelectorAll("script[src]"),
)
  .map((script) => new URL(script.getAttribute("src")!, document.baseURI))
  .find((url) => /^\/cdn\/shop\/t\/\d+\/assets\//.test(url.pathname));
const themeDirectory = initialThemeDirectory
  ? new URL("./", initialThemeDirectory)
  : null;
const pageMetaKeys = new Set([
  "product",
  "collection",
  "page",
  ...Object.keys(themeWindow.ShopifyAnalytics?.meta ?? {}).filter(
    (key) => key !== "currency" && key !== "shop",
  ),
]);
const pageMetadata =
  'link[rel="canonical"], meta[name="description"], meta[property^="og:"], meta[property^="product:"], meta[name^="twitter:"]';

function isThemeAsset(url: URL): boolean {
  return (
    !!themeDirectory &&
    url.origin === themeDirectory.origin &&
    url.pathname.startsWith(themeDirectory.pathname)
  );
}

function mainElement(source: Document): HTMLElement {
  const candidates = source.querySelectorAll("app-provider > main#main");
  if (
    candidates.length !== 1 ||
    source.querySelectorAll("#main").length !== 1
  ) {
    throw new Error(
      "This page does not have the supported app-provider > main#main layout.",
    );
  }
  return candidates[0] as HTMLElement;
}

// The theme writes literal JSON into these assignments. Parse data, never JavaScript.
function jsonAssignment(
  source: string,
  assignment: RegExp,
  label: string,
): JsonObject {
  const match = assignment.exec(source);
  if (!match)
    throw new Error(
      `The page is missing ${label}. Open it with normal navigation.`,
    );
  const start = match.index + match[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) {
      try {
        const value: unknown = JSON.parse(source.slice(start, index + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value as JsonObject;
        }
      } catch {
        break;
      }
      break;
    } else if (index === start && char !== "{") break;
  }
  throw new Error(
    `The page has unsupported ${label} data. Open it with normal navigation.`,
  );
}

function readGlobals(source: Document): PageGlobals | null {
  if (preview) return null;
  const scripts = Array.from(source.head.querySelectorAll("script:not([src])"));
  const bootstrap = scripts
    .map((script) => script.textContent ?? "")
    .join("\n");
  const collection = /window\.__ADMIN_COLLECTION_ID__\s*=\s*'(\d*)'/.exec(
    bootstrap,
  );
  const analytics = scripts.find((script) =>
    /window\.ShopifyAnalytics\.meta\[attr\]\s*=\s*meta\[attr\]/.test(
      script.textContent ?? "",
    ),
  );
  if (!collection || !analytics) {
    throw new Error(
      "This page has unsupported Shopify page context. Open it with normal navigation.",
    );
  }
  return {
    collectionId: collection[1],
    cart: jsonAssignment(bootstrap, /window\.__CART__\s*=\s*/, "cart"),
    cartSwatches: jsonAssignment(
      bootstrap,
      /window\.__CART_COLOR_SWATCHES__\s*=\s*/,
      "cart swatches",
    ),
    meta: jsonAssignment(
      analytics.textContent ?? "",
      /\bvar\s+meta\s*=\s*/,
      "analytics metadata",
    ),
  };
}

function scriptUrls(source: Document, base: URL): URL[] {
  return Array.from(source.querySelectorAll('script[type="module"][src]'))
    .map((script) => new URL(script.getAttribute("src")!, base))
    .filter(isThemeAsset);
}

function elementLocation(element: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    let position = 1;
    for (
      let sibling = node.previousElementSibling;
      sibling;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.localName === node.localName) position++;
    }
    parts.unshift(`${node.localName}:nth-of-type(${position})`);
  }
  return parts.join(" > ");
}

function diagnosticScriptSource(script: Element, base: URL): string {
  const src = script.getAttribute("src");
  if (!src) return "inline";
  try {
    const url = new URL(src, base);
    return /^https?:$/.test(url.protocol)
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}[redacted]`;
  } catch {
    return "[invalid URL]";
  }
}

function diagnosticScriptType(script: Element): string {
  const type = script.getAttribute("type")?.trim().toLowerCase();
  if (!type) return "classic";
  return [
    "module",
    "importmap",
    "speculationrules",
    "text/javascript",
    "application/javascript",
    "text/ecmascript",
    "application/ecmascript",
    "application/json",
    "application/ld+json",
  ].includes(type)
    ? type
    : "unrecognized";
}

function unsafeAttributeReason(attribute: Attr): string | null {
  if (/^on/i.test(attribute.name))
    return "Inline event handler is not supported.";
  if (attribute.name === "srcdoc") return "srcdoc embeds executable HTML.";
  if (
    /^(href|src|action|formaction|xlink:href)$/i.test(attribute.name) &&
    /^\s*javascript:/i.test(attribute.value)
  )
    return "JavaScript URL is not supported.";
  return null;
}

export function preparePage(
  html: string,
  url: URL,
  theme: StorefrontTheme,
): PreparedPage {
  const source = new DOMParser().parseFromString(html, "text/html");
  const title = source.title.trim();
  if (source.body.classList.contains("template-password") || !title) {
    throw new Error(
      "This page requires normal navigation or store access. The current page has been kept.",
    );
  }
  if (!preview && !themeDirectory) {
    throw new Error(
      "The current theme asset directory could not be identified.",
    );
  }
  const main = mainElement(source);
  mainElement(document);
  if (
    source.querySelector(
      "app-provider > #shopify-section-cart-drawer-dialog",
    ) &&
    !document.querySelector(
      "app-provider > #shopify-section-cart-drawer-dialog",
    )
  ) {
    throw new Error(
      "The current theme shell is missing its cart drawer. Open this page with normal navigation.",
    );
  }
  // Locate blockers before hooks remove SDKs or replace Continue-shopping buttons.
  const elementLocations = new Map(
    Array.from(source.querySelectorAll("*"))
      .filter(
        (element) =>
          element.localName === "script" ||
          Array.from(element.attributes).some(unsafeAttributeReason),
      )
      .map((element) => [element, elementLocation(element)]),
  );
  const integration = theme.prepare(source, url);
  const paypalSdk = takePayPalSdk(source, url);
  const scripts = scriptUrls(source, url);
  // The observed theme has two incompatible custom-element implementations for cart.
  const cartFamilies = new Set(
    [...scripts, ...scriptUrls(document, new URL(document.baseURI))]
      .map((asset) => asset.pathname.split("/").pop())
      .filter(
        (name) =>
          name === "-core-cart-sections.js" ||
          name === "-core-cart-sections-foundation.js",
      ),
  );
  if (cartFamilies.size > 1) {
    throw new Error(
      "This theme uses incompatible cart components. Open Cart with normal navigation or test a theme with one shared cart component.",
    );
  }
  const blocked: {
    reason: string;
    element: string;
    type?: string;
    src?: string;
    attribute?: string;
  }[] = [];
  let scriptError: string | undefined;
  const unsupportedModules = new Set<Element>();
  const blockScript = (
    element: Element,
    reason: string,
    message: string,
    attribute?: string,
  ) => {
    scriptError ??= message;
    blocked.push({
      reason,
      element: elementLocations.get(element) ?? elementLocation(element),
      ...(element.localName === "script"
        ? {
            type: diagnosticScriptType(element),
            src: diagnosticScriptSource(element, url),
          }
        : {}),
      ...(attribute ? { attribute } : {}),
    });
  };
  if (!preview) {
    const loaded = new Set(
      Array.from(document.querySelectorAll("script[src]")).map(
        (script) => new URL(script.getAttribute("src")!, document.baseURI).href,
      ),
    );
    for (const script of source.querySelectorAll(
      'script[type="module"][src]',
    )) {
      const asset = new URL(script.getAttribute("src")!, url);
      if (!isThemeAsset(asset) && !loaded.has(asset.href)) {
        unsupportedModules.add(script);
        blockScript(
          script,
          "Module is outside the current theme and is not already loaded.",
          `This page requires an unsupported integration (${asset.pathname}). Open it with normal navigation.`,
        );
      }
    }
  }
  for (const element of [main, ...main.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      const reason = unsafeAttributeReason(attribute);
      if (reason) {
        blockScript(
          element,
          reason,
          "This page requires inline JavaScript. Open it with normal navigation.",
          attribute.name,
        );
      }
    }
  }
  for (const script of main.querySelectorAll("script")) {
    const src = script.getAttribute("src");
    const type = script.getAttribute("type")?.trim().toLowerCase();
    if (!src && (type === "application/json" || type === "application/ld+json"))
      continue;
    if (src && type === "module" && isThemeAsset(new URL(src, url))) {
      script.remove();
      continue;
    }
    if (!unsupportedModules.has(script)) {
      blockScript(
        script,
        src
          ? "External script is not a supported theme module."
          : "Inline script has no supported initialization lifecycle.",
        "This page contains scripts that cannot be safely initialized by Roman. Open it with normal navigation.",
      );
    }
  }
  if (scriptError) {
    // Log descriptors only: DOM nodes and script/attribute contents may contain
    // customer data. URLs omit credentials, query strings and fragments.
    console.error("[Roman] Unsafe storefront scripts blocked navigation.", {
      page: `${url.origin}${url.pathname}`,
      theme: theme.id,
      blocked,
    });
    throw new Error(scriptError);
  }

  const styles = Array.from(
    source.querySelectorAll('link[rel="stylesheet"][href]'),
  )
    .map((link) => new URL(link.getAttribute("href")!, url))
    .filter(isThemeAsset);
  for (const link of main.querySelectorAll('link[rel="stylesheet"][href]')) {
    if (!isThemeAsset(new URL(link.getAttribute("href")!, url))) {
      throw new Error(
        "This page requires an unsupported stylesheet. Open it with normal navigation.",
      );
    }
    link.remove();
  }
  return {
    document: source,
    url,
    main,
    title,
    globals: readGlobals(source),
    scripts,
    styles,
    paypalSdk,
    integration,
  };
}

class AssetLoadError extends Error {}

function loadAsset(
  url: URL,
  kind: "script" | "style",
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    return Promise.reject(
      new DOMException("Navigation cancelled", "AbortError"),
    );
  const selector =
    kind === "script" ? "script[src]" : 'link[rel="stylesheet"][href]';
  const attribute = kind === "script" ? "src" : "href";
  if (
    Array.from(document.querySelectorAll(selector)).some(
      (node) =>
        new URL(node.getAttribute(attribute)!, document.baseURI).href ===
        url.href,
    )
  )
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const element =
      kind === "script"
        ? document.createElement("script")
        : document.createElement("link");
    if (element instanceof HTMLScriptElement) {
      element.type = "module";
      element.src = url.href;
    } else {
      element.rel = "stylesheet";
      element.href = url.href;
    }
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      element.onload = null;
      element.onerror = null;
      if (error) {
        element.remove();
        reject(error);
      } else resolve();
    };
    const abort = () =>
      finish(new DOMException("Navigation cancelled", "AbortError"));
    const timeout = window.setTimeout(
      () =>
        finish(
          new AssetLoadError(
            `Timed out loading theme ${kind} ${url.origin}${url.pathname}.`,
          ),
        ),
      15000,
    );
    element.onload = () => finish();
    element.onerror = () =>
      finish(
        new AssetLoadError(
          `Could not load theme ${kind} ${url.origin}${url.pathname}.`,
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      document.head.append(element);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function loadPageAssets(
  page: PreparedPage,
  signal: AbortSignal,
): Promise<void> {
  await loadPayPalSdk(page.paypalSdk, signal);
  async function load(url: URL, kind: "script" | "style", signal: AbortSignal) {
    try {
      await loadAsset(url, kind, signal);
    } catch (error) {
      // Only ordinary resource failures are nonfatal. Cancellation, unexpected
      // exceptions and the runtime-error guard must still stop navigation.
      if (signal.aborted || !(error instanceof AssetLoadError)) throw error;
      console.warn(
        `[Roman] ${error.message} Continuing navigation; some storefront features may be unavailable.`,
      );
    }
  }
  const loading = new AbortController();
  let runtimeError: Error | null = null;
  const abort = () => loading.abort();
  const onError = (event: ErrorEvent) => {
    if (!event.filename) return;
    const asset = new URL(event.filename, document.baseURI);
    if (
      !isThemeAsset(asset) &&
      !page.integration.modules?.some((module) => module.href === asset.href)
    )
      return;
    runtimeError = new Error(
      `Theme script ${new URL(event.filename, document.baseURI).pathname} failed to initialize: ${event.message}. Reload this page before continuing.`,
    );
    loading.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  window.addEventListener("error", onError);
  if (signal.aborted) loading.abort();
  try {
    // Finish CSS attempts before modules connect Lit components and adopt styles.
    await Promise.all(
      [...new Map(page.styles.map((url) => [url.href, url])).values()].map(
        (url) => load(url, "style", loading.signal),
      ),
    );
    await Promise.all(
      [
        ...new Map(
          [...page.scripts, ...(page.integration.modules ?? [])].map((url) => [
            url.href,
            url,
          ]),
        ).values(),
      ].map((url) => load(url, "script", loading.signal)),
    );
    if (runtimeError) throw runtimeError;
    if (page.integration.modules?.length) checkWalletElements(page.main);
  } catch (error) {
    loading.abort();
    throw runtimeError ?? error;
  } finally {
    signal.removeEventListener("abort", abort);
    window.removeEventListener("error", onError);
  }
  if (signal.aborted)
    throw new DOMException("Navigation cancelled", "AbortError");
}

export function commitPage(
  page: PreparedPage,
  beforeReplace?: () => void,
): {
  main: HTMLElement;
  error?: string;
} {
  const previous = mainElement(document);
  const main = document.importNode(page.main, true);
  const metadata = Array.from(
    page.document.head.querySelectorAll(pageMetadata),
    (node) => {
      const clone = document.importNode(node, true);
      if (clone instanceof HTMLLinkElement)
        clone.href = new URL(clone.getAttribute("href")!, page.url).href;
      return clone;
    },
  );
  if (page.globals) {
    const context = page.globals;
    themeWindow.__ADMIN_COLLECTION_ID__ = context.collectionId;
    themeWindow.__CART__ = context.cart;
    themeWindow.__CART_COLOR_SWATCHES__ = context.cartSwatches;
    const provider = previous.parentElement as HTMLElement & {
      cart?: JsonObject;
    };
    if ("cart" in provider) provider.cart = context.cart;
    const analytics = (themeWindow.ShopifyAnalytics ??= {});
    const meta = (analytics.meta ??= {});
    for (const key of pageMetaKeys) delete meta[key];
    pageMetaKeys.clear();
    for (const [key, value] of Object.entries(context.meta)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        continue;
      meta[key] = value;
      if (key !== "currency" && key !== "shop") pageMetaKeys.add(key);
    }
  }
  for (const name of [...document.body.classList]) {
    if (name.startsWith("template-")) document.body.classList.remove(name);
  }
  document.body.classList.add(
    ...[...page.document.body.classList].filter((name) =>
      name.startsWith("template-"),
    ),
  );
  document.title = page.title;
  document.head.querySelectorAll(pageMetadata).forEach((node) => node.remove());
  document.head.append(...metadata);
  preservePayPalSdk(previous);
  beforeReplace?.();
  previous.replaceWith(main);
  // main-header caches these flags at connection; preserve its listeners and context.
  const header = document.querySelector("main-header") as
    | (HTMLElement & {
        isProductPage?: boolean;
        hasStickyGallery?: boolean;
      })
    | null;
  if (header && "isProductPage" in header)
    header.isProductPage = document.body.classList.contains("template-product");
  if (header && "hasStickyGallery" in header)
    header.hasStickyGallery =
      document.querySelector("[data-sticky-gallery]") !== null;
  try {
    themeWindow.Shopify?.PaymentButton?.init?.();
  } catch {
    return {
      main,
      error:
        "The page loaded, but Shopify payment controls could not initialize. Reload this page before purchasing.",
    };
  }
  return { main };
}
