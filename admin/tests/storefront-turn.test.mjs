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
const cart = {
  currency: "GBP", itemCount: 7, totalPriceMinorUnits: 7000,
  items: [{ lineKey, title: "Shade", variantId: 123, quantity: 7, linePriceMinorUnits: 7000 }],
};
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

test("one native addition consumes the cart mutation allowance even after a fresh cart read", () => {
  for (const result of [
    { status: "added", message: "Three added.", quantityAdded: 3, addedProduct: { productPath, title: "Shade", lineKey } },
    { status: "added", message: "Only one was confirmed.", quantityAdded: 1, addedProduct: { productPath, title: "Shade", lineKey } },
    { status: "handed_off", message: "May still complete." },
    { status: "uncertain", message: "May still complete." },
    { status: "cancelled", message: "Not submitted." },
    { status: "needs_configuration", message: "Not submitted." },
    new Error("Disconnected after submission"),
  ]) {
    const turn = new StorefrontTurn();
    if (result instanceof Error)
      assert.throws(() => complete(turn, "add_to_cart", { productPath, quantity: 3 }, result));
    else complete(turn, "add_to_cart", { productPath, quantity: 3 }, result);
    complete(turn, "get_cart", {}, cart);
    for (const name of ["add_to_cart", "add_sample_to_cart", "remove_from_cart", "set_cart_quantity", "clear_cart", "configure_product", "apply_measurements"])
      assert.equal(turn.allows(name), false, name);
    assert.throws(() => complete(turn, "set_cart_quantity", { lineKey, quantity: 9 }, {}), /not available/);
  }
});

test("an explicitly requested existing-line quantity change remains a separate single mutation", () => {
  const turn = new StorefrontTurn();
  complete(turn, "get_cart", {}, cart);
  assert.equal(turn.allows("set_cart_quantity"), true);
  complete(turn, "set_cart_quantity", { lineKey, quantity: 7 }, { status: "updated", message: "Already seven.", cart });
  complete(turn, "get_cart", {}, cart);
  assert.equal(turn.allows("set_cart_quantity"), false);
  assert.equal(turn.allows("add_to_cart"), false);
});
