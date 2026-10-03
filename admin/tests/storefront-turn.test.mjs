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

function configuration(overrides = {}) {
  return {
    status: "available",
    productPath,
    configurationId: "10000000-0000-4000-8000-000000000001",
    controls: [{ id: "c0", label: "Fit", kind: "radio", options: [
      { id: "o0", label: "Exact", selected: true, available: true },
    ] }],
    measurements: { width: 1200, height: 800, unit: "mm", availableUnits: ["mm"] },
    configuredPrice: "£45.00",
    message: "Current native configuration.",
    ...overrides,
  };
}
function readConfiguration(turn, result = configuration()) {
  complete(turn, "get_product_configuration", { productPath: result.productPath }, result);
}
function applyMeasurements(turn, result = { status: "applied", productPath }) {
  complete(turn, "apply_measurements", { productPath }, result);
}

test("successful native form work needs a fresh priced read before one same-product addition", () => {
  for (const name of ["configure_product", "apply_measurements"]) {
    const turn = new StorefrontTurn();
    readConfiguration(turn);
    complete(turn, name, name === "configure_product" ? {
      productPath, configurationId: configuration().configurationId, controlId: "c0", optionId: "o0",
    } : { productPath }, { status: "applied", productPath });
    assert.equal(turn.allows("add_to_cart"), false, "the earlier read was consumed by form work");
    assert.equal(turn.isConfigurationCompletion("add_to_cart"), false);
    readConfiguration(turn);
    assert.equal(turn.isConfigurationCompletion("add_to_cart"), true);
    assert.equal(turn.allows("add_to_cart"), true);
    for (const other of ["add_sample_to_cart", "remove_from_cart", "set_cart_quantity", "clear_cart"])
      assert.equal(turn.allows(other), false, other);
    assert.throws(() => complete(turn, "add_to_cart", { productPath: "/products/other", quantity: 3 }, {}), /same product/);
    complete(turn, "add_to_cart", { productPath, quantity: 3 }, { status: "added", quantityAdded: 3 });
    readConfiguration(turn);
    complete(turn, "get_cart", {}, cart);
    assert.equal(turn.allows("add_to_cart"), false);
    assert.equal(turn.isConfigurationCompletion("add_to_cart"), false);
    assert.equal(turn.allows("configure_product"), false);
    assert.equal(turn.allows("apply_measurements"), false);
  }
});

test("missing price, incomplete dimensions and other products cannot complete a configured addition", () => {
  const measured = configuration().measurements;
  for (const overrides of [
    { configuredPrice: undefined },
    { configuredPrice: null },
    { measurements: null },
    { measurements: { ...measured, width: null } },
    { measurements: { ...measured, height: null } },
    { measurements: { ...measured, unit: null } },
    { measurements: { ...measured, availableUnits: ["cm"] } },
    { productPath: "/products/other" },
    { status: "unavailable", configurationId: null, controls: [], measurements: null, configuredPrice: null },
  ]) {
    const turn = new StorefrontTurn();
    applyMeasurements(turn);
    const snapshot = configuration(overrides);
    if (snapshot.configuredPrice === undefined) delete snapshot.configuredPrice;
    readConfiguration(turn, snapshot);
    assert.equal(turn.allows("add_to_cart"), false, JSON.stringify(overrides));
    assert.equal(turn.isConfigurationCompletion("add_to_cart"), false);
    assert.throws(() => complete(turn, "add_to_cart", { productPath, quantity: 3 }, {}), /not available/);
  }
});

test("failed or uncertain form work cannot be rescued by a later valid readback", () => {
  for (const result of [
    { status: "uncertain", productPath },
    { status: "unsupported", productPath },
    { status: "cancelled", productPath },
    { status: "applied", productPath: "/products/other" },
    new Error("Disconnected after application"),
  ]) {
    const turn = new StorefrontTurn();
    if (result instanceof Error) assert.throws(() => applyMeasurements(turn, result));
    else applyMeasurements(turn, result);
    readConfiguration(turn);
    assert.equal(turn.allows("add_to_cart"), false);
    assert.equal(turn.isConfigurationCompletion("add_to_cart"), false);
  }
});

test("navigation and a failed fresh read invalidate a previously eligible completion", () => {
  for (const invalidate of [
    (turn) => complete(turn, "navigate", { path: "/products/other" }, {}),
    (turn) => assert.throws(() => complete(turn, "get_product_configuration", { productPath }, new Error("Read failed"))),
  ]) {
    const turn = new StorefrontTurn();
    applyMeasurements(turn);
    readConfiguration(turn);
    assert.equal(turn.allows("add_to_cart"), true);
    invalidate(turn);
    assert.equal(turn.allows("add_to_cart"), false);
  }
});

test("a configuration read without form work does not extend the cart budget", () => {
  const turn = new StorefrontTurn();
  readConfiguration(turn);
  assert.equal(turn.allows("add_to_cart"), true);
  assert.equal(turn.isConfigurationCompletion("add_to_cart"), false);
});

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
