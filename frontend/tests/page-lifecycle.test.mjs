import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import jsdomInternals from "jsdom/lib/jsdom/living/generated/utils.js";

const origin = "https://hd-dev-multi.myshopify.com";
const asset = `${origin}/cdn/shop/t/370/assets/-pricing.js`;
const bundle = await build({
  entryPoints: ["frontend/src/navigation/shared/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanNavigation",
  platform: "browser",
});
function html(extra = "") {
  return `<!doctype html><html data-roman-preview="true"><head><title>Blinds</title>
    <script type="module" src="${asset}"></script></head><body><app-provider>
    <main id="main"><h1>Blinds</h1>${extra}</main></app-provider>
    <roman-ai-assistant data-shop="hd-dev-multi.myshopify.com"></roman-ai-assistant></body></html>`;
}
function setup(t, code, source = asset) {
  const dom = new JSDOM(html(), {
    url: origin,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const reports = [];
  const native = [];
  window.addEventListener("error", (event) => event.preventDefault());
  const runtimeObservers = new Set();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, listener, ...options) => {
    if (type === "error") runtimeObservers.add(listener);
    return add(type, listener, ...options);
  };
  window.removeEventListener = (type, listener, ...options) => {
    if (type === "error") runtimeObservers.delete(listener);
    return remove(type, listener, ...options);
  };
  window.console.error = (...args) => reports.push(args);
  window.scrollTo = () => {};
  const location = jsdomInternals.implForWrapper(window.location);
  for (const method of ["assign", "replace", "reload"])
    location[method] = () => native.push(method);
  window.fetch = async (url) => ({
    ok: true,
    url: String(url),
    headers: { get: () => "text/html" },
    text: async () => html("<pricing-control></pricing-control>"),
  });
  window.eval(`${code}\n//# sourceURL=${source}`);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanNavigation=RomanNavigation;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  host.attachShadow({ mode: "open" });
  const navigation = window.RomanNavigation.createStorefrontNavigation(host);
  t.after(() => {
    navigation.dispose();
    window.close();
  });
  return { window, navigation, reports, native, runtimeObservers };
}

for (const callback of [
  "constructor() { super(); throw new Error('pricing failed'); }",
  "connectedCallback() { throw new Error('pricing failed'); }",
]) {
  test(`theme ${callback.startsWith("constructor") ? "constructor" : "connection"} failure reaches native recovery after DOM insertion`, async (t) => {
    const ctx = setup(
      t,
      `customElements.define('pricing-control', class extends HTMLElement { ${callback} });`,
    );
    assert.equal(
      await ctx.navigation.navigate("/products/blind"),
      "handed_off",
    );
    assert.equal(ctx.native.length, 1);
    assert.match(ctx.reports[0][1].reason, /pricing failed/);
    assert.equal(ctx.navigation.getSnapshot().pending, false);
    assert.equal(ctx.runtimeObservers.size, 0);
  });
}

test("successful connections and unrelated third-party errors do not trigger theme recovery", async (t) => {
  const ctx = setup(
    t,
    `customElements.define('pricing-control', class extends HTMLElement { connectedCallback() { this.setAttribute('ready', 'true'); window.dispatchEvent(new ErrorEvent('error', {filename:'https://analytics.example/script.js', message:'analytics failed'})); } });`,
  );
  assert.equal(await ctx.navigation.navigate("/products/blind"), "navigated");
  assert.equal(
    ctx.window.document.querySelector("pricing-control").getAttribute("ready"),
    "true",
  );
  assert.deepEqual(ctx.native, []);
  assert.deepEqual(ctx.reports, []);
  assert.equal(ctx.runtimeObservers.size, 0);
  ctx.window.dispatchEvent(
    new ctx.window.ErrorEvent("error", {
      filename: asset,
      message: "later unrelated work",
    }),
  );
  assert.deepEqual(
    ctx.reports,
    [],
    "The commit error listener is not retained after activation",
  );
});


test("retrying a model page with failed initialization cannot succeed via the same-page shortcut", async (t) => {
  const ctx = setup(t, "customElements.define('pricing-control', class extends HTMLElement { connectedCallback() { throw new Error('pricing failed'); } });");
  assert.equal(await ctx.navigation.navigate("/products/blind", undefined, { source: "model" }), "failed");
  assert.ok(ctx.navigation.getSnapshot().error);
  assert.equal(await ctx.navigation.navigate("/products/blind", undefined, { source: "model" }), "failed");
  assert.ok(ctx.navigation.getSnapshot().error);
  assert.deepEqual(ctx.native, []);
});
