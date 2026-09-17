import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/tools/product-pricing.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Pricing",
  platform: "browser",
});
const productPath = "/products/synthetic-roller";
function setup(t) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main"><dynamic-pricing><form data-dynamic-pricing-form><input type="number" min="1" value="30"><input type="number" min="1" value="66"><fieldset data-feature="82"><input type="radio" name="Control##82" value="Electric##204" data-feature-option="82##204" checked><input type="radio" name="Remote##6917##204" value="Remote##11434" data-feature-option="6917##11434"><span data-second-label="6917##11434">+£19.95</span><span data-second-label="6917##11434">+£19.95</span></fieldset><p data-dynamic-price> £65.89 </p><p data-dynamic-price>£65.89</p><p data-dynamic-shipping-price>£5.00</p></form></dynamic-pricing></main></app-provider>`,
    { url: `https://shop.example${productPath}`, runScripts: "outside-only" },
  );
  const { window } = dom;
  window.customElements.define(
    "dynamic-pricing",
    class extends window.HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
      }
    },
  );
  window.eval(`${bundle.outputFiles[0].text};window.Pricing=Pricing;`);
  const form = window.document.querySelector("form"),
    product = form.parentElement;
  product._price = 999;
  product._features = [
    {
      featureId: 6917,
      featureOptions: [
        { featureOptionId: 11434, priceInfo: { retailPrice: 19.95 } },
      ],
    },
  ];
  const measurements = {
    unit: "cm",
    width: 30,
    height: 66,
    availableUnits: ["cm"],
  };
  const read = () =>
    window.Pricing.readConfiguredProductPrice(form, productPath, measurements);
  const option = () =>
    window.Pricing.readProductOptionPrice(
      form,
      form.querySelector('[data-feature-option="6917##11434"]'),
      "6917##11434",
      read(),
    );
  t.after(() => window.close());
  return { window, form, product, measurements, read, option };
}

test("configured price preserves agreed native display and excludes raw price arithmetic and shipping", (t) => {
  const ctx = setup(t);
  assert.equal(ctx.read(), "£65.89");
  assert.equal(ctx.option(), "+£19.95");
  ctx.form.querySelectorAll("[data-dynamic-price]").forEach((e) => {
    e.innerHTML =
      '<span class="sale-price">£60.00</span><span class="regular-price"><s>£65.89</s></span>';
  });
  assert.equal(ctx.read(), "£60.00");
  assert.equal(
    ctx.option(),
    "+£19.95",
    "Surcharge is separate from the current total",
  );
});

test("single locale-formatted native amounts remain unchanged but joined unmarked amounts are unknown", (t) => {
  const ctx = setup(t);
  for (const price of [
    "£1,234.56",
    "1.234,56 €",
    "EUR 1 234,56",
    "USD 65.89",
  ]) {
    ctx.form.querySelectorAll("[data-dynamic-price]").forEach((e) => {
      e.textContent = price;
    });
    assert.equal(ctx.read(), price);
  }
  for (const price of [
    "£65.89 £80.00",
    "£65.89 80.00",
    "£60 80",
    "£65.89 / month",
  ]) {
    ctx.form.querySelectorAll("[data-dynamic-price]").forEach((e) => {
      e.textContent = price;
    });
    assert.equal(ctx.read(), null);
  }
});

