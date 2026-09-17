import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { cwd } from "node:process";

const bundle = await build({
  stdin: {
    contents:
      "export * from './frontend/src/tools/product-configuration'; export * from './shared/product-configuration';",
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Configuration",
  platform: "browser",
});
const productPath = "/products/blind";
function setup(t) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main"><dynamic-pricing><form data-dynamic-pricing-form>
  <fieldset data-feature="1"><input type="radio" name="Fitting##1" value="Recess##8" data-feature-option="1##8" checked><input type="radio" name="Fitting##1" value="Exact##7" data-feature-option="1##7"></fieldset>
  <fieldset data-feature="2"><select name="Lining##2"><option value="Light filtering##20" data-feature-option="2##20">Light filtering</option><option value="Blackout##21" data-feature-option="2##21">Blackout</option><option value="Unavailable##22" data-feature-option="2##22" disabled>Unavailable</option></select></fieldset>
  <fieldset data-feature="3"><input type="checkbox" name="Trim##3" value="Trim##30" data-feature-option="3##30"></fieldset>
  <fieldset data-feature="4" hidden><input type="radio" name="Hidden##4" value="Hidden##40" data-feature-option="4##40"></fieldset>
  <input type="radio" name="Locked##5" value="Locked##50" data-feature-option="5##50" data-screen-disabled="true">
  <input type="text" name="Room name##6" value="Private room" data-feature-option="6##60">
  <input type="hidden" name="token" value="private-token"><input name="quantity" type="number" value="1">
  <product-level-insurance><input type="radio" name="Insurance##7" value="Buy insurance##70" data-feature-option="7##70"></product-level-insurance>
  <button type="submit">Add to basket</button></form></dynamic-pricing></main></app-provider>`,
    {
      url: `https://shop.example${productPath}`,
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole(),
    },
  );
  const { window } = dom;
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, ms) => {
    const id = ++timerId;
    timers.set(id, { callback, ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const fire = (ms) => {
    for (const [id, timer] of [...timers])
      if (timer.ms === ms) {
        timers.delete(id);
        timer.callback();
      }
  };
  window.customElements.define(
    "dynamic-pricing",
    class extends window.HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
      }
    },
  );
  window.eval(
    `${bundle.outputFiles[0].text};window.Configuration=Configuration;`,
  );
  const tools = window.Configuration.createProductConfigurationTools(),
    form = window.document.querySelector("form"),
    events = [];
  for (const type of ["input", "change"])
    form.addEventListener(type, (event) =>
      events.push([
        type,
        event.target.name,
        event.target.value,
        event.target.checked,
      ]),
    );
  form.addEventListener("submit", () =>
    assert.fail("Configuration cannot submit a form"),
  );
  t.after(() => {
    tools.dispose();
    window.close();
  });
  const signal = new window.AbortController().signal;
  return {
    window,
    form,
    tools,
    events,
    timers,
    fire,
    signal,
    configure: async (call, requestSignal = signal) => {
      const pending = tools.configureProduct(call, requestSignal);
      fire(250);
      return await pending;
    },
    read: () => tools.getProductConfiguration(productPath, signal),
    ...window.Configuration,
  };
}
function selection(read, control = 0, option = 1) {
  return {
    productPath,
    configurationId: read.configurationId,
    controlId: `c${control}`,
    optionId: `o${option}`,
  };
}

test("display-only configuration reads preserve the model's mutation capability", async (t) => {
  const ctx = setup(t);
  const original = ctx.read();
  const display = ctx.readProductConfigurationDisplay(productPath);
  assert.equal(display.controls[0].options[0].selected, true);
  assert.equal("configurationId" in display, false);
  assert.equal(ctx.readProductConfigurationDisplay("/products/wrong"), null);
  const result = await ctx.configure(selection(original));
  assert.equal(result.status, "applied");
});

