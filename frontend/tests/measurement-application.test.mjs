import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { cwd } from "node:process";
import { setImmediate } from "node:timers/promises";

const bundle = await build({
  stdin: {
    contents:
      "export { applyMeasurements, readProductMeasurements } from './frontend/src/tools/measurements'; export { createStorefrontExecutor } from './frontend/src/session/storefront-executor';",
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
        const updateUnit = (event) => {
          if (!event.target.matches("[data-measurement-select]")) return;
          for (const group of this.querySelectorAll(
            "[data-input-measurement-group]",
          )) {
            const active =
              group.dataset.inputMeasurementGroup === event.target.value;
            group.toggleAttribute("data-active-input-measurement", active);
            group.hidden = !active;
            if (active && event.target.value === "cm") {
              for (const input of group.querySelectorAll("input")) {
                input.min = "10";
                input.max = "200";
                input.step = "0.1";
              }
            }
            if (active && event.target.value === "inches") {
              for (const select of group.querySelectorAll(
                "[data-width-input],[data-drop-input]",
              )) {
                select.innerHTML = Array.from(
                  { length: 71 },
                  (_, index) =>
                    `<option value="${index + 4}">${index + 4}</option>`,
                ).join("");
              }
            }
          }
        };
        this.addEventListener("input", updateUnit);
        this.addEventListener("change", updateUnit);
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
  form.addEventListener("submit", (event) => {
    if (!event.submitter?.hasAttribute("data-instant-price-button"))
      assert.fail("Measurements must never submit a purchase");
  });
  t.after(() => window.close());
  return { window, form, events, ...window.Measurement };
}

test("confirmed order dimensions update the exact active pair and notify the theme without touching inactive units or purchasing", async (t) => {
  const ctx = setup(t);
  const result = await ctx.applyMeasurements(
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

test("window drafts, unsupported inches, wrong products and invalid increments never touch live values", async (t) => {
  for (const change of [
    { kind: "window" },
    { unit: "in" },
    { productPath: "/products/other" },
    { width: 300.5 },
    { height: 2500 },
  ])
    await t.test(JSON.stringify(change), async (t) => {
      const ctx = setup(t);
      const before = ctx.form.innerHTML;
      await assert.rejects(() =>
        ctx.applyMeasurements(
          { ...draft, ...change },
          new ctx.window.AbortController().signal,
        ),
      );
      assert.equal(ctx.form.innerHTML, before);
      assert.deepEqual(ctx.events, []);
    });
});

test("disabled units or aborted work never alter the current fields", async (t) => {
  for (const change of ["disabled", "abort"])
    await t.test(change, async (t) => {
      const ctx = setup(t),
        controller = new ctx.window.AbortController();
      if (change === "disabled")
        ctx.form.querySelector("select").disabled = true;
      if (change === "abort") controller.abort();
      await assert.rejects(() =>
        ctx.applyMeasurements(draft, controller.signal),
      );
      assert.deepEqual(ctx.events, []);
    });
});

test("a theme correction is reported as uncertain instead of claiming exact application", async (t) => {
  const ctx = setup(t),
    width = ctx.form.querySelector(
      "[data-active-input-measurement] [data-width-input]",
    );
  width.addEventListener("change", () => {
    width.value = "301";
  });
  assert.equal(
    (
      await ctx.applyMeasurements(
        draft,
        new ctx.window.AbortController().signal,
      )
    ).status,
    "uncertain",
  );
});

test("a theme-hidden active unit group cannot be applied", async (t) => {
  const ctx = setup(t);
  ctx.form.querySelector("[data-active-input-measurement]").style.display =
    "none";
  await assert.rejects(() =>
    ctx.applyMeasurements(draft, new ctx.window.AbortController().signal),
  );
  assert.deepEqual(ctx.events, []);
});

test("theme replacement of the active fields reports uncertainty instead of confirming detached inputs", async (t) => {
  const ctx = setup(t);
  const width = ctx.form.querySelector(
    "[data-active-input-measurement] [data-width-input]",
  );
  width.addEventListener(
    "input",
    () => width.replaceWith(width.cloneNode(true)),
    { once: true },
  );
  const result = await ctx.applyMeasurements(
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
  for (const change of ["page", "disabled", "abort"])
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
      if (change === "disabled")
        ctx.form.querySelector("select").disabled = true;
      if (change === "abort") controller.abort();
      release({ products: [] });
      await search;
      await rejected;
      assert.deepEqual(ctx.events, []);
    });
});

test("confirmed 500 by 500 mm switches a selected cm theme back to mm and fills both live dimensions", async (t) => {
  const ctx = setup(t),
    units = ctx.form.querySelector("select");
  units.value = "cm";
  units.dispatchEvent(new ctx.window.Event("change", { bubbles: true }));
  const result = await ctx.applyMeasurements(
    { ...draft, width: 500, height: 500 },
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.equal(units.value, "mm");
  assert.equal(
    ctx.form.querySelector("[data-active-input-measurement]").dataset
      .inputMeasurementGroup,
    "mm",
  );
  assert.deepEqual(
    [
      ...ctx.form.querySelectorAll('[data-input-measurement-group="mm"] input'),
    ].map((input) => input.value),
    ["500", "500"],
  );
  assert.deepEqual(ctx.events.slice(-4), Array(4).fill(["500", "500"]));
});

test("cm application uses the theme's newly selected range and exact decimal step without converting values", async (t) => {
  const ctx = setup(t);
  const result = await ctx.applyMeasurements(
    { ...draft, unit: "cm", width: 30.1, height: 40.2 },
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.equal(ctx.form.querySelector("select").value, "cm");
  assert.deepEqual(
    [
      ...ctx.form.querySelectorAll('[data-input-measurement-group="cm"] input'),
    ].map((input) => input.value),
    ["30.1", "40.2"],
  );
});

function addInches(ctx) {
  const component = ctx.form.querySelector("dynamic-pricing-measurements");
  component
    .querySelector("select")
    .insertAdjacentHTML("beforeend", '<option value="inches">Inches</option>');
  const fractions = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
    .map((value) => `<option value="${value}">${value}</option>`)
    .join("");
  component.insertAdjacentHTML(
    "beforeend",
    `<div data-input-measurement-group="inches" hidden><select data-width-input></select><select data-width-inches-input>${fractions}</select><select data-drop-input></select><select data-drop-inches-input>${fractions}</select></div>`,
  );
}

test("inch dimensions use only the exact available whole and fractional options", async (t) => {
  const ctx = setup(t);
  addInches(ctx);
  const result = await ctx.applyMeasurements(
    { ...draft, unit: "in", width: 20.125, height: 30.75 },
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.equal(
    ctx.form.querySelector("[data-measurement-select]").value,
    "inches",
  );
  assert.deepEqual(
    [
      ...ctx.form.querySelectorAll(
        '[data-input-measurement-group="inches"] select',
      ),
    ].map((input) => input.value),
    ["20", "0.125", "30", "0.75"],
  );
});

test("unsupported inch precision is never rounded and a unit-only change is explicitly uncertain", async (t) => {
  const ctx = setup(t);
  addInches(ctx);
  const result = await ctx.applyMeasurements(
    { ...draft, unit: "in", width: 20.1, height: 30.75 },
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "uncertain");
  const values = [
    ...ctx.form.querySelectorAll(
      '[data-input-measurement-group="inches"] select',
    ),
  ].map((input) => input.value);
  assert.deepEqual(values, ["4", "0", "4", "0"]);
});

test("cancellation or theme failure during a unit change never reports dimensions as applied", async (t) => {
  for (const failure of ["abort", "replace", "reject"])
    await t.test(failure, async (t) => {
      const ctx = setup(t),
        controller = new ctx.window.AbortController();
      const units = ctx.form.querySelector("[data-measurement-select]");
      units.addEventListener("input", () => {
        if (failure === "abort") controller.abort();
        if (failure === "replace") units.replaceWith(units.cloneNode(true));
        if (failure === "reject") units.value = "mm";
      });
      assert.equal(
        (
          await ctx.applyMeasurements(
            { ...draft, unit: "cm", width: 30, height: 40 },
            controller.signal,
          )
        ).status,
        "uncertain",
      );
    });
});

test("configuration measurement reading preserves exact units and reports missing fields as unknown", async (t) => {
  const ctx = setup(t);
  addInches(ctx);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.readProductMeasurements(ctx.form))),
    { unit: "mm", width: 200, height: 250, availableUnits: ["mm", "cm", "in"] },
  );
  ctx.form.querySelector(
    "[data-active-input-measurement] [data-width-input]",
  ).value = "";
  assert.equal(ctx.readProductMeasurements(ctx.form).width, null);
  await ctx.applyMeasurements(
    { ...draft, unit: "in", width: 20.125, height: 30.75 },
    new ctx.window.AbortController().signal,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.readProductMeasurements(ctx.form))),
    {
      unit: "in",
      width: 20.125,
      height: 30.75,
      availableUnits: ["mm", "cm", "in"],
    },
  );
});

test("theme-created duplicate active dimensions cannot be reported as applied", async (t) => {
  const ctx = setup(t),
    width = ctx.form.querySelector(
      "[data-active-input-measurement] [data-width-input]",
    );
  width.addEventListener("change", () => width.after(width.cloneNode(true)), {
    once: true,
  });
  assert.equal(
    (
      await ctx.applyMeasurements(
        draft,
        new ctx.window.AbortController().signal,
      )
    ).status,
    "uncertain",
  );
});

test("initial price readiness and invalid-configuration markers do not prevent correcting enabled dimensions", async (t) => {
  for (const state of ["variant-loading", "blocking"])
    await t.test(state, async (t) => {
      const ctx = setup(t);
      ctx.form.classList.add(state);
      for (const input of ctx.form.querySelectorAll(
        "[data-active-input-measurement] input",
      ))
        input.value = "";
      assert.equal(
        (
          await ctx.applyMeasurements(
            { ...draft, width: 500, height: 500 },
            new ctx.window.AbortController().signal,
          )
        ).status,
        "applied",
      );
      assert.deepEqual(
        [
          ...ctx.form.querySelectorAll("[data-active-input-measurement] input"),
        ].map((input) => input.value),
        ["500", "500"],
      );
    });
});

test("actual pricing and cart work still prevent concurrent dimension edits", async (t) => {
  for (const state of ["loading", "adding", "adding-sample"])
    await t.test(state, async (t) => {
      const ctx = setup(t);
      ctx.form.classList.add(state);
      await assert.rejects(() =>
        ctx.applyMeasurements(draft, new ctx.window.AbortController().signal),
      );
      assert.deepEqual(ctx.events, []);
    });
});

function quoteTheme(ctx, outcome = "ready") {
  const product = ctx.form.parentElement;
  product.dataset.multistep = "true";
  ctx.form.classList.add("variant-loading");
  ctx.form.insertAdjacentHTML(
    "beforeend",
    '<button type="submit" data-instant-price-button data-pdp-form-screen="pre-price">Continue customizing</button><div data-pdp-form-screen="post-price" hidden>Product choices</div>',
  );
  const submissions = [];
  ctx.window.customElements.define(
    "dynamic-pricing",
    class extends ctx.window.HTMLElement {
      constructor() {
        super();
        this._instantPriceButton = this.querySelector(
          "[data-instant-price-button]",
        );
        this._addToCartButtons = [
          ...this.querySelectorAll("[data-atc-button]"),
        ];
        const slot = ctx.window.document.createElement("slot");
        this.attachShadow({ mode: "open" }).append(slot);
        slot.addEventListener("submit", (event) => {
          submissions.push({
            guarded: event.defaultPrevented,
            submitter: event.submitter,
          });
          if (outcome === "unhandled") return;
          event.preventDefault();
          ctx.form.querySelector('[data-pdp-form-screen="post-price"]').hidden =
            false;
          ctx.form.querySelector("[data-instant-price-button]").hidden = true;
          ctx.form.classList.add("loading");
          if (outcome === "timeout") return;
          ctx.window.setTimeout(() => {
            ctx.form.classList.remove("loading", "variant-loading");
            if (outcome === "blocked") ctx.form.classList.add("blocking");
          }, 10);
        });
      }
    },
  );
  return submissions;
}

test("confirmed dimensions advance the exact native quote submitter and wait for pricing without adding to cart", async (t) => {
  const ctx = setup(t),
    submissions = quoteTheme(ctx);
  let complete = false;
  const pending = ctx
    .applyMeasurements(
      { ...draft, width: 500, height: 500 },
      new ctx.window.AbortController().signal,
    )
    .then((result) => {
      complete = true;
      return result;
    });
  assert.equal(complete, false);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].guarded, true);
  assert.equal(
    submissions[0].submitter.hasAttribute("data-instant-price-button"),
    true,
  );
  assert.equal(ctx.form.classList.contains("loading"), true);
  assert.equal((await pending).status, "applied");
  assert.equal(ctx.form.classList.contains("loading"), false);
  assert.deepEqual(
    [...ctx.form.querySelectorAll("[data-active-input-measurement] input")].map(
      (input) => input.value,
    ),
    ["500", "500"],
  );
});