test("pending, invalid, ambiguous or unowned native prices are unavailable", async (t) => {
  for (const scenario of [
    "loading",
    "variant-loading",
    "blocking",
    "has-error",
    "owner-loading",
    "missing-dimensions",
    "invalid-dimensions",
    "invalid-form",
    "page",
    "unregistered",
    "hidden",
    "error",
    "disagreement",
    "missing",
    "old-only",
    "long",
    "non-price",
    "pre-price",
    "foreign-only",
  ])
    await t.test(scenario, (t) => {
      const ctx = setup(t),
        nodes = [...ctx.form.querySelectorAll("[data-dynamic-price]")];
      if (
        ["loading", "variant-loading", "blocking", "has-error"].includes(
          scenario,
        )
      )
        ctx.form.classList.add(scenario);
      if (scenario === "owner-loading") ctx.product.classList.add("loading");
      if (scenario === "missing-dimensions") ctx.measurements.width = null;
      if (scenario === "invalid-dimensions") ctx.measurements.height = 0;
      if (scenario === "invalid-form")
        ctx.form.querySelector("input").value = "0";
      if (scenario === "page")
        ctx.window.history.replaceState({}, "", "/products/another");
      if (scenario === "unregistered") ctx.product.shadowRoot.replaceChildren();
      if (scenario === "hidden")
        nodes.forEach((e) => {
          e.hidden = true;
        });
      if (scenario === "error")
        nodes[0].innerHTML =
          '<span class="text-error">Price unavailable</span>';
      if (scenario === "disagreement") nodes[1].textContent = "£66.00";
      if (scenario === "missing") nodes.forEach((e) => e.remove());
      if (scenario === "old-only") nodes[0].innerHTML = "<s>£65.89</s>";
      if (scenario === "long") nodes[0].textContent = "£" + "1".repeat(120);
      if (scenario === "non-price")
        nodes.forEach((e) => {
          e.textContent = "Please select 2 options";
        });
      if (scenario === "pre-price") ctx.product.dataset.multistep = "true";
      if (scenario === "foreign-only") {
        nodes.forEach((e) => e.remove());
        ctx.form.insertAdjacentHTML(
          "beforeend",
          "<dynamic-pricing><p data-dynamic-price>£65.89</p></dynamic-pricing>",
        );
      }
      assert.equal(ctx.read(), null);
      assert.equal(ctx.option(), undefined);
    });
});

test("a settled multistep quote requires its visible post-price screen", (t) => {
  const ctx = setup(t);
  ctx.product.dataset.multistep = "true";
  ctx.form.insertAdjacentHTML(
    "beforeend",
    '<div data-pdp-form-screen="post-price"></div>',
  );
  assert.equal(ctx.read(), "£65.89");
  ctx.form.querySelector("[data-pdp-form-screen]").hidden = true;
  assert.equal(ctx.read(), null);
});

test("native surcharge labels require current positive option pricing and matching visible fieldset evidence", async (t) => {
  for (const scenario of [
    "zero",
    "missing-feature",
    "duplicate-feature",
    "duplicate-option",
    "wrong-marker",
    "hidden",
    "disagreement",
    "empty",
    "two-prices",
    "foreign-fieldset",
    "stale-total",
  ])
    await t.test(scenario, (t) => {
      const ctx = setup(t),
        labels = [...ctx.form.querySelectorAll("[data-second-label]")];
      if (scenario === "zero")
        ctx.product._features[0].featureOptions[0].priceInfo.retailPrice = 0;
      if (scenario === "missing-feature") ctx.product._features = [];
      if (scenario === "duplicate-feature")
        ctx.product._features.push(ctx.product._features[0]);
      if (scenario === "duplicate-option")
        ctx.product._features[0].featureOptions.push(
          ctx.product._features[0].featureOptions[0],
        );
      if (scenario === "wrong-marker")
        labels.forEach((e) =>
          e.setAttribute("data-second-label", "6917##other"),
        );
      if (scenario === "hidden")
        labels.forEach((e) => {
          e.hidden = true;
        });
      if (scenario === "disagreement") labels[1].textContent = "+£30.00";
      if (scenario === "empty") labels[0].textContent = "";
      if (scenario === "two-prices")
        labels.forEach((e) => {
          e.textContent = "+£19.95 +£25.00";
        });
      if (scenario === "foreign-fieldset") {
        const other = ctx.window.document.createElement("fieldset");
        other.dataset.feature = "other";
        ctx.form.append(other);
        labels.forEach((e) => other.append(e));
      }
      if (scenario === "stale-total") ctx.form.classList.add("variant-loading");
      assert.equal(ctx.option(), undefined);
    });
});