function guaranteeControls(ctx) {
  const { window, form } = ctx;
  form.querySelector("product-level-insurance").remove();
  form.insertAdjacentHTML(
    "beforeend",
    `<input type="hidden" name="properties[ProductLevelInsurance]" value="false" data-product-level-insurance>
    <product-level-insurance variantid="123456" data-is-insurance-auto-applied="false">
      <div slot="heading"><p>Guarantee a Perfect Fit</p></div>
      <div slot="options">
        <label data-product-level-insurance-toggle data-value="false" active><input type="radio" name="product_level_insurance_toggle_123456" value="false" data-product-insurance><span class="body-md-semibold">Don't insure measurements</span></label>
        <label data-product-level-insurance-toggle data-value="true"><input type="radio" name="product_level_insurance_toggle_123456" value="true" data-product-insurance><span class="body-md-semibold">Insure measurements</span><span class="body-sm">A replacement of the same blind costs no more, unless your new measurements are larger.</span><span class="body-sm whitespace-nowrap">+£12.00</span></label>
      </div>
    </product-level-insurance>`,
  );
  const component = form.querySelector("product-level-insurance"),
    hidden = form.querySelector("[data-product-level-insurance]"),
    pricing = form.parentElement,
    inputs = [...component.querySelectorAll("input")],
    toggles = [...component.querySelectorAll("label")],
    clicks = [];
  window.customElements.define(
    "product-level-insurance",
    class extends window.HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML =
          '<slot name="heading"></slot><slot name="options"></slot>';
      }
    },
  );
  Object.assign(component, {
    _insuranceOption: hidden,
    _isInsuranceAutoApplied: false,
    variantId: "123456",
    cartHasInsurance: "false",
  });
  Object.assign(pricing, {
    _productLevelInsuranceOption: hidden,
    _isInsuranceAutoApplied: false,
    productLevelInsuranceVariantId: "123456",
    _insuranceInputChangedByUser: false,
  });
  // These are the two independently owned native click handlers. A direct
  // checked assignment plus change event cannot update their hidden state.
  toggles.forEach((toggle) =>
    toggle.addEventListener("click", () => {
      clicks.push(toggle.dataset.value);
      toggles.forEach((label) =>
        label.toggleAttribute("active", label === toggle),
      );
      hidden.value = toggle.dataset.value;
      pricing._insuranceInputChangedByUser = true;
    }),
  );
  return { component, hidden, pricing, inputs, toggles, clicks };
}

test("measurement guarantee exposes exact terms and separate charge, then records explicit native yes and no without a purchase", async (t) => {
  const ctx = setup(t),
    guarantee = guaranteeControls(ctx),
    read = ctx.read(),
    control = read.controls.find(
      (item) => item.purpose === "measurement_guarantee",
    );
  assert.equal(control.label, "Guarantee a Perfect Fit");
  assert.match(control.description, /unless your new measurements are larger/);
  assert.deepEqual(
    Array.from(control.options, (option) => [
      option.label,
      option.selected,
      option.priceLabel,
    ]),
    [
      ["Don't insure measurements", true, undefined],
      ["Insure measurements", false, "+£12.00"],
    ],
  );
  assert.equal(read.configuredPrice, null);
  const call = {
    productPath,
    configurationId: read.configurationId,
    controlId: control.id,
    optionId: "o1",
  };
  assert.equal((await ctx.configure(call)).status, "applied");
  assert.equal(guarantee.hidden.value, "true");
  assert.equal(guarantee.inputs[1].checked, true);
  assert.equal(guarantee.pricing._insuranceInputChangedByUser, true);
  assert.deepEqual(guarantee.clicks, ["true"]);
  assert.equal((await ctx.configure(call)).status, "unsupported");
  const next = ctx.read();
  assert.equal(
    (
      await ctx.configure({
        ...call,
        configurationId: next.configurationId,
        optionId: "o0",
      })
    ).status,
    "applied",
  );
  assert.equal(guarantee.hidden.value, "false");
  assert.deepEqual(guarantee.clicks, ["true", "false"]);
});

