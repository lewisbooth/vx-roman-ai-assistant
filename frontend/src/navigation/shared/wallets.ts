export function takeWalletModules(source: Document, base: URL): URL[] {
  const modules: URL[] = [];
  for (const script of source.querySelectorAll('script[type="module"][src]')) {
    const url = new URL(script.getAttribute("src")!, base);
    if (
      url.origin !== base.origin ||
      url.protocol !== "https:" ||
      !/^\/cdn\/shopifycloud\/portable-wallets\/latest\/portable-wallets\.[a-z]{2}(?:-[A-Z]{2})?\.js$/.test(
        url.pathname,
      )
    )
      continue;
    if (
      url.username ||
      url.password ||
      url.hash ||
      script.textContent?.trim() ||
      [...script.attributes].some(({ name, value }) => {
        if (name === "onerror")
          return !/^\s*portableWalletsCleanup\(this\);?\s*$/.test(value);
        if (name === "crossorigin") return value !== "anonymous";
        return !["src", "type", "async", "defer"].includes(name);
      })
    ) {
      throw new Error(
        "This page has unsupported Shopify wallet configuration. Open it with normal navigation.",
      );
    }
    // Module loading already uses anonymous CORS. Never replay fetched inline
    // cleanup against the persistent document; readiness is checked before new
    // wallet elements connect.
    modules.push(url);
    script.remove();
  }
  return modules;
}

export function checkWalletElements(main: HTMLElement): void {
  for (const name of [
    "shopify-accelerated-checkout-cart",
    "shopify-accelerated-checkout",
  ]) {
    if (main.querySelector(name) && !customElements.get(name)) {
      throw new Error(
        "Shopify wallet components did not initialize. Reload this page before continuing.",
      );
    }
  }
}
