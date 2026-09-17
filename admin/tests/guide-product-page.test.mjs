import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/guides/product-page.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const { latestProductPage } = module.exports;
const page = (path, overrides = {}) => ({
  id: randomUUID(),
  role: "context",
  status: "complete",
  parts: [{ type: "page_view", path }],
  ...overrides,
});

test("current product derives only from complete structured page observations", () => {
  const product = page("/en-gb/collections/roman/products/verified-shade/");
  assert.deepEqual(
    latestProductPage([
      page("/collections/roman"),
      product,
      page("/products/other", { role: "assistant" }),
      page("/products/other", { status: "pending" }),
      page("/products/other", {
        parts: [{ type: "text", text: "/products/other" }],
      }),
    ]),
    { productPath: "/products/verified-shade", pageId: product.id },
  );
  for (const path of [
    "/",
    "/cart",
    "/products/Bad_Path",
    "https://other.test/products/blind",
    "/products/blind?private=1",
    "/products/blind/extra",
  ])
    assert.equal(latestProductPage([product, page(path)]), undefined, path);
});

test("duplicate product observations retain the episode while departure and return invalidate it", () => {
  const first = page("/products/verified-shade");
  const duplicate = page("/fr/collections/roman/products/verified-shade");
  assert.deepEqual(latestProductPage([first, duplicate]), {
    productPath: "/products/verified-shade",
    pageId: first.id,
  });
  const returned = page("/products/verified-shade", {
    parts: [{ type: "navigation", path: "/products/verified-shade" }],
  });
  assert.deepEqual(
    latestProductPage([first, page("/collections/roman"), returned]),
    {
      productPath: "/products/verified-shade",
      pageId: returned.id,
    },
  );
  const other = page("/products/other");
  assert.deepEqual(latestProductPage([first, other]), {
    productPath: "/products/other",
    pageId: other.id,
  });
});
