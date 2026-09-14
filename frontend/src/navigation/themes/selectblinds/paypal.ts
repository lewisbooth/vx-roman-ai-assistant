type PayPalWindow = Window & {
  paypal?: { Buttons?: unknown; Messages?: unknown };
};

const sdkEndpoint = "https://www.paypal.com/sdk/js";
const sdkAttributes = new Set(["id", "src", "type", "defer", "async"]);
const sdkParameters = new Set([
  "client-id",
  "components",
  "locale",
  "currency",
]);
const themeWindow =
  typeof window === "undefined" ? undefined : (window as PayPalWindow);

function isSdkUrl(url: URL): boolean {
  return url.origin + url.pathname === sdkEndpoint;
}

// Keep the initial PDP's configuration even after its script leaves the DOM.
const initialScripts =
  typeof document === "undefined"
    ? []
    : Array.from(
        document.querySelectorAll<HTMLScriptElement>("script[src]"),
      ).filter((script) => isSdkUrl(new URL(script.src, document.baseURI)));
let sdkLoad: { url: string; promise: Promise<void> } | undefined;

export function readPayPalScript(script: Element, base: URL): URL | null {
  const src = script.getAttribute("src");
  if (!src) return null;
  const url = new URL(src, base);
  if (!isSdkUrl(url)) return null;
  const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
  const parameters = [...url.searchParams.keys()];
  const components = url.searchParams
    .get("components")
    ?.split(",")
    .sort()
    .join(",");
  if (
    script.id !== "paypal-script" ||
    !["", "text/javascript", "application/javascript"].includes(type) ||
    script.textContent?.trim() ||
    [...script.attributes].some(
      (attribute) => !sdkAttributes.has(attribute.name),
    ) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("client-id")?.trim() ||
    components !== "buttons,messages" ||
    new Set(parameters).size !== parameters.length ||
    parameters.some((key) => !sdkParameters.has(key))
  ) {
    throw new Error(
      "This page has an unsupported PayPal SDK configuration. Open it with normal navigation.",
    );
  }
  url.searchParams.set("components", components);
  url.searchParams.sort();
  return url;
}

function sdkReady(): boolean {
  return (
    typeof themeWindow?.paypal?.Buttons === "function" &&
    typeof themeWindow?.paypal?.Messages === "function"
  );
}

export function preservePayPalSdk(main: HTMLElement): void {
  for (const script of main.querySelectorAll<HTMLScriptElement>(
    "script[src]",
  )) {
    if (isSdkUrl(new URL(script.src, document.baseURI)))
      document.head.append(script);
  }
}

function startSdkLoad(url: URL): Promise<void> {
  const scripts = [
    ...new Set([
      ...initialScripts,
      ...Array.from(
        document.querySelectorAll<HTMLScriptElement>("script[src]"),
      ).filter((script) => isSdkUrl(new URL(script.src, document.baseURI))),
    ]),
  ];
  if (
    scripts.length > 1 ||
    scripts.some((script) => {
      // PayPal adds this identifier after executing; it is not SDK configuration.
      const configuration = script.cloneNode(true) as HTMLScriptElement;
      configuration.removeAttribute("data-uid-auto");
      return (
        readPayPalScript(configuration, new URL(document.baseURI))?.href !==
        url.href
      );
    })
  ) {
    throw new Error(
      "The page requires a different PayPal SDK configuration. Reload this page before continuing.",
    );
  }
  const existing = scripts[0];
  if (existing && sdkReady()) return Promise.resolve();
  if (!existing && themeWindow?.paypal) {
    throw new Error(
      "An unrecognized PayPal SDK is already present. Reload this page before continuing.",
    );
  }

  const script = existing ?? document.createElement("script");
  if (!existing) {
    script.id = "paypal-script";
    script.src = url.href;
    script.async = true;
  }
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoad = () =>
      finish(
        sdkReady()
          ? undefined
          : new Error(
              "The PayPal SDK loaded without its required components. Reload this page before continuing.",
            ),
      );
    const onError = () =>
      finish(
        new Error(
          "The PayPal SDK could not load. Reload this page before continuing.",
        ),
      );
    const timeout = window.setTimeout(
      () =>
        finish(
          new Error(
            "The PayPal SDK timed out. Reload this page before continuing.",
          ),
        ),
      15000,
    );
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (!existing) document.head.append(script);
  });
}

export async function loadPayPalSdk(
  url: URL | null,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!url) return;
  if (sdkLoad && sdkLoad.url !== url.href) {
    throw new Error(
      "The page requires a different PayPal SDK configuration. Reload this page before continuing.",
    );
  }
  // The SDK belongs to the document, as does the theme's existing SDK observer.
  // Cancel only this navigation's waiter; another PDP can reuse the bounded load.
  sdkLoad ??= { url: url.href, promise: startSdkLoad(url) };
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    sdkLoad!.promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        if (sdkReady()) resolve();
        else
          reject(
            new Error(
              "The PayPal SDK is no longer available. Reload this page before continuing.",
            ),
          );
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