test("explicit no still clicks the preselected default so pricing cannot treat it as an untouched choice", async (t) => {
  const ctx = setup(t),
    guarantee = guaranteeControls(ctx),
    read = ctx.read(),
    control = read.controls.find(
      (item) => item.purpose === "measurement_guarantee",
    );
  assert.equal(
    guarantee.inputs[0].checked,
    false,
    "Initial theme radio has no checked attribute",
  );
  assert.equal(
    (
      await ctx.configure({
        productPath,
        configurationId: read.configurationId,
        controlId: control.id,
        optionId: "o0",
      })
    ).status,
    "applied",
  );
  assert.deepEqual(guarantee.clicks, ["false"]);
  assert.equal(guarantee.pricing._insuranceInputChangedByUser, true);
  assert.equal(guarantee.inputs[0].checked, true);
});

test("unverified guarantee markup is omitted without hiding ordinary product choices", async (t) => {
  for (const scenario of [
    "auto-applied",
    "insured-slot",
    "component-owner",
    "pricing-owner",
    "variant",
    "hidden-name",
    "duplicate",
    "no-terms",
    "long-terms",
    "no-price",
    "ambiguous-price",
    "disabled",
    "screen-disabled",
    "hidden",
    "wrong-label",
    "wrong-radio",
    "checked-disagreement",
    "active-disagreement",
    "uninitialized",
  ]) {
    await t.test(scenario, (t) => {
      const ctx = setup(t),
        g = guaranteeControls(ctx);
      if (scenario === "auto-applied")
        g.component._isInsuranceAutoApplied = true;
      if (scenario === "insured-slot") g.component.cartHasInsurance = "true";
      if (scenario === "component-owner")
        g.component._insuranceOption =
          ctx.window.document.createElement("input");
      if (scenario === "pricing-owner")
        g.pricing._productLevelInsuranceOption =
          ctx.window.document.createElement("input");
      if (scenario === "variant")
        g.pricing.productLevelInsuranceVariantId = "654321";
      if (scenario === "hidden-name") g.hidden.name = "properties[Different]";
      if (scenario === "duplicate")
        ctx.form.append(g.component.cloneNode(true));
      if (scenario === "no-terms")
        g.component.querySelector(".body-sm:not(.whitespace-nowrap)").remove();
      if (scenario === "long-terms")
        g.component.querySelector(
          ".body-sm:not(.whitespace-nowrap)",
        ).textContent = "x".repeat(1201);
      if (scenario === "no-price")
        g.component.querySelector(".whitespace-nowrap").remove();
      if (scenario === "ambiguous-price")
        g.component.querySelector(".whitespace-nowrap").textContent =
          "+£12.00 +£10.00";
      if (scenario === "disabled") g.inputs[1].disabled = true;
      if (scenario === "screen-disabled")
        g.inputs[1].setAttribute("data-screen-disabled", "");
      if (scenario === "hidden") g.component.hidden = true;
      if (scenario === "wrong-label") g.toggles[1].dataset.value = "false";
      if (scenario === "wrong-radio") g.inputs[1].name = "another_field";
      if (scenario === "checked-disagreement") g.inputs[1].checked = true;
      if (scenario === "active-disagreement")
        g.toggles[1].setAttribute("active", "");
      if (scenario === "uninitialized") g.component.shadowRoot.innerHTML = "";
      const read = ctx.read();
      assert.equal(read.status, "available");
      assert.equal(read.controls[0].label, "Fitting");
      assert.equal(
        read.controls.some(
          (control) => control.purpose === "measurement_guarantee",
        ),
        false,
      );
      assert.deepEqual(g.clicks, []);
    });
  }
});

test("guarantee terms changing invalidates its capability before a click", async (t) => {
  const ctx = setup(t),
    g = guaranteeControls(ctx),
    read = ctx.read(),
    control = read.controls.find(
      (item) => item.purpose === "measurement_guarantee",
    );
  g.component.querySelector(".body-sm:not(.whitespace-nowrap)").textContent =
    "Different cover terms.";
  const result = await ctx.configure({
    productPath,
    configurationId: read.configurationId,
    controlId: control.id,
    optionId: "o1",
  });
  assert.equal(result.status, "unsupported");
  assert.deepEqual(g.clicks, []);
});

