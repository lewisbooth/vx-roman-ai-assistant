import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { cwd } from "node:process";
import { setImmediate } from "node:timers/promises";

const bundle = await build({
  stdin: {
    contents:
      "export { applyMeasurements } from './frontend/src/tools/measurements'; export { createStorefrontExecutor } from './frontend/src/session/storefront-executor';",
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Measurement",
  platform: "browser",
});
const draft = {
  productPath: "/products/blind",
  width: 300,
  height: 400,
  unit: "mm",
  kind: "order",
  mount: "exact",
  updatedAt: "2026-09-15T00:00:00.000Z",
};
function setup(t) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main"><dynamic-pricing><form data-dynamic-pricing-form><dynamic-pricing-measurements><select data-measurement-select><option value="mm">MM</option><option value="cm">CM</option></select><div data-input-measurement-group="mm" data-active-input-measurement><input name="_width" data-width-input type="number" min="100" max="2000" step="1" value="200"><input name="_drop" data-drop-input type="number" min="100" max="2000" step="1" value="250"></div><div data-input-measurement-group="cm"><input data-width-input type="number" value="20"><input data-drop-input type="number" value="25"></div></dynamic-pricing-measurements><button type="submit">Add</button></form></dynamic-pricing></main></app-provider>`,
    {
      url: "https://hd-dev-single.myshopify.com/products/blind",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  window.customElements.define(
    "dynamic-pricing-measurements",
    class extends window.HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
      }
    },
  );
  window.eval(`${bundle.outputFiles[0].text};window.Measurement=Measurement;`);
  const form = window.document.querySelector("form");
  const events = [];
  for (const kind of ["input", "change"])
    form.addEventListener(kind, () =>
      events.push(
        [...form.querySelectorAll("[data-active-input-measurement] input")].map(
          (i) => i.value,
        ),
      ),
    );
  form.addEventListener("submit", () =>
    assert.fail("Measurements must never submit a purchase"),
  );
  t.after(() => window.close());
  return { window, form, events, ...window.Measurement };
}

test("confirmed order dimensions update the exact active pair and notify the theme without touching inactive units or purchasing", (t) => {
  const ctx = setup(t);
  const result = ctx.applyMeasurements(
    draft,
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.equal(result.draftUpdatedAt, draft.updatedAt);
  assert.deepEqual(ctx.events, [
    ["300", "400"],
    ["300", "400"],
    ["300", "400"],
    ["300", "400"],
  ]);
  assert.equal(
    ctx.form.querySelector('[data-input-measurement-group="cm"] input').value,
    "20",
  );
});

test("window drafts, unit mismatch, inches, wrong products and invalid increments never touch live values", async (t) => {
  for (const change of [
    { kind: "window" },
    { unit: "cm" },
    { unit: "in" },
    { productPath: "/products/other" },
    { width: 300.5 },
    { height: 2500 },
  ])
    await t.test(JSON.stringify(change), (t) => {
      const ctx = setup(t);
      const before = ctx.form.innerHTML;
      assert.throws(() =>
        ctx.applyMeasurements(
          { ...draft, ...change },
          new ctx.window.AbortController().signal,
        ),
      );
      assert.equal(ctx.form.innerHTML, before);
      assert.deepEqual(ctx.events, []);
    });
});

test("unit changes or aborted work never alter the current fields", async (t) => {
  for (const change of ["unit", "abort"])
    await t.test(change, (t) => {
      const ctx = setup(t),
        controller = new ctx.window.AbortController();
      if (change === "unit") ctx.form.querySelector("select").value = "cm";
      if (change === "abort") controller.abort();
      assert.throws(() => ctx.applyMeasurements(draft, controller.signal));
      assert.deepEqual(ctx.events, []);
    });
});

test("a theme correction is reported as uncertain instead of claiming exact application", (t) => {
  const ctx = setup(t),
    width = ctx.form.querySelector(
      "[data-active-input-measurement] [data-width-input]",
    );
  width.addEventListener("change", () => {
    width.value = "301";
  });
  assert.equal(
    ctx.applyMeasurements(draft, new ctx.window.AbortController().signal)
      .status,
    "uncertain",
  );
});

test("a theme-hidden active unit group cannot be applied", (t) => {
  const ctx = setup(t);
  ctx.form.querySelector("[data-active-input-measurement]").style.display =
    "none";
  assert.throws(() =>
    ctx.applyMeasurements(draft, new ctx.window.AbortController().signal),
  );
  assert.deepEqual(ctx.events, []);
});

test("theme replacement of the active fields reports uncertainty instead of confirming detached inputs", (t) => {
  const ctx = setup(t);
  const width = ctx.form.querySelector(
    "[data-active-input-measurement] [data-width-input]",
  );
  width.addEventListener(
    "input",
    () => width.replaceWith(width.cloneNode(true)),
    { once: true },
  );
  const result = ctx.applyMeasurements(
    draft,
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "uncertain");
});

test("ordinary measurement execution fills current controls after its queue wait without preparing an approval", async (t) => {
  const ctx = setup(t);
  let release;
  const executor = ctx.createStorefrontExecutor({
    execute: async (name) => {
      assert.equal(name, "search_products");
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(() => executor.dispose());
  const search = executor.execute("search_products", { query: "blind" });
  const applying = executor.execute("apply_measurements", {
    productPath: draft.productPath,
    draft,
  });
  await setImmediate();
  assert.deepEqual(ctx.events, []);
  const previous = ctx.form.querySelector(
    "[data-active-input-measurement] [data-width-input]",
  );
  const current = previous.cloneNode(true);
  previous.replaceWith(current);
  current.value = "500";
  release({ products: [] });
  await search;
  assert.equal((await applying).status, "applied");
  assert.equal(current.value, "300");
  assert.equal(previous.value, "200");
  assert.deepEqual(ctx.events, [
    ["300", "400"],
    ["300", "400"],
    ["300", "400"],
    ["300", "400"],
  ]);
});

test("queued measurement application validates the current page and cancellation before writing", async (t) => {
  for (const change of ["page", "unit", "abort"])
    await t.test(change, async (t) => {
      const ctx = setup(t);
      let release;
      const executor = ctx.createStorefrontExecutor({
        execute: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });
      t.after(() => executor.dispose());
      const controller = new ctx.window.AbortController();
      const search = executor.execute("search_products", { query: "blind" });
      const applying = executor.execute(
        "apply_measurements",
        { productPath: draft.productPath, draft },
        controller.signal,
      );
      const rejected = assert.rejects(applying);
      await setImmediate();
      if (change === "page")
        ctx.window.history.pushState({}, "", "/products/other");
      if (change === "unit") ctx.form.querySelector("select").value = "cm";
      if (change === "abort") controller.abort();
      release({ products: [] });
      await search;
      await rejected;
      assert.deepEqual(ctx.events, []);
    });
});
