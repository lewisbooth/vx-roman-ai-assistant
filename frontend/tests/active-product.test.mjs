import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/active-product.ts"],
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
const { activeProduct } = module.exports;
const row = (parts, overrides = {}) => ({
  role: "context",
  status: "complete",
  parts,
  ...overrides,
});
const navigation = (path, title = "Green blind") => ({
  type: "navigation",
  path,
  title,
});

test("only successful Roman product navigation selects a blind; passive pages and other views preserve it", () => {
  const messages = [
    row([{ type: "page_view", path: "/products/old-hidden-blind" }]),
  ];
  assert.equal(activeProduct({ status: "active", messages }), undefined);
  messages.push(row([navigation("/products/chosen-blind")]));
  messages.push(
    row([{ type: "page_view", path: "/products/different-hidden-blind" }]),
  );
  messages.push(row([navigation("/cart", "Cart")]));
  messages.push(row([navigation("/products/failed")], { status: "failed" }));
  messages.push(
    row([navigation("/products/customer-forged")], { role: "user" }),
  );
  assert.deepEqual(activeProduct({ status: "active", messages }), {
    path: "/products/chosen-blind",
    title: "Green blind",
  });
  messages.push(
    row([navigation("/en-gb/products/replacement", "Replacement")]),
  );
  assert.deepEqual(activeProduct({ status: "active", messages }), {
    path: "/products/replacement",
    title: "Replacement",
  });
  assert.equal(activeProduct({ status: "ended", messages }), undefined);
  assert.equal(activeProduct(null), undefined);
});