test("unconfirmed theme guarantee changes are uncertain and never replayed", async (t) => {
  for (const scenario of [
    "hidden-reset",
    "owner-lost",
    "choice-flag-lost",
    "abort",
    "page-change",
  ]) {
    await t.test(scenario, async (t) => {
      const ctx = setup(t),
        g = guaranteeControls(ctx),
        read = ctx.read(),
        control = read.controls.find(
          (item) => item.purpose === "measurement_guarantee",
        ),
        call = {
          productPath,
          configurationId: read.configurationId,
          controlId: control.id,
          optionId: "o1",
        },
        controller = new ctx.window.AbortController();
      const pending = ctx.tools.configureProduct(call, controller.signal);
      assert.deepEqual(g.clicks, ["true"]);
      if (scenario === "hidden-reset") g.hidden.value = "false";
      if (scenario === "owner-lost") g.component._insuranceOption = null;
      if (scenario === "choice-flag-lost")
        g.pricing._insuranceInputChangedByUser = false;
      if (scenario === "abort") controller.abort();
      if (scenario === "page-change")
        ctx.window.history.pushState({}, "", "/products/another");
      ctx.fire(250);
      assert.equal((await pending).status, "uncertain");
      assert.equal((await ctx.configure(call)).status, "unsupported");
      assert.deepEqual(g.clicks, ["true"]);
    });
  }
});

