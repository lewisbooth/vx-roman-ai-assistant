import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {JSDOM} from "jsdom";

const bundle = await build({entryPoints: ["frontend/src/visualizations/entry.ts"], bundle: true, write: false, format: "cjs", platform: "node"});
function setup(t) {
  const dom = new JSDOM('<body class="template-product"><app-provider><main id="main"><main-product update-url="true" product-url="/products/example"><h1>Example\n blind</h1><dynamic-pricing><form data-dynamic-pricing-form></form></dynamic-pricing></main-product></main></app-provider><button data-roman-visualize-product="/products/example"><span>Visualize</span></button></body>', {url: "https://shop.example/products/example"});
  t.after(() => dom.window.close());
  const module = {exports: {}};
  new Function("module", "exports", "window", "document", "Element", bundle.outputFiles[0].text)(module, module.exports, dom.window, dom.window.document, dom.window.Element);
  return {...module.exports, window: dom.window, document: dom.window.document};
}

test("visualization entry requires a single native current product form/title and canonical path", (t) => {
  const ctx = setup(t);
  assert.deepEqual(ctx.currentVisualizationProduct(), {path: "/products/example", title: "Example blind"});
  for (const path of ["/products/other", "https://other.example/products/example", "/products/example?launch=true", "/products/example#preview"])
    assert.equal(ctx.currentVisualizationProduct(path), undefined);
  const form = ctx.document.querySelector("form");
  form.after(form.cloneNode()); assert.equal(ctx.currentVisualizationProduct(), undefined); form.nextSibling.remove();
  const title = ctx.document.querySelector("h1");
  title.after(title.cloneNode(true)); assert.equal(ctx.currentVisualizationProduct(), undefined); title.nextSibling.remove();
  ctx.document.querySelector("main-product").setAttribute("product-url", "/products/other");
  assert.equal(ctx.currentVisualizationProduct(), undefined);
});

test("native visualization identity retains locale/collection path parity and rejects cart editing", (t) => {
  const ctx = setup(t);
  for (const path of ["/products/example/", "/en/products/example", "/en-gb/products/example", "/collections/blinds/products/example", "/en-gb/collections/blinds/products/example/"]) {
    ctx.window.history.replaceState({}, "", path);
    assert.deepEqual(ctx.currentVisualizationProduct(), {path: "/products/example", title: "Example blind"}, path);
  }
  ctx.window.history.replaceState({}, "", "/products/example?line=cart-item");
  assert.equal(ctx.currentVisualizationProduct(), undefined);
});
