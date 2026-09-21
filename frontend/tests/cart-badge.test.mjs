import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { RouterProvider } from 'react-router/dom';
      import { createAssistantRouter } from './frontend/src/app';
      export function mount(container, props) {
        const root = createRoot(container);
        const router = createAssistantRouter(props);
        flushSync(() => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
        return () => { flushSync(() => root.unmount()); router.dispose(); };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "CartBadgeTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}
function cart(quantities) {
  return {
    currency: "GBP",
    item_count: quantities.reduce((sum, value) => sum + value, 0),
    total_price: 4500 * quantities.reduce((sum, value) => sum + value, 0),
    items: quantities.map((quantity, index) => ({
      key: `line-${index}`,
      title: `Blind ${index + 1}`,
      quantity,
      variant_id: index + 1,
      final_line_price: quantity * 4500,
    })),
  };
}
function setup(t, { open = true, restored = false, endExpected = false } = {}) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://hd-dev-single.myshopify.com/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  Object.assign(window, { Request, Response, Headers });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  if (open) window.document.documentElement.setAttribute("data-roman-open", "");
  const errors = [],
    calls = [],
    sessionCalls = [];
  window.console.error = (...args) => errors.push(args);
  window.fetch = (url, options) =>
    new Promise((resolve, reject) =>
      calls.push({
        url: String(url),
        options,
        complete(value) {
          resolve({
            ok: true,
            status: 200,
            json: async () => value,
            headers: new Map(),
          });
        },
        fail() {
          reject(new window.Error("Read failed"));
        },
      }),
    );
  let page = { url: window.location.href, pending: false, error: null };
  let state = {
    conversation: restored
      ? {
          id: "restored",
          status: "active",
          messages: [],
          tools: [],
          busy: false,
        }
      : null,
    voice: { status: "idle", muted: false, error: null },
    selectedVoice: "marin",
    pending: false,
    restoring: false,
    error: null,
  };
  const navigationListeners = new Set(),
    sessionListeners = new Set();
  const session = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    sendMessage: async () => sessionCalls.push("message"),
    startVoice: async () => sessionCalls.push("voice"),
    end: async () => {
      sessionCalls.push("end");
      state = { ...state, conversation: null };
      sessionListeners.forEach((fn) => fn());
    },
  };
  const navigation = {
    getSnapshot: () => page,
    subscribe: (fn) => {
      navigationListeners.add(fn);
      return () => navigationListeners.delete(fn);
    },
  };
  window.eval(
    `${bundle.outputFiles[0].text};window.CartBadgeTest=CartBadgeTest;`,
  );
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const container = window.document.createElement("div");
  shadow.append(container);
  let disposed = false;
  const unmount = window.CartBadgeTest.mount(container, {
    logoUrl: "/logo.svg",
    navigation,
    session,
    tools: { execute: async () => {} },
    showTools: false,
    onReady: () => {},
    onError: (error) => errors.push(error),
  });
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      unmount();
    }
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(sessionCalls, endExpected ? ["end"] : []);
  });
  return {
    window,
    container,
    calls,
    dispose,
    navigationListeners,
    sessionListeners,
    badge: () => container.querySelector(".roman-cart-count"),
    show(view) {
      container
        .querySelector(
          `.roman-view-nav a[href="${view === "chat" ? "/" : "/" + view}"]`,
        )
        .click();
    },
    open(value) {
      window.document.documentElement.toggleAttribute("data-roman-open", value);
    },
    change() {
      window.document.body.dispatchEvent(
        new window.CustomEvent("cart:updated", { detail: { item_count: 999 } }),
      );
    },
    tools(tools) {
      state = {
        ...state,
        conversation: {
          id: "restored",
          status: "active",
          messages: [],
          busy: false,
          ...state.conversation,
          tools,
        },
      };
      sessionListeners.forEach((fn) => fn());
    },
    navigate(pending) {
      page = { ...page, pending };
      navigationListeners.forEach((fn) => fn());
    },
  };
}

test("the header counts total quantity from one shared read across Chat, Cart and Gallery", async (t) => {
  const ctx = setup(t, { restored: true });
  await until(
    () => ctx.calls.length === 1,
    "Restored open assistant reads once even in StrictMode",
  );
  assert.equal(ctx.badge(), null);
  ctx.calls[0].complete(cart([2, 1]));
  await until(
    () => ctx.badge()?.textContent === "3",
    "Badge counts quantities, not lines",
  );
  assert.equal(ctx.badge().getAttribute("aria-label"), "3 items");
  ctx.show("cart");
  await until(
    () => ctx.container.querySelectorAll(".roman-cart-items li").length === 2,
    "Cards share the loaded snapshot",
  );
  ctx.show("gallery");
  ctx.show("chat");
  await delay(20);
  assert.equal(
    ctx.calls.length,
    1,
    "Tab changes must not start another cart read",
  );
});

test("closed runtime waits for opening and refreshes once after hidden native cart changes", async (t) => {
  const ctx = setup(t, { open: false, restored: true });
  ctx.change();
  await delay(20);
  assert.equal(ctx.calls.length, 0);
  ctx.open(true);
  await until(() => ctx.calls.length === 1, "Open starts the deferred read");
  ctx.calls[0].complete(cart([1]));
  await until(() => ctx.badge(), "Positive badge renders");
  assert.equal(ctx.badge().getAttribute("aria-label"), "1 item");
  ctx.open(false);
  await delay(0);
  ctx.change();
  ctx.change();
  await delay(20);
  assert.equal(
    ctx.calls.length,
    1,
    "Hidden events invalidate without background fetching",
  );
  ctx.open(true);
  await until(() => ctx.calls.length === 2, "Reopen reads latest cart once");
  assert.equal(
    ctx.badge()?.textContent,
    "1",
    "Reopen retains the verified count while refreshing",
  );
  ctx.calls[1].complete(cart([]));
  await until(() => !ctx.badge(), "Empty cart hides badge");
});