test("a blocked or unhandled quote truthfully reports filled dimensions needing configuration", async (t) => {
  for (const outcome of ["blocked", "unhandled"])
    await t.test(outcome, async (t) => {
      const ctx = setup(t),
        submissions = quoteTheme(ctx, outcome);
      const result = await ctx.applyMeasurements(
        draft,
        new ctx.window.AbortController().signal,
      );
      assert.equal(result.status, "applied");
      assert.match(result.message, /still needs product configuration/);
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].guarded, true);
    });
});

test("quote wait cancellation, changed fields and timeout cannot become successful measurement results", async (t) => {
  for (const outcome of ["abort", "edited", "timeout"])
    await t.test(outcome, async (t) => {
      const ctx = setup(t),
        controller = new ctx.window.AbortController();
      quoteTheme(ctx, outcome === "timeout" ? "timeout" : "ready");
      if (outcome === "timeout") {
        const setTimeout = ctx.window.setTimeout.bind(ctx.window);
        ctx.window.setTimeout = (fn, delay) =>
          setTimeout(fn, delay === 15000 ? 20 : delay);
      }
      const pending = ctx.applyMeasurements(draft, controller.signal);
      if (outcome === "abort") controller.abort();
      if (outcome === "edited")
        ctx.form.querySelector(
          "[data-active-input-measurement] [data-width-input]",
        ).value = "600";
      assert.equal((await pending).status, "uncertain");
    });
});

