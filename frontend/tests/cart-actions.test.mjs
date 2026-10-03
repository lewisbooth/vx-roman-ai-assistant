import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/tools/cart-actions.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanCartActions",
  platform: "browser",
});

const line = (key, quantity = 1, extra = {}) => ({
  key,
  title: `Configured blind ${key}`,
  variant_id: 123,
  quantity,
  final_line_price: quantity * 1000,
  ...extra,
});
const linkedBlind = (key, coverKey, quantity, group) => {
  const product = line(key, quantity, {
    product_type: "Product",
    properties: { _group_id: group, _insurance_group: `cover-${group}`, Width: group },
  });
  const cover = line(coverKey, quantity, {
    product_type: "Insurance",
    properties: {
      _group_id: group,
      _insurance_group: `cover-${group}`,
      _associated_product_id: "123",
      _insurance_type: "product",
    },
    parent_relationship: { parent_key: product.key },
  });
  return [product, cover];
};
const cart = (items) => ({
  currency: "GBP",
  item_count: items.reduce((sum, item) => sum + item.quantity, 0),
  total_price: items.reduce((sum, item) => sum + item.final_line_price, 0),
  items,
  token: "private-cart-token",
  note: "private-note",
  attributes: { private: true },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(
  t,
  {
    initialized = true,
    items = [line("123:a"), line("123:b", 2)],
    quantityTag = "quantity-input",
    quantityKeys = ["123:a", "123:b"],
    removeKeys = ["123:a", "123:b"],
    notification = false,
  } = {},
) {
  const quantityControl = (key, quantity) => quantityTag === "quantity-select"
    ? `<quantity-select key="${key}"><select>${[1, 2, 4, 6].map(value => `<option value="${value}"${quantity === value ? " selected" : ""}>${value}</option>`).join("")}</select></quantity-select>`
    : `<quantity-input key="${key}"><input type="number" min="1" max="10" step="1" value="${quantity}"></quantity-input>`;
  const dom = new JSDOM(
    `<!doctype html><body><app-provider><main id="main"><cart-sections section-id="cart">
      <form id="cart" data-cart-form>
        ${removeKeys.includes("123:a") ? '<cart-remove-toggle key="123:a"><span><button>Remove first</button></span></cart-remove-toggle>' : ""}
        ${quantityKeys.includes("123:a") ? quantityControl("123:a", 1) : ""}
        ${removeKeys.includes("123:b") ? '<cart-remove-toggle key="123:b"><button type="button">Remove second</button></cart-remove-toggle>' : ""}
        ${quantityKeys.includes("123:b") ? quantityControl("123:b", 2) : ""}
      </form>
    </cart-sections></main>
    ${notification ? '<cart-sections section-id="cart-drawer-dialog" data-cart-notification-mode></cart-sections>' : ""}
    </app-provider></body>`,
    {
      url: "https://hd-dev-single.myshopify.com/cart",
      runScripts: "outside-only",
    },
  );
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const calls = [];
  let initial = cart(items);
  let requests = 0;
  let nativeSubmissions = 0;
  let clearPromise;
  let quantityPromise;
  let removePromise;
  document.querySelector("form").addEventListener("submit", (event) => {
    nativeSubmissions++;
    event.preventDefault();
  });
  if (initialized) {
    window.customElements.define(
      "app-provider",
      class extends window.HTMLElement {},
    );
    window.customElements.define(
      "cart-sections",
      class extends window.HTMLElement {
        clearCart() {
          calls.push({ kind: "clear", owner: this });
          return clearPromise ?? Promise.resolve();
        }
        updateQuantityToCart(updates) {
          calls.push({ kind: "notification-quantity", owner: this, updates, cart: this.cart });
          return quantityPromise ?? Promise.resolve();
        }
        removeItemFromCart(keys) {
          calls.push({ kind: "notification-remove", owner: this, keys, cart: this.cart });
          return removePromise ?? Promise.resolve();
        }
      },
    );
    window.customElements.define(
      "cart-remove-toggle",
      class extends window.HTMLElement {
        get key() {
          return this.getAttribute("key");
        }
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
          this.shadowRoot
            .querySelector("slot")
            .addEventListener("click", (event) => {
              assert.equal(
                event.defaultPrevented,
                true,
                "native navigation is blocked before theme delegation",
              );
              // The theme owns any insurance/warranty decisions from this context.
              calls.push({
                kind: "remove",
                owner: this,
                key: this.key,
                cart: this.cart,
              });
            });
        }
      },
    );
    window.customElements.define(
      "quantity-input",
      class extends window.HTMLElement {
        get lineItemKey() {
          return this.getAttribute("key");
        }
        connectedCallback() {
          this.addEventListener("change", (event) => {
            assert.equal(event.target, this.querySelector("input"));
            calls.push({
              kind: "quantity",
              owner: this,
              key: this.lineItemKey,
              quantity: Number(event.target.value),
              cart: this.cart,
            });
          });
        }
      },
    );
    // The captured HD cart bundle uses a light-DOM select cached at connection,
    // with a bubbling change listener on its quantity-select custom element.
    window.customElements.define(
      "quantity-select",
      class extends window.HTMLElement {
        get lineItemKey() {
          return this.getAttribute("key");
        }
        connectedCallback() {
          this.select = this.querySelector("select");
          this.addEventListener("change", (event) => {
            assert.equal(event.target, this.select);
            calls.push({
              kind: "quantity",
              owner: this,
              key: this.lineItemKey,
              quantity: Number(this.select.value),
              cart: this.cart,
            });
          });
        }
      },
    );
  }
  const owners = [
    ...document.querySelectorAll(
      "cart-sections, cart-remove-toggle, quantity-input, quantity-select",
    ),
  ];
  const listeners = new Set();
  owners.forEach((owner, index) => {
    owner.cart = structuredClone(initial);
    const add = owner.addEventListener.bind(owner);
    const remove = owner.removeEventListener.bind(owner);
    owner.addEventListener = (name, ...args) => {
      if (name.startsWith("cart:")) listeners.add(`${index}:${name}`);
      return add(name, ...args);
    };
    owner.removeEventListener = (name, ...args) => {
      if (name.startsWith("cart:")) listeners.delete(`${index}:${name}`);
      return remove(name, ...args);
    };
  });
  window.fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), "https://hd-dev-single.myshopify.com/cart.js");
    assert.equal(
      options.method,
      undefined,
      "Roman never constructs a cart mutation",
    );
    assert.equal(options.credentials, "same-origin");
    return { ok: true, json: async () => structuredClone(initial) };
  };
  const deadlines = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => {
    assert.ok([15000, 35000].includes(delay));
    deadlines.set(++timerId, {callback, delay});
    return timerId;
  };
  window.clearTimeout = (id) => deadlines.delete(id);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanCartActions = RomanCartActions;`,
  );
  const controller = new window.AbortController();
  t.after(() => controller.abort());
  return {
    window,
    document,
    calls,
    controller,
    listeners,
    actions: window.RomanCartActions,
    owner: (tag, key = "123:a") =>
      [...document.querySelectorAll(tag)].find(
        (element) =>
          tag === "cart-sections" || element.getAttribute("key") === key,
      ),
    notification: () => document.querySelector("cart-sections[data-cart-notification-mode]"),
    update: (owner, value) =>
      owner.dispatchEvent(
        new window.CustomEvent("cart:updated", {
          bubbles: true,
          composed: true,
          detail: value,
        }),
      ),
    timeout: (delay = 15000) => [...deadlines.values()].find((entry) => entry.delay === delay).callback(),
    hasDeadline: () => deadlines.size > 0,
    requests: () => requests,
    nativeSubmissions: () => nativeSubmissions,
    setInitial: (value) => {
      initial = value;
    },
    settle: (owner, value) => {
      initial = value;
      for (const element of owners) element.cart = structuredClone(value);
      owner.dispatchEvent(new window.CustomEvent("cart:updated", { bubbles: true, composed: true, detail: value }));
    },
    setClearPromise: (value) => {
      clearPromise = value;
    },
    setQuantityPromise: (value) => {
      quantityPromise = value;
    },
    setRemovePromise: (value) => {
      removePromise = value;
    },
  };
}

test("removal delegates to the matching theme control and confirms the exact configured line", async (t) => {
  const linked = line("insurance:1", 1, {
    product_type: "Insurance",
    properties: { _insurance_group: "group-a" },
  });
  const env = setup(t, { items: [line("123:a"), line("123:b", 2), linked] });
  const action = env.actions.removeFromCart(["123:a"], env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "remove");
  assert.equal(env.calls[0].owner, env.owner("cart-remove-toggle"));
  assert.deepEqual(
    env.calls[0].cart.items.at(-1).properties,
    linked.properties,
  );
  assert.equal(env.nativeSubmissions(), 0);
  assert.equal(env.requests(), 1);
  env.update(env.calls[0].owner, cart([line("123:b", 2)]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items[0].lineKey, "123:b");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("properties"), false);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("notification removal submits one exact native batch and retains another configured blind", async (t) => {
  const [first, firstCover] = linkedBlind("123:a", "cover:a", 1, "a");
  const [second, secondCover] = linkedBlind("123:b", "cover:b", 2, "b");
  const [retained, retainedCover] = linkedBlind("123:c", "cover:c", 3, "c");
  const env = setup(t, {
    items: [first, firstCover, second, secondCover, retained, retainedCover],
    removeKeys: [],
    notification: true,
  });
  const action = env.actions.removeFromCart([first.key, second.key], env.controller.signal);
  await flush();
  assert.equal(env.requests(), 1);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "notification-remove");
  assert.equal(env.calls[0].owner, env.notification());
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].keys)), [
    first.key, firstCover.key, second.key, secondCover.key,
  ]);
  env.update(env.notification(), cart([retained, retainedCover]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.deepEqual(result.cart.items.map((item) => item.lineKey), [retained.key, retainedCover.key]);
  assert.equal(result.cart.items[0].quantity, 3);
  assert.equal(result.cart.items[1].quantity, 3);
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
  assert.equal(JSON.stringify(result).includes("_insurance_group"), false);
});

test("native batch removal waits for selected identities to disappear and retained lines to survive", async (t) => {
  const [first, firstCover] = linkedBlind("123:a", "cover:a", 1, "a");
  const [second, secondCover] = linkedBlind("123:b", "cover:b", 2, "b");
  const [retained, retainedCover] = linkedBlind("123:c", "cover:c", 3, "c");
  const env = setup(t, {
    items: [first, firstCover, second, secondCover, retained, retainedCover],
    removeKeys: [],
    notification: true,
  });
  const action = env.actions.removeFromCart([first.key, second.key], env.controller.signal);
  await flush();
  env.update(env.notification(), cart([
    { ...first, key: "123:rotated" }, firstCover, retained, retainedCover,
  ]));
  assert.equal(env.hasDeadline(), true, "a selected blind surviving with a new key cannot confirm removal");
  env.update(env.notification(), cart([retained]));
  assert.equal(env.hasDeadline(), true, "the retained cover must remain");
  const rotatedRetained = { ...retained, key: "123:retained-rotated" };
  env.update(env.notification(), cart([rotatedRetained, retainedCover]));
  assert.equal(env.hasDeadline(), true, "the retained cover must follow its rotated parent key");
  env.update(env.notification(), cart([
    rotatedRetained,
    { ...retainedCover, parent_relationship: { parent_key: rotatedRetained.key } },
  ]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items[0].lineKey, rotatedRetained.key);
  assert.equal(env.calls.length, 1);
});

test("native removal preserves the theme's last-product insurance cleanup", async (t) => {
  const [product, cover] = linkedBlind("123:a", "cover:a", 1, "a");
  const cartCover = line("cart-cover", 1, { product_type: "Insurance", properties: { _insurance_type: "cart" } });
  const sample = line("sample", 1, { product_type: "Sample" });
  const env = setup(t, {
    items: [product, cover, cartCover, sample],
    removeKeys: [],
    notification: true,
  });
  const action = env.actions.removeFromCart([product.key], env.controller.signal);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].keys)), [product.key, cover.key, cartCover.key]);
  env.update(env.notification(), cart([sample]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.deepEqual(result.cart.items.map((item) => item.lineKey), [sample.key]);
});

test("native removal rejects unknown links and mixed controls before any write", async (t) => {
  const [first, firstCover] = linkedBlind("123:a", "cover:a", 1, "a");
  const second = line("123:b", 1, { product_type: "Product", properties: { _group_id: "b" } });
  const retained = line("123:c", 3, { product_type: "Product", properties: { _group_id: "c" } });
  for (const [name, items, removeKeys] of [
    ["unknown linked extra", [first, { ...firstCover, product_type: "Express Dispatch" }, second, retained], []],
    ["mismatched cover group", [first, { ...firstCover, properties: { ...firstCover.properties, _group_id: "other" } }, second, retained], []],
    ["mixed present and absent controls", [first, firstCover, second, retained], [first.key]],
  ]) {
    await t.test(name, async (t) => {
      const env = setup(t, { items, removeKeys, notification: true });
      const action = env.actions.removeFromCart([first.key, second.key], env.controller.signal);
      if (removeKeys.length) assert.equal((await action).status, "needs_cart_page");
      else await assert.rejects(action, /linked cart line/);
      assert.equal(env.calls.length, 0);
      assert.equal(env.requests(), 1);
    });
  }
});

test("uncertain or unavailable native removal never replays a batch", async (t) => {
  const [product, cover] = linkedBlind("123:a", "cover:a", 1, "a");
  for (const state of ["stale-owner", "missing-method", "partial-result", "rejected-promise", "cancelled"]) {
    await t.test(state, async (t) => {
      const env = setup(t, { items: [product, cover], removeKeys: [], notification: true });
      if (state === "stale-owner") env.notification().cart.items.pop();
      if (state === "missing-method") env.notification().removeItemFromCart = undefined;
      let rejectTheme;
      if (state === "rejected-promise")
        env.setRemovePromise(new Promise((_, reject) => { rejectTheme = reject; }));
      const action = env.actions.removeFromCart([product.key], env.controller.signal);
      const rejected = state === "rejected-promise" ? assert.rejects(action, /could not confirm/) : undefined;
      await flush();
      if (state === "stale-owner" || state === "missing-method") {
        assert.equal((await action).status, "needs_cart_page");
        assert.equal(env.calls.length, 0);
        return;
      }
      assert.equal(env.calls.length, 1);
      if (state === "partial-result") {
        env.update(env.notification(), cart([cover]));
        assert.equal(env.hasDeadline(), true);
        env.timeout();
        assert.equal((await action).status, "handed_off");
      }
      if (state === "rejected-promise") {
        rejectTheme(new Error("private theme failure"));
        await rejected;
      }
      if (state === "cancelled") {
        env.controller.abort();
        assert.equal((await action).status, "handed_off");
      }
      assert.equal(env.calls.length, 1);
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("quantity uses the configured line's change workflow with the full linked-item context", async (t) => {
  const warranty = line("warranty:1", 2, {
    product_type: "Warranty",
    properties: { _warranty_group: "group-b" },
  });
  const env = setup(t, { items: [line("123:a"), line("123:b", 2), warranty] });
  const action = env.actions.setCartQuantity("123:b", 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "quantity");
  assert.equal(env.calls[0].key, "123:b");
  assert.equal(env.calls[0].quantity, 4);
  assert.equal(env.calls[0].cart.items[2].key, warranty.key);
  const owner = env.calls[0].owner;
  let settled = false;
  action.then(() => {
    settled = true;
  });
  env.update(owner, cart([line("123:a", 4), line("123:b", 2), warranty]));
  env.update(
    owner.querySelector("input"),
    cart([line("123:a"), line("123:b", 4)]),
  );
  env.update(
    env.document.querySelector("app-provider"),
    cart([line("123:a"), line("123:b", 4)]),
  );
  env.update(owner, { items: [{ key: "123:b", quantity: 4 }] });
  await flush();
  assert.equal(
    settled,
    false,
    "different configured lines, event origins and invalid data cannot confirm success",
  );
  env.update(
    owner,
    cart([line("123:a"), line("123:b", 4), { ...warranty, quantity: 4 }]),
  );
  assert.equal((await action).status, "updated");
  assert.equal(env.listeners.size, 0);
});

test("missing line controls use the current notification owner with the exact Product line key", async (t) => {
  const other = line("123:a", 1, { product_type: "Product" });
  const target = line("123:b", 1, { product_type: "Product", properties: { Width: "1200mm" } });
  const linked = line("insurance:1", 1, { product_type: "Insurance" });
  const env = setup(t, {
    items: [other, target, linked],
    quantityKeys: ["123:a"],
    notification: true,
  });
  const owner = env.notification();
  const action = env.actions.setCartQuantity(target.key, 3, env.controller.signal);
  await flush();
  assert.equal(env.requests(), 1);
  assert.equal(env.nativeSubmissions(), 0);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "notification-quantity");
  assert.equal(env.calls[0].owner, owner);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].updates)), { [target.key]: 3 });
  assert.equal(env.calls[0].cart.items[2].key, linked.key);
  env.update(owner, cart([{ ...other, quantity: 3, final_line_price: 3000 }, target, linked]));
  assert.equal(env.hasDeadline(), true, "the same variant's other line cannot confirm the change");
  env.update(env.owner("cart-sections"), cart([other, { ...target, quantity: 3, final_line_price: 3000 }, linked]));
  assert.equal(env.hasDeadline(), true, "another owner cannot confirm the change");
  env.update(owner, cart([other, { ...target, quantity: 3, final_line_price: 3000 }, linked]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items.find((item) => item.lineKey === target.key).quantity, 3);
  assert.equal(result.cart.items.find((item) => item.lineKey === other.key).quantity, 1);
  assert.equal(JSON.stringify(result).includes("Width"), false);
  assert.equal(JSON.stringify(result).includes("private-cart-token"), false);
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("quantity accepts a rotated Shopify key only for the unique configured Product line", async (t) => {
  const other = line("123:a", 1, {
    product_type: "Product",
    properties: { _group_id: "other", Width: "900mm" },
  });
  const target = line("123:b", 3, {
    product_type: "Product",
    properties: { _group_id: "target", Width: "1200mm" },
  });
  const linked = line("cover:1", 3, {
    product_type: "Insurance",
    properties: { _group_id: "target" },
  });
  const env = setup(t, {
    items: [other, target, linked],
    quantityKeys: ["123:a"],
    notification: true,
  });
  const action = env.actions.setCartQuantity(target.key, 4, env.controller.signal);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].updates)), { [target.key]: 4 });
  const rotated = line("123:rotated", 4, {
    product_type: "Product",
    properties: { Width: "1200mm", _group_id: "target" },
  });
  env.update(env.notification(), cart([other, rotated, linked]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items.find((item) => item.lineKey === rotated.key).quantity, 4);
  assert.equal(result.cart.items.some((item) => item.lineKey === target.key), false);
  assert.equal(result.cart.items.find((item) => item.lineKey === other.key).quantity, 1);
  assert.equal(env.calls.length, 1, "key rotation never submits a second mutation");
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("rotated-key confirmation rejects changed, missing and ambiguous Product identities", async (t) => {
  const base = { product_type: "Product", properties: { _group_id: "target", Width: "1200mm" } };
  const target = line("123:b", 3, base);
  const other = line("123:a", 1, {
    product_type: "Product",
    properties: { _group_id: "other", Width: "900mm" },
  });
  const rotated = line("123:rotated", 4, base);
  const cases = [
    ["changed properties", [other, line("123:rotated", 4, {
      product_type: "Product",
      properties: { _group_id: "target", Width: "1100mm" },
    })]],
    ["changed variant", [other, { ...rotated, variant_id: 456 }]],
    ["wrong quantity", [other, { ...rotated, quantity: 2, final_line_price: 2000 }]],
    ["original key remains", [other, target, rotated]],
    ["ambiguous new lines", [other, rotated, { ...rotated, key: "123:also-rotated" }]],
    ["linked new line", [other, { ...rotated, parent_relationship: { parent_key: other.key } }]],
  ];
  for (const [name, updatedItems] of cases) {
    await t.test(name, async (t) => {
      const env = setup(t, {
        items: [other, target],
        quantityKeys: ["123:a"],
        notification: true,
      });
      const action = env.actions.setCartQuantity(target.key, 4, env.controller.signal);
      await flush();
      assert.equal(env.calls.length, 1);
      env.update(env.notification(), cart(updatedItems));
      assert.equal(env.hasDeadline(), true, "this event cannot confirm the requested line");
      env.timeout();
      assert.equal((await action).status, "handed_off");
      assert.equal(env.calls.length, 1);
      assert.equal(env.listeners.size, 0);
    });
  }
  for (const [name, baselineItems] of [
    ["missing native properties", [other, line("123:b", 3, { product_type: "Product" })]],
    ["ambiguous baseline", [other, target, { ...target, key: "123:duplicate" }]],
  ]) {
    await t.test(name, async (t) => {
      const env = setup(t, {
        items: baselineItems,
        quantityKeys: ["123:a"],
        notification: true,
      });
      const action = env.actions.setCartQuantity(target.key, 4, env.controller.signal);
      await flush();
      assert.equal(env.calls.length, 1);
      env.update(env.notification(), cart([other, rotated]));
      assert.equal(env.hasDeadline(), true);
      env.timeout();
      assert.equal((await action).status, "handed_off");
    });
  }
});

test("rotated-key confirmation compares selling plans and the immutable admission identity", async (t) => {
  const originalProperties = { _group_id: "target", Width: "1200mm" };
  const target = line("123:b", 3, {
    product_type: "Product",
    properties: originalProperties,
    selling_plan_allocation: { selling_plan: { id: 111 } },
  });
  const env = setup(t, {
    items: [target],
    quantityKeys: [],
    notification: true,
  });
  const baseline = cart([structuredClone(target)]);
  env.window.fetch = async () => ({ ok: true, json: async () => baseline });
  const action = env.actions.setCartQuantity(target.key, 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  baseline.items[0].properties.Width = "1100mm";
  env.update(env.notification(), cart([line("123:rotated", 4, {
    product_type: "Product",
    properties: { _group_id: "target", Width: "1100mm" },
    selling_plan_allocation: { selling_plan: { id: 111 } },
  })]));
  assert.equal(env.hasDeadline(), true, "an in-place baseline change cannot redefine the admitted line");
  env.update(env.notification(), cart([line("123:rotated", 4, {
    product_type: "Product",
    properties: originalProperties,
    selling_plan_allocation: { selling_plan: { id: 222 } },
  })]));
  assert.equal(env.hasDeadline(), true, "a different selling plan is a different line");
  env.update(env.notification(), cart([line("123:rotated", 4, {
    product_type: "Product",
    properties: originalProperties,
    selling_plan_allocation: { selling_plan: { id: 111 } },
  })]));
  assert.equal((await action).status, "updated");
  assert.equal(env.calls.length, 1);
});

test("linked per-product cover and blind use one native update with both exact keys", async (t) => {
  const parent = line("123:a", 3, {
    product_type: "Product",
    properties: { _group_id: "configured-a", _insurance_group: "cover-a", Width: "1200mm" },
  });
  const child = line("cover:a", 3, {
    product_type: "Insurance",
    properties: {
      _group_id: "configured-a",
      _insurance_group: "cover-a",
      _associated_product_id: "123",
      _insurance_type: "product",
    },
    parent_relationship: { parent_key: parent.key },
  });
  const unrelated = line("123:b", 2, {
    product_type: "Product",
    properties: { _group_id: "configured-b", Width: "900mm" },
  });
  const env = setup(t, { items: [parent, child, unrelated], quantityKeys: ["123:a", "123:b"] });
  const input = env.owner("quantity-input", parent.key).querySelector("input");
  const action = env.actions.setCartQuantity(parent.key, 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "notification-quantity");
  assert.equal(env.calls[0].owner, env.owner("cart-sections"));
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].updates)), {
    [parent.key]: 4,
    [child.key]: 4,
  });
  assert.equal(input.value, "1", "a grouped update does not dispatch a second line-control change");
  const newParent = {
    ...parent, key: "123:rotated", quantity: 4, final_line_price: 4000,
  };
  const newChild = {
    ...child, key: "cover:rotated", quantity: 4, final_line_price: 4000,
    parent_relationship: { parent_key: newParent.key },
  };
  env.update(env.owner("cart-sections"), cart([newParent, newChild, unrelated]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.items.find((item) => item.lineKey === newParent.key).quantity, 4);
  assert.equal(result.cart.items.find((item) => item.lineKey === newChild.key).quantity, 4);
  assert.equal(result.cart.items.find((item) => item.lineKey === unrelated.key).quantity, 2);
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("missing quantity controls may update a verified linked warranty through the current notification owner", async (t) => {
  const parent = line("123:a", 2, {
    product_type: "Product",
    properties: { _group_id: "configured-a", _warranty_group: "warranty-a" },
  });
  const child = line("warranty:a", 2, {
    product_type: "Warranty",
    properties: { _group_id: "configured-a", _warranty_group: "warranty-a", _associated_product_id: 123 },
    parent_relationship: { parent_key: parent.key },
  });
  const env = setup(t, { items: [parent, child], quantityKeys: [], notification: true });
  const action = env.actions.setCartQuantity(parent.key, 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].owner, env.notification());
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].updates)), {
    [parent.key]: 4,
    [child.key]: 4,
  });
  env.update(env.notification(), cart([
    { ...parent, quantity: 4, final_line_price: 4000 },
    { ...child, quantity: 4, final_line_price: 4000 },
  ]));
  assert.equal((await action).status, "updated");
});

test("linked quantity rejects unknown or mismatched children before any cart write", async (t) => {
  const parent = line("123:a", 3, {
    product_type: "Product",
    properties: { _group_id: "configured-a", _insurance_group: "cover-a", _warranty_group: "warranty-a" },
  });
  const insuranceProperties = {
    _group_id: "configured-a",
    _insurance_group: "cover-a",
    _associated_product_id: "123",
    _insurance_type: "product",
  };
  const child = line("cover:a", 3, {
    product_type: "Insurance",
    properties: insuranceProperties,
    parent_relationship: { parent_key: parent.key },
  });
  const cases = [
    ["mismatched initial quantity", { ...child, quantity: 2 }],
    ["cart-level cover", { ...child, properties: { ...insuranceProperties, _insurance_type: "cart" } }],
    ["missing per-product role", { ...child, properties: { ...insuranceProperties, _insurance_type: undefined } }],
    ["different insurance group", { ...child, properties: { ...insuranceProperties, _insurance_group: "other" } }],
    ["different configured group", { ...child, properties: { ...insuranceProperties, _group_id: "other" } }],
    ["different associated product", { ...child, properties: { ...insuranceProperties, _associated_product_id: "456" } }],
    ["unknown linked extra", { ...child, product_type: "Express Dispatch" }],
    ["ambiguous child identity", child, { ...child, key: "cover:duplicate" }],
  ];
  for (const [name, ...linked] of cases) {
    await t.test(name, async (t) => {
      const env = setup(t, { items: [parent, ...linked], quantityKeys: [parent.key] });
      await assert.rejects(
        env.actions.setCartQuantity(parent.key, 4, env.controller.signal),
        /linked cart line|linked cart lines/,
      );
      assert.equal(env.calls.length, 0);
      assert.equal(env.requests(), 1);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("a partial linked update remains uncertain and never triggers another mutation", async (t) => {
  const parent = line("123:a", 3, {
    product_type: "Product",
    properties: { _group_id: "configured-a", _insurance_group: "cover-a" },
  });
  const child = line("cover:a", 3, {
    product_type: "Insurance",
    properties: {
      _group_id: "configured-a", _insurance_group: "cover-a",
      _associated_product_id: "123", _insurance_type: "product",
    },
    parent_relationship: { parent_key: parent.key },
  });
  const env = setup(t, { items: [parent, child], quantityKeys: [parent.key] });
  const action = env.actions.setCartQuantity(parent.key, 4, env.controller.signal);
  await flush();
  const owner = env.owner("cart-sections");
  env.update(owner, cart([
    { ...parent, key: "123:rotated", quantity: 4, final_line_price: 4000 },
    { ...child, quantity: 4, final_line_price: 4000 },
  ]));
  assert.equal(env.hasDeadline(), true, "a child still linked to the old parent key cannot confirm success");
  env.update(owner, cart([
    { ...parent, key: "123:rotated", quantity: 4, final_line_price: 4000 },
    { ...child, parent_relationship: { parent_key: "123:rotated" } },
  ]));
  assert.equal(env.hasDeadline(), true, "parent-only confirmation cannot hide an unchanged cover");
  env.timeout();
  const result = await action;
  assert.equal(result.status, "handed_off");
  assert.match(result.message, /linked cover/);
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
});

test("linked controls validate range and require an available atomic theme method before writing", async (t) => {
  const parent = line("123:a", 3, {
    product_type: "Product",
    properties: { _group_id: "configured-a", _warranty_group: "warranty-a" },
  });
  const child = line("warranty:a", 3, {
    product_type: "Warranty",
    properties: { _group_id: "configured-a", _warranty_group: "warranty-a", _associated_product_id: "123" },
    parent_relationship: { parent_key: parent.key },
  });
  for (const state of ["out-of-range", "missing-method", "stale-owner", "disabled-control"]) {
    await t.test(state, async (t) => {
      const env = setup(t, { items: [parent, child], quantityKeys: [parent.key] });
      const control = env.owner("quantity-input", parent.key);
      const sections = env.owner("cart-sections");
      if (state === "out-of-range") control.querySelector("input").max = "3";
      if (state === "missing-method") sections.updateQuantityToCart = undefined;
      if (state === "stale-owner") sections.cart.items.pop();
      if (state === "disabled-control") control.querySelector("input").disabled = true;
      const action = env.actions.setCartQuantity(parent.key, 4, env.controller.signal);
      if (state === "out-of-range") await assert.rejects(action, /allowed range/);
      else if (state === "missing-method") await assert.rejects(action, /cannot update this blind and its linked cover/);
      else assert.equal((await action).status, "needs_cart_page");
      assert.equal(env.calls.length, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("notification fallback refuses samples, linked lines and non-Product lines", async (t) => {
  for (const [name, extra] of [
    ["sample", { product_type: "Sample" }],
    ["insurance", { product_type: "Insurance" }],
    ["warranty", { product_type: "Warranty" }],
    ["linked product", { product_type: "Product", parent_relationship: { parent_key: "123:a" } }],
    ["unknown product type", {}],
  ]) {
    await t.test(name, async (t) => {
      const env = setup(t, {
        items: [line("123:a", 1, { product_type: "Product" }), line("123:b", 1, extra)],
        quantityKeys: ["123:a"],
        notification: true,
      });
      const result = await env.actions.setCartQuantity("123:b", 3, env.controller.signal);
      assert.equal(result.status, "needs_cart_page");
      assert.equal(env.calls.length, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("notification fallback requires a registered fresh idle owner and current line", async (t) => {
  for (const state of ["missing", "stale", "inert", "aria-disabled", "missing-method", "loading", "uninitialized", "duplicate-provider", "stale-line"]) {
    await t.test(state, async (t) => {
      const env = setup(t, {
        initialized: state !== "uninitialized",
        items: [line("123:a", 1, { product_type: "Product" }), line("123:b", 1, { product_type: "Product" })],
        quantityKeys: ["123:a"],
        notification: state !== "missing",
      });
      const owner = env.notification();
      if (state === "stale") owner.cart.items.pop();
      if (state === "inert") owner.setAttribute("inert", "");
      if (state === "aria-disabled") owner.setAttribute("aria-disabled", "true");
      if (state === "missing-method") owner.updateQuantityToCart = undefined;
      if (state === "loading") owner.shopifyCartLoading = true;
      if (state === "duplicate-provider") env.document.body.append(env.document.createElement("app-provider"));
      const run = env.actions.setCartQuantity(state === "stale-line" ? "123:gone" : "123:b", 3, env.controller.signal);
      if (state === "loading") await assert.rejects(run, /current cart update/);
      else if (state === "stale-line") await assert.rejects(run, /no longer exists/);
      else assert.equal((await run).status, "needs_cart_page");
      assert.equal(env.calls.length, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("existing quantity controls remain authoritative when the notification owner is available", async (t) => {
  for (const state of ["ready", "disabled", "stale", "wrong-property-key", "invalid-range"]) {
    await t.test(state, async (t) => {
      const env = setup(t, {
        items: [line("123:a", 1, { product_type: "Product" }), line("123:b", 2, { product_type: "Product" })],
        notification: true,
      });
      const owner = env.owner("quantity-input");
      if (state === "disabled") owner.querySelector("input").disabled = true;
      if (state === "stale") owner.cart.items.pop();
      if (state === "wrong-property-key") Object.defineProperty(owner, "lineItemKey", { value: "123:b" });
      if (state === "invalid-range") owner.querySelector("input").max = "2";
      const run = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
      if (state === "invalid-range") await assert.rejects(run, /allowed range/);
      else if (state === "ready") {
        await flush();
        assert.equal(env.calls.length, 1);
        assert.equal(env.calls[0].owner, owner);
        env.update(owner, cart([line("123:a", 3), line("123:b", 2)]));
        assert.equal((await run).status, "updated");
      } else assert.equal((await run).status, "needs_cart_page");
      assert.equal(env.calls.some((call) => call.kind === "notification-quantity"), false);
    });
  }
});

test("notification quantity failures and cancellation never replay its one native call", async (t) => {
  for (const state of ["cart-error", "rejected-promise", "cancelled"]) {
    await t.test(state, async (t) => {
      const env = setup(t, {
        items: [line("123:a", 1, { product_type: "Product" })],
        quantityKeys: [],
        notification: true,
      });
      let rejectTheme;
      if (state === "rejected-promise")
        env.setQuantityPromise(new Promise((_, reject) => { rejectTheme = reject; }));
      const action = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
      const rejected = state === "cancelled" ? undefined : assert.rejects(action, /could not confirm/);
      await flush();
      assert.equal(env.calls.length, 1);
      if (state === "cart-error") env.notification().dispatchEvent(new env.window.Event("cart:error"));
      if (state === "rejected-promise") rejectTheme(new Error("private theme failure"));
      if (state === "cancelled") env.controller.abort();
      if (rejected) await rejected;
      else assert.equal((await action).status, "handed_off");
      assert.equal(env.calls.length, 1);
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("batch removal serializes native controls, keeps unrelated cover, and reports only its final confirmed cart", async (t) => {
  const cover = line("cover:retained", 1, {product_type: "Insurance", properties: {_insurance_group: "retained"}});
  const retained = line("retained:blind");
  const env = setup(t, {items: [line("123:a"), line("123:b"), retained, cover]});
  const action = env.actions.removeFromCart(["123:a", "123:b"], env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1, "second removal waits for the first theme result");
  assert.equal(env.calls[0].key, "123:a");
  env.settle(env.calls[0].owner, cart([line("123:b"), retained, cover]));
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(env.requests(), 2, "fresh cart before each native action");
  assert.equal(env.calls[1].key, "123:b");
  env.settle(env.calls[1].owner, cart([retained, cover]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.deepEqual(Array.from(result.cart.items, (item) => item.lineKey), [retained.key, cover.key]);
  assert.equal(result.cart.items[1].productType, "Insurance");
  assert.equal(env.hasDeadline(), false);
  assert.equal(env.listeners.size, 0);
});

test("a stale second requested key fails preflight before any mutation", async (t) => {
  const env = setup(t);
  await assert.rejects(env.actions.removeFromCart(["123:a", "missing:key"], env.controller.signal), /no longer exists/);
  assert.equal(env.calls.length, 0);
  assert.equal(env.requests(), 1);
  assert.equal(env.hasDeadline(), false);
});

test("native removal may confirm a requested dependent gone without another write", async (t) => {
  const linked = line("insurance:1", 1, {product_type: "Insurance"});
  const env = setup(t, {items: [line("123:a"), line("123:b"), linked]});
  const action = env.actions.removeFromCart(["123:a", linked.key], env.controller.signal);
  await flush();
  env.settle(env.calls[0].owner, cart([line("123:b")]));
  assert.equal((await action).status, "updated");
  assert.equal(env.calls.length, 1);
  assert.equal(env.requests(), 1);
});

test("a target disappearing between native actions stops the batch without guessing or retrying", async (t) => {
  const env = setup(t);
  const action = env.actions.removeFromCart(["123:a", "123:b"], env.controller.signal);
  await flush();
  env.settle(env.calls[0].owner, cart([line("123:b", 2)]));
  env.setInitial(cart([line("123:changed", 2)]));
  const result = await action;
  assert.equal(result.status, "handed_off");
  assert.match(result.message, /1 of 2.*confirmed removed/);
  assert.equal(env.calls.length, 1);
  assert.equal(env.hasDeadline(), false);
});

test("a final snapshot with an earlier requested line reintroduced cannot confirm the complete batch", async (t) => {
  const env = setup(t);
  const action = env.actions.removeFromCart(["123:a", "123:b"], env.controller.signal);
  await flush();
  env.settle(env.calls[0].owner, cart([line("123:b", 2)]));
  await flush();
  env.settle(env.calls[1].owner, cart([line("123:a")]));
  const result = await action;
  assert.equal(result.status, "handed_off");
  assert.match(result.message, /1 of 2/);
  assert.equal(env.calls.length, 2);
});

test("abort, navigation and shared deadline stop remaining removals after the first submission", async (t) => {
  for (const reason of ["abort", "navigation", "deadline"]) {
    await t.test(reason, async (t) => {
      const env = setup(t);
      const action = env.actions.removeFromCart(["123:a", "123:b"], env.controller.signal);
      await flush();
      env.settle(env.calls[0].owner, cart([line("123:b", 2)]));
      if (reason === "abort") env.controller.abort();
      if (reason === "navigation") env.document.dispatchEvent(new env.window.Event("roman:navigation"));
      if (reason === "deadline") env.timeout(35000);
      const result = await action;
      assert.equal(result.status, "handed_off");
      assert.match(result.message, /1 of 2/);
      assert.equal(env.calls.length, 1);
      assert.equal(env.hasDeadline(), false);
      assert.equal(env.listeners.size, 0);
    });
  }
});

test("quantity-select uses the offered value and requires its exact line and owner confirmation", async (t) => {
  const env = setup(t, { quantityTag: "quantity-select" });
  const owner = env.owner("quantity-select", "123:b");
  const action = env.actions.setCartQuantity("123:b", 4, env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].owner, owner);
  assert.equal(env.calls[0].key, "123:b");
  assert.equal(env.calls[0].quantity, 4);
  assert.equal(owner.querySelector("select").value, "4");
  assert.equal(env.owner("quantity-select").querySelector("select").value, "1");
  assert.equal(env.nativeSubmissions(), 0);
  env.update(owner, cart([line("123:a", 4), line("123:b", 2)]));
  assert.equal(env.hasDeadline(), true, "The same variant's other line cannot confirm this change");
  env.update(env.owner("quantity-select"), cart([line("123:a"), line("123:b", 4)]));
  assert.equal(env.hasDeadline(), true, "A different native owner cannot confirm this change");
  env.update(owner, cart([line("123:a"), line("123:b", 4)]));
  assert.equal((await action).status, "updated");
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.hasDeadline(), false);
});

test("quantity-select rejects unavailable and ambiguous values without changing the control", async (t) => {
  for (const reason of ["not-offered", "disabled-option", "disabled-optgroup", "aria-disabled-option", "duplicate-value"]) {
    await t.test(reason, async (t) => {
      const env = setup(t, { quantityTag: "quantity-select" });
      const select = env.owner("quantity-select").querySelector("select");
      const option = select.querySelector('option[value="4"]');
      if (reason === "not-offered") option.remove();
      if (reason === "disabled-option") option.disabled = true;
      if (reason === "aria-disabled-option") option.setAttribute("aria-disabled", "true");
      if (reason === "disabled-optgroup") {
        const group = env.document.createElement("optgroup");
        group.disabled = true;
        option.replaceWith(group);
        group.append(option);
      }
      if (reason === "duplicate-value") select.append(option.cloneNode(true));
      await assert.rejects(
        env.actions.setCartQuantity("123:a", 4, env.controller.signal),
        /allowed range/,
      );
      assert.equal(select.value, "1");
      assert.equal(env.calls.length, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("quantity-select requires an initialized, current, enabled single native select", async (t) => {
  for (const reason of ["uninitialized", "missing-select", "duplicate-select", "multiple", "disabled", "disabled-fieldset", "inert", "stale", "wrong-property-key"]) {
    await t.test(reason, async (t) => {
      const env = setup(t, { initialized: reason !== "uninitialized", quantityTag: "quantity-select" });
      const owner = env.owner("quantity-select");
      const select = owner.querySelector("select");
      if (reason === "missing-select") select.remove();
      if (reason === "duplicate-select") owner.append(select.cloneNode(true));
      if (reason === "multiple") select.multiple = true;
      if (reason === "disabled") select.disabled = true;
      if (reason === "disabled-fieldset") {
        const fieldset = env.document.createElement("fieldset");
        fieldset.disabled = true;
        select.replaceWith(fieldset);
        fieldset.append(select);
      }
      if (reason === "inert") owner.setAttribute("inert", "");
      if (reason === "stale") owner.cart.items.pop();
      if (reason === "wrong-property-key") Object.defineProperty(owner, "lineItemKey", { value: "123:b" });
      const result = await env.actions.setCartQuantity("123:a", 4, env.controller.signal);
      assert.equal(result.status, "needs_cart_page");
      assert.equal(select.value, "1");
      assert.equal(env.calls.length, 0);
    });
  }
});

test("clear invokes the public theme method once and requires a confirmed empty cart", async (t) => {
  const env = setup(t);
  const action = env.actions.clearCart(env.controller.signal);
  await flush();
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].kind, "clear");
  const owner = env.calls[0].owner;
  env.update(owner, cart([line("123:a")]));
  assert.equal(env.hasDeadline(), true);
  env.update(owner, cart([]));
  const result = await action;
  assert.equal(result.status, "updated");
  assert.equal(result.cart.itemCount, 0);
  assert.equal(env.hasDeadline(), false);
});

test("absent, uninitialized, inert, disabled and stale controls make no mutation", async (t) => {
  for (const state of [
    "missing",
    "uninitialized",
    "inert",
    "disabled",
    "disabled-fieldset",
    "stale",
  ]) {
    await t.test(state, async (t) => {
      const env = setup(t, { initialized: state !== "uninitialized" });
      const owner = env.owner("quantity-input");
      const input = owner.querySelector("input");
      if (state === "missing") owner.remove();
      if (state === "inert") owner.setAttribute("inert", "");
      if (state === "disabled") input.disabled = true;
      if (state === "disabled-fieldset") {
        const fieldset = env.document.createElement("fieldset");
        fieldset.disabled = true;
        input.replaceWith(fieldset);
        fieldset.append(input);
      }
      if (state === "stale") owner.cart.items.pop();
      const result = await env.actions.setCartQuantity(
        "123:a",
        3,
        env.controller.signal,
      );
      assert.equal(result.status, "needs_cart_page");
      assert.equal(env.calls.length, 0);
      assert.equal(input.value, "1");
      assert.equal(env.listeners.size, 0);
    });
  }
});

test("theme quantity constraints are checked without changing the live input", async (t) => {
  for (const state of ["min", "max", "step", "theme-min", "theme-max"]) {
    await t.test(state, async (t) => {
      const env = setup(t);
      const owner = env.owner("quantity-input");
      const input = owner.querySelector("input");
      if (state === "min") input.min = "5";
      if (state === "max") input.max = "2";
      if (state === "step") {
        input.min = "2";
        input.step = "2";
      }
      if (state === "theme-min") owner.min = 5;
      if (state === "theme-max") owner.max = 2;
      await assert.rejects(
        env.actions.setCartQuantity("123:a", 3, env.controller.signal),
        /allowed range/,
      );
      assert.equal(input.value, "1");
      assert.equal(env.calls.length, 0);
    });
  }
});

test("theme loading and concurrent actions prevent another submission", async (t) => {
  const env = setup(t);
  env.owner("quantity-input").shopifyCartLoading = true;
  await assert.rejects(
    env.actions.setCartQuantity("123:a", 3, env.controller.signal),
    /current cart update/,
  );
  env.owner("quantity-input").shopifyCartLoading = false;
  const action = env.actions.removeFromCart(["123:a"], env.controller.signal);
  await assert.rejects(
    env.actions.clearCart(env.controller.signal),
    /Another cart action/,
  );
  await flush();
  env.timeout();
  assert.equal((await action).status, "handed_off");
  assert.equal(env.calls.length, 1);
  assert.equal(env.listeners.size, 0);
});

test("clearing respects inert cart owners and removal respects disabled native controls", async (t) => {
  const env = setup(t);
  const owner = env.owner("cart-sections");
  owner.setAttribute("inert", "");
  assert.equal(
    (await env.actions.clearCart(env.controller.signal)).status,
    "needs_cart_page",
  );
  owner.removeAttribute("inert");
  env.owner("cart-remove-toggle").querySelector("button").disabled = true;
  assert.equal(
    (await env.actions.removeFromCart(["123:a"], env.controller.signal)).status,
    "needs_cart_page",
  );
  assert.equal(env.calls.length, 0);
  assert.equal(env.nativeSubmissions(), 0);
});

test("pre-action cancellation or a failed cart read cannot mutate the cart", async (t) => {
  const env = setup(t);
  env.controller.abort();
  await assert.rejects(env.actions.clearCart(env.controller.signal), {
    name: "AbortError",
  });
  assert.equal(env.requests(), 0);
  assert.equal(env.calls.length, 0);
  const fresh = setup(t);
  fresh.window.fetch = async () => {
    throw new Error("private transport failure");
  };
  await assert.rejects(
    fresh.actions.clearCart(fresh.controller.signal),
    /could not be completed/,
  );
  assert.equal(fresh.calls.length, 0);
});

test("cancellation while reading the baseline preserves the live quantity", async (t) => {
  const env = setup(t);
  let resolveRead;
  env.window.fetch = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const action = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
  env.controller.abort();
  resolveRead({
    ok: true,
    json: async () => cart([line("123:a"), line("123:b", 2)]),
  });
  await assert.rejects(action, { name: "AbortError" });
  assert.equal(env.owner("quantity-input").querySelector("input").value, "1");
  assert.equal(env.calls.length, 0);
});

test("navigation during the cart read prevents a delayed theme action", async (t) => {
  const env = setup(t);
  let resolveRead;
  env.window.fetch = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const action = env.actions.clearCart(env.controller.signal);
  env.document.dispatchEvent(new env.window.Event("roman:navigation"));
  resolveRead({
    ok: true,
    json: async () => cart([line("123:a"), line("123:b", 2)]),
  });
  assert.equal((await action).status, "needs_cart_page");
  assert.equal(env.calls.length, 0);
});

test("abort, navigation and pagehide after submission stop observation without undoing or retrying", async (t) => {
  for (const reason of ["abort", "navigation", "pagehide"]) {
    await t.test(reason, async (t) => {
      const env = setup(t);
      let rejectTheme;
      env.setClearPromise(
        new Promise((_, reject) => {
          rejectTheme = reject;
        }),
      );
      const action = env.actions.clearCart(env.controller.signal);
      await flush();
      if (reason === "abort") env.controller.abort();
      if (reason === "navigation")
        env.document.dispatchEvent(new env.window.Event("roman:navigation"));
      if (reason === "pagehide")
        env.window.dispatchEvent(new env.window.Event("pagehide"));
      const result = await action;
      assert.equal(result.status, "handed_off");
      assert.match(result.message, /cannot undo/);
      assert.equal(env.calls.length, 1);
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
      rejectTheme(new Error("late private theme error"));
      await flush();
    });
  }
});

test("theme failure events and rejected clear promises expose no raw response", async (t) => {
  for (const reason of ["event", "promise"]) {
    await t.test(reason, async (t) => {
      const env = setup(t);
      let rejectTheme;
      env.setClearPromise(
        new Promise((_, reject) => {
          rejectTheme = reject;
        }),
      );
      const action = env.actions.clearCart(env.controller.signal);
      const rejected = assert.rejects(
        action,
        (error) =>
          /could not confirm/.test(error.message) &&
          !error.message.includes("private"),
      );
      await flush();
      if (reason === "event")
        env.owner("cart-sections").dispatchEvent(
          new env.window.CustomEvent("cart:error", {
            detail: "private response",
          }),
        );
      else rejectTheme(new Error("private response"));
      await rejected;
      assert.equal(env.listeners.size, 0);
      assert.equal(env.hasDeadline(), false);
    });
  }
});

test("discount-related key changes are not guessed by variant ID", async (t) => {
  const env = setup(t);
  const action = env.actions.setCartQuantity("123:a", 3, env.controller.signal);
  await flush();
  env.update(
    env.owner("quantity-input"),
    cart([line("123:changed", 3), line("123:b", 2)]),
  );
  env.timeout();
  assert.equal((await action).status, "handed_off");
});

test("already satisfied quantities and empty carts need no theme submission", async (t) => {
  const env = setup(t);
  assert.equal(
    (await env.actions.setCartQuantity("123:a", 1, env.controller.signal))
      .status,
    "updated",
  );
  env.setInitial(cart([]));
  assert.equal(
    (await env.actions.clearCart(env.controller.signal)).status,
    "updated",
  );
  assert.equal(env.calls.length, 0);
});

test("invalid quantities and stale line keys are rejected before mutation", async (t) => {
  const env = setup(t);
  for (const quantity of [0, -1, 1.5, 1000, Infinity])
    await assert.rejects(
      env.actions.setCartQuantity("123:a", quantity, env.controller.signal),
      /positive whole-number/,
    );
  await assert.rejects(
    env.actions.removeFromCart([""], env.controller.signal),
    /current cart lineKeys/,
  );
  assert.equal(env.requests(), 0);
  await assert.rejects(
    env.actions.removeFromCart(["123:missing"], env.controller.signal),
    /no longer exists/,
  );
  assert.equal(env.calls.length, 0);
});