for (const name of [
  "add_to_cart",
  "add_sample_to_cart",
  "remove_from_cart",
  "set_cart_quantity",
  "clear_cart",
])
  test(`${name} completion updates the badge without racing or duplicating its native event`, async (t) => {
    const ctx = setup(t);
    await until(() => ctx.calls.length === 1, "Initial read");
    ctx.calls[0].complete(cart([1]));
    await until(() => ctx.badge(), "Initial badge");
    ctx.tools([{ id: "mutation", name, status: "running", arguments: {} }]);
    await delay(0);
    assert.equal(
      ctx.badge()?.textContent,
      "1",
      "Running mutation retains the verified count",
    );
    ctx.change();
    await delay(20);
    assert.equal(
      ctx.calls.length,
      1,
      "Native event waits for running mutation",
    );
    ctx.tools([]);
    await until(() => ctx.calls.length === 2, "Mutation completion reads once");
    assert.equal(
      ctx.badge()?.textContent,
      "1",
      "Refresh retains the count until the replacement snapshot is verified",
    );
    ctx.calls[1].complete(cart(name === "clear_cart" ? [] : [4]));
    await until(
      () =>
        name === "clear_cart" ? !ctx.badge() : ctx.badge()?.textContent === "4",
      "Fresh count renders",
    );
    await delay(20);
    assert.equal(ctx.calls.length, 2);
  });

test("a completed mutation refreshes without a theme event and navigation alone does not duplicate reads", async (t) => {
  const ctx = setup(t);
  await until(() => ctx.calls.length === 1, "Initial read");
  ctx.calls[0].complete(cart([1]));
  await until(() => ctx.badge(), "Initial badge");
  ctx.navigate(true);
  await delay(0);
  assert.equal(
    ctx.badge()?.textContent,
    "1",
    "Hidden navigation retains the verified count",
  );
  ctx.navigate(false);
  await delay(20);
  assert.equal(ctx.calls.length, 1);
  ctx.tools([
    {
      id: "quantity",
      name: "set_cart_quantity",
      status: "running",
      arguments: {},
    },
  ]);
  await delay(0);
  ctx.tools([]);
  await until(() => ctx.calls.length === 2, "No-event completion refreshes");
  ctx.calls[1].complete(cart([2]));
  await until(() => ctx.badge()?.textContent === "2", "Count updated");
});

test("failed reads leave the badge unknown and the cart view offers an explicit retry", async (t) => {
  const ctx = setup(t);
  await until(() => ctx.calls.length === 1, "Initial read");
  ctx.calls[0].complete(cart([2]));
  await until(() => ctx.badge(), "Initial badge");
  ctx.change();
  await until(() => ctx.calls.length === 2, "Native event refreshes");
  assert.equal(
    ctx.badge()?.textContent,
    "2",
    "Pending refresh keeps the last verified quantity",
  );
  ctx.calls[1].fail();
  await until(() => !ctx.badge(), "Unknown count hides badge");
  ctx.show("cart");
  await until(
    () => ctx.container.querySelector(".roman-cart-stage [role=alert]"),
    "Cart owns the read error",
  );
  assert.equal(ctx.calls.length, 2);
  ctx.container.querySelector(".roman-cart-stage button").click();
  await until(() => ctx.calls.length === 3, "Explicit retry");
  ctx.calls[2].complete(cart([1]));
  await until(() => ctx.badge()?.textContent === "1", "Retry restores count");
});

test("ending chat retains the real cart snapshot and its badge without another read", async (t) => {
  const ctx = setup(t, { restored: true, endExpected: true });
  await until(() => ctx.calls.length === 1, "Initial read");
  ctx.calls[0].complete(cart([3]));
  await until(() => ctx.badge()?.textContent === "3", "Restored cart badge");
  ctx.show("cart");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "End chat review opens",
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () => !ctx.container.querySelector(".roman-dialog"),
    "Confirmed chat ends",
  );
  assert.equal(ctx.badge().textContent, "3");
  ctx.show("cart");
  await until(
    () => ctx.container.querySelector(".roman-cart-items li"),
    "Cart still available after chat ends",
  );
  assert.match(
    ctx.container.querySelector(".roman-cart-item-details").textContent,
    /Quantity 3/,
  );
  assert.equal(
    ctx.calls.length,
    1,
    "Conversation reset does not invalidate the cart",
  );
});

test("unmount aborts reads and removes native change and visibility subscriptions", async (t) => {
  const ctx = setup(t);
  await until(() => ctx.calls.length === 1, "Initial read");
  ctx.dispose();
  assert.equal(ctx.calls[0].options.signal.aborted, true);
  assert.equal(ctx.navigationListeners.size, 0);
  assert.equal(ctx.sessionListeners.size, 0);
  ctx.change();
  ctx.open(false);
  ctx.open(true);
  await delay(20);
  assert.equal(ctx.calls.length, 1);
});