test("discovery projects native feature choices only, with truthful hidden and disabled availability", (t) => {
  const ctx = setup(t),
    result = ctx.read();
  assert.equal(result.status, "available");
  assert.deepEqual(JSON.parse(JSON.stringify(result.actions)), {
    sampleAvailable: false,
  });
  assert.deepEqual(
    Array.from(result.controls, (control) => control.label),
    ["Fitting", "Lining", "Trim: Trim", "Hidden", "Locked"],
  );
  assert.equal(result.controls[0].options[0].selected, true);
  assert.equal(result.controls[1].options[2].available, false);
  assert.equal(result.controls[3].options[0].available, false);
  assert.equal(result.controls[4].options[0].available, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(ctx.events, []);
});

test("one requested radio choice updates native state and events without a purchase, then cannot replay", async (t) => {
  const ctx = setup(t),
    call = selection(ctx.read());
  assert.equal((await ctx.configure(call)).status, "applied");
  assert.equal(ctx.form.querySelector('[value="Recess##8"]').checked, false);
  assert.equal(ctx.form.querySelector('[value="Exact##7"]').checked, true);
  assert.deepEqual(
    ctx.events.map((event) => event[0]),
    ["input", "change"],
  );
  assert.equal((await ctx.configure(call)).status, "unsupported");
  assert.equal(ctx.events.length, 2);
});

test("supported native select and checkbox choices retain their exact theme values", async (t) => {
  const ctx = setup(t);
  assert.equal(
    (await ctx.configure(selection(ctx.read(), 1, 1))).status,
    "applied",
  );
  assert.equal(ctx.form.querySelector("select").value, "Blackout##21");
  assert.equal(
    (await ctx.configure(selection(ctx.read(), 2, 1))).status,
    "applied",
  );
  assert.equal(ctx.form.querySelector('[type="checkbox"]').checked, true);
  assert.equal(
    (await ctx.configure(selection(ctx.read(), 2, 0))).status,
    "applied",
  );
  assert.equal(ctx.form.querySelector('[type="checkbox"]').checked, false);
});

test("unsupported choices are never enabled or mutated", async (t) => {
  for (const [control, option] of [
    [1, 2],
    [3, 0],
    [4, 0],
    [23, 31],
  ])
    await t.test(`${control}:${option}`, async (t) => {
      const ctx = setup(t),
        call = selection(ctx.read(), control, option);
      assert.equal((await ctx.configure(call)).status, "unsupported");
      assert.deepEqual(ctx.events, []);
    });
});

test("page, input, DOM replacement, availability, expiry and newer read invalidate the single-use snapshot", async (t) => {
  for (const change of [
    "page",
    "value",
    "replacement",
    "disabled",
    "expired",
    "read",
    "dispose",
  ])
    await t.test(change, async (t) => {
      const ctx = setup(t),
        call = selection(ctx.read()),
        target = ctx.form.querySelector('[value="Exact##7"]');
      if (change === "page")
        ctx.window.history.pushState({}, "", "/products/other");
      if (change === "value")
        ctx.form.querySelector('[name="quantity"]').value = "2";
      if (change === "replacement") target.replaceWith(target.cloneNode(true));
      if (change === "disabled") target.disabled = true;
      if (change === "expired") {
        const now = ctx.window.Date.now();
        ctx.window.Date.now = () => now + 120001;
      }
      if (change === "read") ctx.read();
      if (change === "dispose") ctx.tools.dispose();
      assert.equal((await ctx.configure(call)).status, "unsupported");
      assert.deepEqual(ctx.events, []);
    });
});

test("an aborted attempt consumes its capability without dispatching, and cannot later replay", async (t) => {
  const ctx = setup(t),
    call = selection(ctx.read()),
    controller = new ctx.window.AbortController();
  controller.abort();
  await assert.rejects(ctx.configure(call, controller.signal));
  assert.equal((await ctx.configure(call)).status, "unsupported");
  assert.deepEqual(ctx.events, []);
});

test("theme correction, replacement, abort or synchronous event exception yields uncertain and never replays", async (t) => {
  for (const failure of [
    "correction",
    "replacement",
    "abort",
    "exception",
    "page",
  ])
    await t.test(failure, async (t) => {
      const ctx = setup(t),
        call = selection(ctx.read()),
        controller = new ctx.window.AbortController(),
        target = ctx.form.querySelector('[value="Exact##7"]');
      target.addEventListener("input", () => {
        if (failure === "correction") target.checked = false;
        if (failure === "replacement")
          target.replaceWith(target.cloneNode(true));
        if (failure === "abort") controller.abort();
        if (failure === "page")
          ctx.window.history.pushState({}, "", "/products/other");
        if (failure === "exception") throw new Error("synthetic theme failure");
      });
      assert.equal(
        (await ctx.configure(call, controller.signal)).status,
        "uncertain",
      );
      const count = ctx.events.length;
      assert.equal((await ctx.configure(call)).status, "unsupported");
      assert.equal(ctx.events.length, count);
    });
});

test("contracts reject selectors, dimensions, forged identifiers and unbounded result data", (t) => {
  const ctx = setup(t),
    result = ctx.read(),
    call = selection(result);
  for (const input of [
    { ...call, selector: "button" },
    { ...call, width: 300 },
    { ...call, optionId: "o32" },
    { ...call, controlId: "c24" },
    { ...call, configurationId: "fake" },
  ])
    assert.throws(() =>
      ctx.parseProductConfigurationCall("configure_product", input),
    );
  for (const change of [
    { controls: Array(25).fill(result.controls[0]) },
    { controls: [{ ...result.controls[0], label: "x".repeat(161) }] },
    { status: "unavailable" },
    { message: "unsafe\ntext" },
  ])
    assert.throws(() =>
      ctx.parseProductConfigurationResult("get_product_configuration", {
        ...result,
        ...change,
      }),
    );
});

test("busy, duplicate or unregistered product forms expose no configuration capability", async (t) => {
  for (const change of ["busy", "duplicate", "unregistered", "cart-edit"])
    await t.test(change, (t) => {
      const ctx = setup(t);
      if (change === "busy") ctx.form.classList.add("loading");
      if (change === "duplicate")
        ctx.form.parentElement.append(ctx.form.cloneNode(true));
      if (change === "unregistered")
        ctx.form.parentElement.shadowRoot.replaceChildren();
      if (change === "cart-edit")
        ctx.window.history.replaceState({}, "", `${productPath}?line=1`);
      const read = ctx.read();
      assert.equal(read.status, "unavailable");
      assert.equal(read.configurationId, null);
      assert.equal(read.controls.length, 0);
    });
});

test("initial price and invalid-configuration states allow an enabled corrective feature choice", async (t) => {
  for (const state of ["variant-loading", "blocking"])
    await t.test(state, async (t) => {
      const ctx = setup(t);
      ctx.form.classList.add(state);
      const read = ctx.read();
      assert.equal(read.status, "available");
      if (state === "variant-loading")
        ctx.form.addEventListener("change", () =>
          ctx.form.classList.remove(state),
        );
      assert.equal((await ctx.configure(selection(read))).status, "applied");
    });
});

test("recorded configuration actions are strict while older durable results retain unknown availability", (t) => {
  const ctx = setup(t),
    current = ctx.read();
  assert.equal(
    ctx.parseProductConfigurationResult("get_product_configuration", current)
      .actions.sampleAvailable,
    false,
  );
  const historical = { ...current };
  delete historical.actions;
  assert.equal(
    "actions" in
      ctx.parseProductConfigurationResult(
        "get_product_configuration",
        historical,
      ),
    false,
  );
  for (const actions of [
    null,
    {},
    { sampleAvailable: "true" },
    { sampleAvailable: true, productReady: true },
  ])
    assert.throws(() =>
      ctx.parseProductConfigurationResult("get_product_configuration", {
        ...current,
        actions,
      }),
    );
});

test("configuration waits for native pricing and dependent choices before a fresh sequential change", async (t) => {
  const ctx = setup(t);
  const call = selection(ctx.read());
  ctx.form
    .querySelector('[value="Exact##7"]')
    .addEventListener("change", () => {
      ctx.form.classList.add("loading", "variant-loading");
    });
  let finished = false;
  const pending = ctx.tools.configureProduct(call, ctx.signal);
  void pending.then(() => {
    finished = true;
  });
  ctx.fire(250);
  await Promise.resolve();
  assert.equal(finished, false, "A selected radio is not a settled theme");
  assert.equal(
    ctx.read().status,
    "unavailable",
    "No capability is issued while the previous choice is settling",
  );
  assert.equal((await ctx.configure(call)).status, "unsupported");
  assert.equal(ctx.events.length, 2);

  ctx.form.insertAdjacentHTML(
    "beforeend",
    `<fieldset data-feature="9"><input type="radio" name="Width definition##9" value="Fabric Width##90" data-feature-option="9##90" checked><input type="radio" name="Width definition##9" value="Bracket to Bracket##91" data-feature-option="9##91"></fieldset>`,
  );
  ctx.form.classList.remove("loading", "variant-loading");
  assert.equal((await pending).status, "applied");
  const next = ctx.read();
  const control = next.controls.find(
    (entry) => entry.label === "Width definition",
  );
  assert.ok(control);
  const option = control.options.find(
    (entry) => entry.label === "Bracket to Bracket",
  );
  assert.equal(option.available, true);
  assert.equal(
    (
      await ctx.configure({
        productPath,
        configurationId: next.configurationId,
        controlId: control.id,
        optionId: option.id,
      })
    ).status,
    "applied",
  );
  assert.equal(
    ctx.form.querySelector('[value="Bracket to Bracket##91"]').checked,
    true,
  );
  assert.deepEqual(
    ctx.events.map((event) => event[0]),
    ["input", "change", "input", "change"],
  );
  assert.equal(ctx.timers.size, 0);
});

test("an already selected choice still waits for pending theme dependencies without dispatching again", async (t) => {
  const ctx = setup(t);
  ctx.form.classList.add("variant-loading");
  const call = selection(ctx.read(), 0, 0);
  let finished = false;
  const pending = ctx.tools.configureProduct(call, ctx.signal);
  void pending.then(() => {
    finished = true;
  });
  ctx.fire(250);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(ctx.events, []);
  ctx.form.classList.remove("variant-loading");
  assert.equal((await pending).status, "applied");
  assert.deepEqual(ctx.events, []);
  assert.equal(ctx.timers.size, 0);
});

test("pending pricing failure, lifecycle changes and late native corrections are uncertain and cannot replay", async (t) => {
  for (const failure of [
    "abort",
    "dispose",
    "navigation",
    "pagehide",
    "timeout",
    "correction",
    "replacement",
    "form",
    "identity",
  ]) {
    await t.test(failure, async (t) => {
      const ctx = setup(t);
      const controller = new ctx.window.AbortController();
      const call = selection(ctx.read());
      const target = ctx.form.querySelector('[value="Exact##7"]');
      const pending = ctx.tools.configureProduct(call, controller.signal);
      assert.equal(
        target.checked,
        true,
        "The attempted mutation is already visible",
      );
      if (failure === "abort") controller.abort();
      if (failure === "dispose") ctx.tools.dispose();
      if (failure === "navigation") {
        ctx.window.document.dispatchEvent(
          new ctx.window.Event("roman:navigation"),
        );
        // Even returning to the same URL cannot undo a navigation cancellation.
        ctx.window.history.replaceState({}, "", productPath);
      }
      if (failure === "pagehide")
        ctx.window.dispatchEvent(new ctx.window.Event("pagehide"));
      if (failure === "timeout") {
        ctx.form.classList.add("variant-loading");
        ctx.fire(15_000);
      }
      if (failure === "correction") target.checked = false;
      if (failure === "replacement") target.replaceWith(target.cloneNode(true));
      if (failure === "form") ctx.form.remove();
      if (failure === "identity") target.removeAttribute("data-feature-option");
      ctx.fire(250);
      assert.equal((await pending).status, "uncertain");
      assert.equal(ctx.timers.size, 0, "Settlement timers are cleaned up");
      assert.equal((await ctx.configure(call)).status, "unsupported");
      assert.equal(
        ctx.events.length,
        2,
        "A consumed capability never redispatches native events",
      );
    });
  }
});

function nestedControls(ctx) {
  ctx.form.insertAdjacentHTML(
    "beforeend",
    `<fieldset data-feature="82">
    <input type="radio" name="Control Options##82" value="Chain##203" data-feature-option="82##203" checked>
    <div data-feature-option-container><input type="radio" name="Control Options##82" value="Electric SmartView##204" data-feature-option="82##204">
    <div data-remote-options hidden>
      <input type="radio" name="14 Channel Remote Control##6917##204" value="No Remote##11433" data-feature-option="6917##11433" checked disabled>
      <input type="radio" name="14 Channel Remote Control##6917##204" value="14 Channel Remote Control##11434" data-feature-option="6917##11434" disabled>
      <div data-detail-options hidden><input type="radio" name="Remote finish##7000##11434" value="White##12000" data-feature-option="7000##12000" checked disabled><input type="radio" name="Remote finish##7000##11434" value="Black##12001" data-feature-option="7000##12001" disabled></div>
    </div></div></fieldset>`,
  );
  const group = ctx.form.querySelector('[data-feature="82"]');
  const electric = group.querySelector('[value="Electric SmartView##204"]');
  const remote = group.querySelector(
    '[value="14 Channel Remote Control##11434"]',
  );
  const refresh = () => {
    group.querySelector("[data-remote-options]").hidden = !electric.checked;
    group.querySelector("[data-detail-options]").hidden =
      !electric.checked || !remote.checked;
    group
      .querySelectorAll('[name="14 Channel Remote Control##6917##204"]')
      .forEach((e) => {
        e.disabled = !electric.checked;
      });
    group
      .querySelectorAll('[name="Remote finish##7000##11434"]')
      .forEach((e) => {
        e.disabled = !electric.checked || !remote.checked;
      });
  };
  group.addEventListener("change", refresh);
  return { group, electric, remote, refresh };
}
function namedSelection(read, controlLabel, optionLabel) {
  const control = read.controls.find((c) => c.label === controlLabel),
    option = control?.options.find((o) => o.label === optionLabel);
  assert.ok(control && option, `Expected ${controlLabel}: ${optionLabel}`);
  return {
    productPath,
    configurationId: read.configurationId,
    controlId: control.id,
    optionId: option.id,
  };
}

test("native multi-level dependencies retain hidden defaults but authorize only selected active parent branches", async (t) => {
  const ctx = setup(t),
    nested = nestedControls(ctx);
  const read = ctx.read(),
    root = read.controls.find((c) => c.label === "Control Options"),
    remote = read.controls.find((c) => c.label === "14 Channel Remote Control"),
    detail = read.controls.find((c) => c.label === "Remote finish");
  assert.deepEqual(JSON.parse(JSON.stringify(remote.parent)), {
    controlId: root.id,
    optionId: root.options.find((o) => o.label === "Electric SmartView").id,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(detail.parent)), {
    controlId: remote.id,
    optionId: remote.options.find(
      (o) => o.label === "14 Channel Remote Control",
    ).id,
  });
  assert.equal(
    remote.options[0].selected,
    true,
    "A theme default remains distinguishable from availability",
  );
  assert.ok(remote.options.every((o) => !o.available));
  assert.ok(detail.options.every((o) => !o.available));
  assert.equal(
    (
      await ctx.configure(
        namedSelection(
          read,
          "14 Channel Remote Control",
          "14 Channel Remote Control",
        ),
      )
    ).status,
    "unsupported",
  );
  assert.equal(
    (
      await ctx.configure(
        namedSelection(ctx.read(), "Control Options", "Electric SmartView"),
      )
    ).status,
    "applied",
  );
  const expanded = ctx.read();
  assert.ok(
    expanded.controls
      .find((c) => c.label === "14 Channel Remote Control")
      .options.every((o) => o.available),
  );
  assert.ok(
    expanded.controls
      .find((c) => c.label === "Remote finish")
      .options.every((o) => !o.available),
  );
  assert.equal(
    nested.remote.checked,
    false,
    "Revealing a branch does not choose its paid option",
  );
  assert.equal(
    (
      await ctx.configure(
        namedSelection(
          expanded,
          "14 Channel Remote Control",
          "14 Channel Remote Control",
        ),
      )
    ).status,
    "applied",
  );
  assert.ok(
    ctx
      .read()
      .controls.find((c) => c.label === "Remote finish")
      .options.every((o) => o.available),
  );
});

test("missing, ambiguous, cross-fieldset or unavailable parents cannot authorize nested writes", async (t) => {
  for (const scenario of [
    "missing",
    "ambiguous",
    "foreign",
    "unselected",
    "disabled",
    "screen-disabled",
    "cycle",
  ])
    await t.test(scenario, async (t) => {
      const ctx = setup(t),
        nested = nestedControls(ctx);
      nested.electric.checked = true;
      nested.refresh();
      if (scenario === "missing") nested.electric.remove();
      if (scenario === "ambiguous")
        nested.group.insertAdjacentHTML(
          "beforeend",
          '<input type="radio" name="Other control##82" value="Other Electric##204" data-feature-option="82##204">',
        );
      if (scenario === "foreign") {
        const field = ctx.window.document.createElement("fieldset");
        field.dataset.feature = "82";
        ctx.form.append(field);
        field.append(nested.electric);
      }
      if (scenario === "unselected") nested.electric.checked = false;
      if (scenario === "disabled") nested.electric.disabled = true;
      if (scenario === "screen-disabled")
        nested.electric.setAttribute("data-screen-disabled", "");
      if (scenario === "cycle")
        nested.electric.name = "Control Options##82##11434";
      const read = ctx.read();
      if (scenario === "cycle") assert.equal(read.status, "unavailable");
      else {
        const remote = read.controls.find(
          (c) => c.label === "14 Channel Remote Control",
        );
        assert.ok(remote.options.every((o) => !o.available));
        assert.equal(
          (
            await ctx.configure(
              namedSelection(
                read,
                "14 Channel Remote Control",
                "14 Channel Remote Control",
              ),
            )
          ).status,
          "unsupported",
        );
      }
      assert.deepEqual(ctx.events, []);
    });
});

test("a parent change after discovery invalidates the child capability before mutation", async (t) => {
  const ctx = setup(t),
    nested = nestedControls(ctx);
  nested.electric.checked = true;
  nested.refresh();
  const call = namedSelection(
    ctx.read(),
    "14 Channel Remote Control",
    "14 Channel Remote Control",
  );
  nested.electric.checked = false;
  assert.equal((await ctx.configure(call)).status, "unsupported");
  assert.equal(nested.remote.checked, false);
  assert.deepEqual(ctx.events, []);
});
