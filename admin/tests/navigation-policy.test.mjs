import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/navigation-tool.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { parseNavigationCall, parseNavigationResult, parseNavigationPart } =
  await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );

test("navigation results accept old executors and literal bounded titles; notifications remove queries and fragments", () => {
  const result = { status: "navigated", path: "/search?q=roller#results" };
  assert.deepEqual(parseNavigationResult(result), result);
  assert.deepEqual(
    parseNavigationResult({ ...result, title: "  <Shade> & **Blinds**  " }),
    { ...result, title: "<Shade> & **Blinds**" },
  );
  for (const invalid of [
    null,
    { ...result, status: "pending" },
    { ...result, path: "/account" },
    { ...result, extra: true },
    ...["", " ", "x".repeat(201), "Title\nagain", 5].map((title) => ({
      ...result,
      title,
    })),
  ])
    assert.throws(() => parseNavigationResult(invalid));
  const part = {
    type: "navigation",
    version: 1,
    invocationId: "6dedf5cd-9d29-4c06-bcf6-ce5d3b49b7a9",
    path: "/search",
    title: "Search",
  };
  assert.deepEqual(parseNavigationPart(part), part);
  for (const invalid of [
    { ...part, path: result.path },
    { ...part, path: "/cart#contents" },
    { ...part, invocationId: "bad" },
    { ...part, version: 2 },
    { ...part, extra: true },
    { ...part, title: "" },
  ])
    assert.throws(() => parseNavigationPart(invalid));
});

test("model navigation accepts public page categories and specific read queries", () => {
  for (const path of [
    "/",
    "/cart",
    "/en-gb/cart/",
    "/products/roman?variant=123#measure",
    "/collections/all",
    "/collections/roller/blackout",
    "/en/collections/all/products/roman",
    "/pages/measuring",
    "/policies/privacy-policy",
    "/blogs/advice/measuring",
    "/blogs/advice/tagged/roller",
    "/search?q=blackout%20blinds&type=product&options%5Bprefix%5D=last",
    "/collections/all?filter.p.product_type=Roller&sort_by=price-ascending&page=2",
    "/products/%C3%A9cru",
  ]) {
    assert.equal(
      parseNavigationCall({ path }).path,
      new URL(path, "https://storefront.invalid").pathname +
        new URL(path, "https://storefront.invalid").search +
        new URL(path, "https://storefront.invalid").hash,
    );
  }
});

test("model navigation rejects mutations, redirects and ambiguous encoded paths before any request", () => {
  for (const path of [
    "/cart/123:1?storefront=true",
    "/en-gb/cart/123:1",
    "/cart/add?id=123",
    "/cart/change?line=1&quantity=0",
    "/cart/clear",
    "/cart.js",
    "/cart?discount=FREE",
    "/checkout",
    "/account/logout",
    "/apps/anything",
    "/api/anything",
    "/discount/FREE?redirect=/cart",
    "/%63art/123:1",
    "/c%61rt/clear",
    "/cart%2fclear",
    "/cart%252fclear",
    "/products/../cart/clear",
    "/products/%2e%2e/cart/clear",
    "/products/foo?return_to=/cart/clear",
    "/search?q=ok&redirect=/cart/clear",
    "/products/a?variant=12&variant=34",
    "/cart?attributes[x]=y",
    "/products/a\\b",
    "/products/a%00",
    "//attacker.example/cart",
    "/products//a",
  ]) {
    assert.throws(() => parseNavigationCall({ path }), undefined, path);
  }
});