test("the quote path refuses a mislabeled cart button", async (t) => {
  const ctx = setup(t),
    submissions = quoteTheme(ctx);
  ctx.form
    .querySelector("[data-instant-price-button]")
    .setAttribute("data-atc-button", "");
  const result = await ctx.applyMeasurements(
    draft,
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.match(result.message, /still needs product configuration/);
  assert.equal(submissions.length, 0);
});

test("the quote marker must match the exact submitter registered by the live theme", async (t) => {
  const ctx = setup(t),
    submissions = quoteTheme(ctx);
  ctx.form.parentElement._instantPriceButton = ctx.form.querySelector(
    "button:not([data-instant-price-button])",
  );
  const result = await ctx.applyMeasurements(
    draft,
    new ctx.window.AbortController().signal,
  );
  assert.equal(result.status, "applied");
  assert.match(result.message, /still needs product configuration/);
  assert.equal(submissions.length, 0);
});

test("single-step products wait through native debounced pricing without clicking a submitter", async (t) => {
  const ctx = setup(t),
    submissions = quoteTheme(ctx);
  ctx.form.parentElement.dataset.multistep = "false";
  ctx.form.addEventListener(
    "input",
    () => {
      ctx.window.setTimeout(() => {
        ctx.form.classList.add("loading");
        ctx.window.setTimeout(
          () => ctx.form.classList.remove("loading", "variant-loading"),
          20,
        );
      }, 150);
    },
    { once: true },
  );
  let complete = false;
  const pending = ctx
    .applyMeasurements(draft, new ctx.window.AbortController().signal)
    .then((result) => {
      complete = true;
      return result;
    });
  await new Promise((resolve) => ctx.window.setTimeout(resolve, 50));
  assert.equal(complete, false);
  assert.equal((await pending).status, "applied");
  assert.equal(ctx.form.classList.contains("loading"), false);
  assert.equal(ctx.form.classList.contains("variant-loading"), false);
  assert.equal(submissions.length, 0);
});
