import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/conversations/storefront-turn.server.ts"],
  bundle: true, write: false, platform: "node", format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module, module.exports);
const { StorefrontTurn, parseStorefrontCall } = module.exports;
const productPath = "/products/shade";
const lineKey = "123:configured";
const added = {
  status: "added", message: "Added one configured blind.", quantityAdded: 1,
  addedProduct: { productPath, title: "Shade", lineKey },
};
const cart = (quantity = 1, key = lineKey) => ({
  currency: "GBP", itemCount: quantity, totalPriceMinorUnits: quantity * 1000,
  items: [{ lineKey: key, title: "Shade", variantId: 123, quantity, linePriceMinorUnits: quantity * 1000 }],
});
function complete(turn, name, args, outcome) {
  const call = parseStorefrontCall(name, args);
  try {
    turn.before(call);
    if (outcome instanceof Error) throw outcome;
    turn.after(call, outcome);
  } catch (error) {
    turn.failed(name);
    throw error;
  }
}
function afterAdd(result = added, name = "add_to_cart") {
  const turn = new StorefrontTurn();
  complete(turn, name, { productPath }, result);
  return turn;
}

test("a confirmed addition permits one fresh quantity increase on its exact line, retaining existing copies", () => {
  const turn = afterAdd();
  assert.equal(turn.allows("set_cart_quantity"), false, "addition alone is not a fresh cart read");
  complete(turn, "get_cart", {}, cart(5));
  assert.equal(turn.allows("set_cart_quantity"), true);
  for (const name of ["add_to_cart", "add_sample_to_cart", "remove_from_cart", "clear_cart", "configure_product", "apply_measurements"])
    assert.equal(turn.allows(name), false, name);
  complete(turn, "set_cart_quantity", { lineKey, quantity: 7 }, {
    status: "updated", message: "Two remaining copies added.", cart: cart(7),
  });
  complete(turn, "get_cart", {}, cart(7));
  assert.equal(turn.allows("set_cart_quantity"), false, "a fresh read cannot restore a consumed continuation");
});

test("quantity continuation requires a verified full-product addition with its exact line identity", () => {
  for (const result of [
    { status: "handed_off", message: "May still complete." },
    { status: "uncertain", message: "May still complete." },
    { status: "cancelled", message: "Not submitted." },
    { status: "needs_configuration", message: "Not submitted." },
    { status: "added", message: "Added.", quantityAdded: 1 },
    { status: "added", message: "Added.", addedProduct: added.addedProduct },
    { ...added, addedProduct: { ...added.addedProduct, productPath: "/products/other" } },
  ]) {
    const turn = afterAdd(result);
    complete(turn, "get_cart", {}, cart());
    assert.equal(turn.allows("set_cart_quantity"), false, JSON.stringify(result));
  }
  const sample = afterAdd({
    status: "added", message: "Sample added.", addedSample: { productPath, title: "Shade" },
  }, "add_sample_to_cart");
  complete(sample, "get_cart", {}, cart());
  assert.equal(sample.allows("set_cart_quantity"), false);
  const failed = new StorefrontTurn();
  assert.throws(() => complete(failed, "add_to_cart", { productPath }, new Error("Disconnected")));
  complete(failed, "get_cart", {}, cart());
  assert.equal(failed.allows("set_cart_quantity"), false);
});

test("a pre-add, missing-line, failed or superseded cart read cannot authorize the continuation", () => {
  const turn = new StorefrontTurn();
  complete(turn, "get_cart", {}, cart());
  complete(turn, "add_to_cart", { productPath }, added);
  assert.equal(turn.allows("set_cart_quantity"), false);
  complete(turn, "get_cart", {}, cart(1, "123:other"));
  assert.equal(turn.allows("set_cart_quantity"), false);
  complete(turn, "get_cart", {}, cart());
  assert.equal(turn.allows("set_cart_quantity"), true);
  assert.throws(() => complete(turn, "get_cart", {}, new Error("Read failed")));
  assert.equal(turn.allows("set_cart_quantity"), false);
  complete(turn, "get_cart", {}, cart());
  complete(turn, "navigate", { path: "/cart" }, { status: "navigated", path: "/cart" });
  assert.equal(turn.allows("set_cart_quantity"), false);
});

test("wrong-line and non-increasing attempts consume the continuation without a write", () => {
  for (const args of [
    { lineKey: "123:other", quantity: 3 },
    { lineKey, quantity: 1 },
    { lineKey, quantity: 2 },
  ]) {
    const turn = afterAdd();
    complete(turn, "get_cart", {}, cart(2));
    assert.throws(() => complete(turn, "set_cart_quantity", args, {}), /remaining copies/);
    complete(turn, "get_cart", {}, cart(2));
    assert.equal(turn.allows("set_cart_quantity"), false);
  }
});

test("every attempted quantity continuation stays consumed, including failure and no-submission results", () => {
  for (const result of [
    { status: "updated", message: "Updated.", cart: cart(3) },
    { status: "handed_off", message: "May complete." },
    { status: "uncertain", message: "May complete." },
    { status: "needs_cart_page", message: "Not submitted." },
    new Error("Disconnected after submission"),
  ]) {
    const turn = afterAdd();
    complete(turn, "get_cart", {}, cart());
    if (result instanceof Error)
      assert.throws(() => complete(turn, "set_cart_quantity", { lineKey, quantity: 3 }, result));
    else complete(turn, "set_cart_quantity", { lineKey, quantity: 3 }, result);
    complete(turn, "get_cart", {}, cart());
    assert.equal(turn.allows("set_cart_quantity"), false);
    assert.equal(turn.allows("add_to_cart"), false);
  }
});
