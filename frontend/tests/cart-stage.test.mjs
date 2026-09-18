import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { useSyncExternalStore } from 'react';
      import { CartStage } from './frontend/src/chat/CartStage';
      function Cart({navigation, session}) {
        const page = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
        return <CartStage navigation={navigation} session={session} visible={page.cartVisible} />;
      }
      export function mount(container, navigation, session) {
        const root = createRoot(container);
        flushSync(() => root.render(<Cart navigation={navigation} session={session} />));
        return () => flushSync(() => root.unmount());
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "CartStageTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const exampleCart = {
  currency: "GBP",
  item_count: 1,
  total_price: 4500,
  token: "private cart token",
  note: "Private note",
  items: [
    {
      key: "line-1",
      title: "Linen blind",
      quantity: 1,
      variant_id: 12345,
      final_line_price: 4500,
    },
  ],
};

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function setup(t, view = "chat") {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://shop.example/products/linen",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom,
    errors = [],
    calls = [];
  window.console.error = (...args) => errors.push(args);
  window.fetch = (url, options) =>
    new Promise((resolve, reject) =>
      calls.push({
        url: String(url),
        options,
        resolve,
        reject,
        complete(cart = exampleCart) {
          resolve({
            ok: true,
            status: 200,
            json: async () => cart,
            headers: new Map(),
          });
        },
      }),
    );
  const navigationListeners = new Set(),
    sessionListeners = new Set();
  let page = {
    url: window.location.href,
    pending: false,
    error: null,
    cartVisible: view === "cart",
  };
  let state = { conversation: { messages: [], tools: [] } };
  const navigation = {
    getSnapshot: () => page,
    subscribe: (fn) => {
      navigationListeners.add(fn);
      return () => navigationListeners.delete(fn);
    },
  };
  const session = {
    getSnapshot: () => state,
    subscribe: (fn) => {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
  };
  window.eval(
    `${bundle.outputFiles[0].text};window.CartStageTest=CartStageTest;`,
  );
  const container = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const unmount = window.CartStageTest.mount(container, navigation, session);
  let disposed = false;
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
  });
  return {
    window,
    container,
    calls,
    dispose,
    navigationListeners,
    sessionListeners,
    show(view) {
      page = { ...page, cartVisible: view === "cart" };
      navigationListeners.forEach((fn) => fn());
    },
    update(conversation) {
      state = {
        ...state,
        conversation: { ...state.conversation, ...conversation },
      };
      sessionListeners.forEach((fn) => fn());
    },
  };
}

test("cart appears and reads only on the requested Roman cart view, never on product additions", async (t) => {
  const ctx = setup(t);
  ctx.update({
    messages: [
      { id: "added", parts: [{ type: "cart_addition", title: "Linen blind" }] },
    ],
  });
  await delay(20);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.container.textContent, "");
  ctx.show("cart");
  await until(() => ctx.calls.length === 1, "Requested cart should read once");
  assert.equal(ctx.calls[0].url, "https://shop.example/cart.js");
  assert.equal(ctx.calls[0].options.credentials, "same-origin");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Validated cart should render",
  );
  assert.match(ctx.container.textContent, /45\.00/);
  assert.doesNotMatch(ctx.container.textContent, /private|Private/);
  assert.equal(
    ctx.container
      .querySelector("a")
      .getAttribute("data-roman-native-navigation"),
    "true",
  );
});

test("streaming prose does not repeatedly reload an unchanged cart", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Initial cart rendered",
  );
  for (const text of ["Hello", "Hello again", "Hello again, how can I help?"]) {
    ctx.update({
      messages: [
        { id: "reply", status: "pending", parts: [{ type: "text", text }] },
      ],
    });
    await delay(10);
  }
  assert.equal(
    ctx.calls.length,
    1,
    "Only actual cart activity should trigger another display read",
  );
});

test("native cart changes and completed cart tools refresh the display without racing a mutation", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial cart read");
  ctx.calls[0].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Initial cart rendered",
  );
  ctx.update({
    tools: [
      { id: "clear-1", name: "clear_cart", status: "running", arguments: {} },
    ],
  });
  await until(
    () => ctx.container.querySelector('[aria-busy="true"]'),
    "Running mutation marks display stale",
  );
  assert.equal(ctx.calls.length, 1);
  ctx.window.document.body.dispatchEvent(
    new ctx.window.CustomEvent("cart:updated"),
  );
  await delay(10);
  assert.equal(
    ctx.calls.length,
    1,
    "Native event cannot race the in-flight tool",
  );
  ctx.update({ tools: [] });
  await until(() => ctx.calls.length === 2, "Finished mutation refreshes cart");
  ctx.calls[1].complete({
    ...exampleCart,
    item_count: 0,
    total_price: 0,
    items: [],
  });
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Updated cart rendered",
  );
  ctx.window.document.body.dispatchEvent(
    new ctx.window.CustomEvent("cart:updated"),
  );
  await until(
    () => ctx.calls.length === 3,
    "Native changes also refresh without a model tool",
  );
  ctx.calls[2].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Native cart result rendered",
  );
});

test("leaving cart cancels its read and a late response cannot overwrite a future cart", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.show("chat");
  await until(
    () => ctx.calls[0].options.signal.aborted,
    "Obsolete read aborted",
  );
  ctx.calls[0].complete();
  await delay(10);
  assert.equal(ctx.container.textContent, "");
  ctx.show("cart");
  await until(
    () => ctx.calls.length === 2,
    "Returning starts a fresh cart read",
  );
  ctx.calls[1].complete({
    ...exampleCart,
    item_count: 0,
    total_price: 0,
    items: [],
  });
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Fresh empty cart rendered",
  );
  assert.equal(ctx.container.querySelector(".roman-checkout"), null);
});

test("malformed currency becomes a retryable cart error, not a conversation render crash", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.calls[0].complete({ ...exampleCart, currency: "not-a-currency" });
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "Invalid cart is rejected before rendering",
  );
  ctx.container.querySelector("button").click();
  await until(() => ctx.calls.length === 2, "Retry starts a fresh read");
  ctx.calls[1].complete();
  await until(
    () => ctx.container.textContent.includes("Linen blind"),
    "Retry renders verified cart",
  );
});

test("unmount cancels pending cart work and removes store subscriptions", async (t) => {
  const ctx = setup(t, "cart");
  await until(() => ctx.calls.length === 1, "Initial request started");
  ctx.dispose();
  assert.equal(ctx.calls[0].options.signal.aborted, true);
  assert.equal(ctx.navigationListeners.size, 0);
  assert.equal(ctx.sessionListeners.size, 0);
  ctx.calls[0].complete();
  await delay(10);
  assert.equal(ctx.container.textContent, "");
});
