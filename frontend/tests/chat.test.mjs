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
      import { RouterProvider } from 'react-router/dom';
      import { createAssistantRouter } from './frontend/src/app';
      export function mount(container, props) {
        const router = createAssistantRouter(props);
        const root = createRoot(container);
        root.render(<RouterProvider router={router} />);
        return () => { root.unmount(); router.dispose(); };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanChatTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function message(id, role, text, status = "complete") {
  return {
    id,
    role,
    parts: text ? [{ type: "text", text }] : [],
    status,
    createdAt: "2026-09-15T10:00:00.000Z",
  };
}

async function setup(t, options = {}) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://hd-dev-single.myshopify.com/products/example",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanChatTest = RomanChatTest;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const listeners = new Set();
  const calls = [];
  const endCalls = [];
  const productCalls = [];
  const navigationCalls = [];
  let state = {
    conversation: null,
    pending: false,
    restoring: false,
    error: null,
    ...options.state,
  };
  const update = (changes) => {
    state = { ...state, ...changes };
    for (const listener of listeners) listener();
  };
  const session = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearError: () => {
      if (state.error) update({ error: null });
    },
    sendMessage: async (text) => {
      calls.push(text);
      await options.onSend?.(text, window);
    },
    end: async () => {
      endCalls.push("end");
      await options.onEnd?.(window);
      update({ conversation: null, error: null });
    },
    loadProducts: async (ids) => {
      productCalls.push([...ids]);
      return (
        (await options.onLoadProducts?.(ids, window)) ?? {
          products: [],
          messages: [],
        }
      );
    },
    dispose() {},
  };
  const navigationState = {
    url: window.location.href,
    pending: false,
    error: null,
  };
  let ready = false;
  const dispose = window.RomanChatTest.mount(container, {
    logoUrl:
      "https://cdn.shopify.com/extensions/version/assets/roman-logo.svg?v=1",
    navigation: {
      destinations: [{ label: "Home", path: "/" }],
      getSnapshot: () => navigationState,
      subscribe: () => () => {},
      navigate: async (path) => {
        navigationCalls.push(path);
      },
    },
    tools: { execute: async () => ({}) },
    session,
    showTools: options.showTools ?? false,
    onReady: () => {
      ready = true;
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => {
    dispose();
    window.close();
  });
  await until(() => ready || errors.length, "Chat did not mount");
  assert.deepEqual(errors, []);
  const input = () => container.querySelector(".roman-composer textarea");
  async function type(text) {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input(), text);
    input().dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(
      () =>
        !container.querySelector('.roman-composer button[type="submit"]')
          .disabled,
      "Composer did not accept typed text",
    );
  }
  return {
    window,
    container,
    calls,
    update,
    input,
    type,
    errors,
    endCalls,
    productCalls,
    navigationCalls,
  };
}

test("welcome uses original asset paths, unavailable tiles and a collapsed development section", async (t) => {
  const { container } = await setup(t, { showTools: true });
  const tiles = [...container.querySelectorAll(".roman-welcome-tile")];
  assert.equal(tiles.length, 4);
  assert.ok(
    tiles.every((tile) => tile.disabled && /coming soon/.test(tile.ariaLabel)),
  );
  assert.deepEqual(
    tiles.map((tile) => tile.querySelector(".roman-tile-title").textContent),
    [
      "Measure windows",
      "Visualize in room",
      "Find your style",
      "Explore No-Drill",
    ],
  );
  for (const image of container.querySelectorAll(".roman-tile-art img"))
    assert.match(
      image.src,
      /^https:\/\/cdn\.shopify\.com\/extensions\/version\/assets\/roman-tile-.+\.png$/,
    );
  const development = container.querySelector(".roman-development");
  assert.equal(development.open, false);
  assert.ok(development.querySelector('nav[aria-label="Browse store"]'));
});

test("accepted submissions clear the draft and same-tick repeats cannot send twice", async (t) => {
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const { window, container, calls, input, type } = await setup(t, {
    onSend: () => accepted,
  });
  await type("  I need a roman blind  ");
  const form = container.querySelector(".roman-composer form");
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await until(
    () => input().disabled,
    "Local pending state did not lock the composer",
  );
  assert.deepEqual(calls, ["I need a roman blind"]);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(input().value, "  I need a roman blind  ");
  accept();
  await until(
    () => !input().disabled,
    "Accepted send did not release the composer",
  );
  assert.equal(input().value, "");
});

test("failed submissions preserve the draft and display an actionable error", async (t) => {
  const { container, calls, input, type } = await setup(t, {
    onSend: (_text, window) => {
      throw new window.Error("Connection lost. Please retry.");
    },
  });
  await type("Keep these measurements");
  container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => container.querySelector('[role="alert"]'),
    "Send failure was not displayed",
  );
  assert.equal(input().value, "Keep these measurements");
  assert.equal(input().disabled, false);
  assert.deepEqual(calls, ["Keep these measurements"]);
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /Connection lost/,
  );
});

test("Enter sends, while Shift+Enter and composition Enter do not submit", async (t) => {
  const { window, calls, input, type } = await setup(t);
  await type("Show me some options");
  for (const settings of [{ shiftKey: true }, { isComposing: true }]) {
    const event = new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...settings,
    });
    input().dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
  const enter = new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  input().dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  await until(() => calls.length === 1, "Enter did not submit");
  assert.deepEqual(calls, ["Show me some options"]);
});

test("retrying a connection clears the duplicated local send error without resending", async (t) => {
  let ctx;
  ctx = await setup(t, {
    onSend: (_text, window) => {
      ctx.update({ error: "Connection lost. Please retry." });
      throw new window.Error("Connection lost. Please retry.");
    },
  });
  await ctx.type("Keep this draft");
  ctx.container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => ctx.container.querySelector(".roman-chat-retry"),
    "Connection retry was not offered",
  );
  ctx.container.querySelector(".roman-chat-retry").click();
  await until(
    () => !ctx.container.querySelector('[role="alert"]'),
    "Recovered connection retained a stale send error",
  );
  assert.deepEqual(ctx.calls, ["Keep this draft"]);
  assert.equal(ctx.input().value, "Keep this draft");
});

test("restoration and backend work disable the composer without inventing a new session", async (t) => {
  const { container, update, input, calls } = await setup(t, {
    state: { restoring: true },
  });
  assert.equal(input().disabled, true);
  assert.equal(container.querySelector(".roman-welcome"), null);
  assert.match(container.textContent, /Restoring your conversation/);
  update({
    restoring: false,
    conversation: {
      id: "existing",
      busy: true,
      messages: [
        message("question", "user", "Which blind fits?"),
        message("reply", "assistant", "", "pending"),
      ],
    },
  });
  await until(
    () => container.querySelector('[role="log"]'),
    "Restored history was not displayed",
  );
  assert.equal(input().disabled, true);
  assert.match(container.textContent, /Roman is thinking/);
  assert.deepEqual(calls, []);
});

test("transcript renders untrusted text as text and displays failed replies", async (t) => {
  const unsafe = '<img src=x onerror="window.compromised=true">';
  const failure = {
    ...message("failure", "assistant", "", "failed"),
    error: "Roman is unavailable. Try again.",
  };
  const { window, container } = await setup(t, {
    state: {
      conversation: {
        id: "existing",
        busy: false,
        messages: [
          message("question", "user", unsafe),
          message("reply", "assistant", "First line\nSecond line"),
          failure,
        ],
      },
    },
  });
  const log = container.querySelector('[role="log"]');
  assert.ok(log.textContent.includes(unsafe));
  assert.equal(log.querySelector("img"), null);
  assert.equal(window.compromised, undefined);
  assert.match(log.textContent, /Roman is unavailable/);
});

test("new messages preserve a reader's scroll position and resume following at the bottom", async (t) => {
  let messages = [message("first", "assistant", "Initial reply")];
  const { window, container, update } = await setup(t, {
    state: {
      conversation: { id: "existing", busy: false, messages },
    },
  });
  const viewport = container.querySelector(".roman-chat-scroll");
  let height = 1000;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
  });
  function append(id) {
    messages = [...messages, message(id, "assistant", id)];
    update({ conversation: { id: "existing", busy: false, messages } });
  }
  append("Second reply");
  await until(
    () => viewport.scrollTop === 1000,
    "Initial new content did not follow the conversation",
  );
  viewport.scrollTop = 100;
  viewport.dispatchEvent(new window.Event("scroll"));
  height = 1300;
  append("Third reply");
  await until(
    () => container.textContent.includes("Third reply"),
    "Third reply did not render",
  );
  assert.equal(viewport.scrollTop, 100);
  viewport.scrollTop = 1100;
  viewport.dispatchEvent(new window.Event("scroll"));
  height = 1500;
  append("Fourth reply");
  await until(
    () => viewport.scrollTop === 1500,
    "Following did not resume at the bottom",
  );
});

function activeConversation(messages) {
  return {
    id: "existing",
    status: "active",
    revision: 1,
    tools: [],
    busy: false,
    messages,
  };
}

function productsMessage() {
  return {
    ...message("products", "assistant", "Some options for your room"),
    parts: [
      { type: "text", text: "Some options for your room" },
      {
        type: "products",
        version: 1,
        invocationId: "catalog-one",
        productIds: ["gid://shopify/Product/123"],
      },
    ],
  };
}

const catalog = {
  products: [
    {
      id: "gid://shopify/Product/123",
      title: "Lottie Roman blind",
      description: "Public product description",
      url: "https://hd-dev-single.myshopify.com/products/lottie",
      imageUrl: "https://cdn.shopify.com/lottie.jpg",
      priceLabel: "From £30.00",
    },
  ],
  messages: [],
};

test("product references load live cards once across snapshot refreshes and use storefront navigation", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const ctx = await setup(t, {
    state: { conversation: activeConversation([productsMessage()]) },
    onLoadProducts: () => pending,
  });
  await until(
    () => ctx.productCalls.length === 1,
    "Product references were not hydrated",
  );
  assert.match(ctx.container.textContent, /Loading products/);
  ctx.update({ conversation: activeConversation([productsMessage()]) });
  await delay(0);
  assert.equal(
    ctx.productCalls.length,
    1,
    "Unchanged product IDs must not refetch on every poll",
  );
  resolve(catalog);
  await until(
    () => ctx.container.querySelector(".roman-product-card"),
    "Product card did not render",
  );
  const card = ctx.container.querySelector(".roman-product-card");
  assert.equal(card.href, catalog.products[0].url);
  assert.equal(card.querySelector("img").src, catalog.products[0].imageUrl);
  assert.equal(card.querySelector("img").getAttribute("loading"), "lazy");
  assert.match(card.textContent, /Lottie Roman blind/);
  assert.match(card.textContent, /From £30.00/);
  assert.match(
    ctx.container.textContent,
    /Final price depends on options and measurements/,
  );
  const click = new ctx.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  card.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(ctx.navigationCalls, [catalog.products[0].url]);
  const modified = new ctx.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  card.dispatchEvent(modified);
  assert.equal(modified.defaultPrevented, false);
  assert.equal(ctx.navigationCalls.length, 1);
});

test("product cards show only the selected IDs in their recommendation order", async (t) => {
  const selected = productsMessage();
  selected.parts[1].productIds = [
    "gid://shopify/Product/456",
    "gid://shopify/Product/123",
    "gid://shopify/Product/789",
  ];
  const second = {
    ...catalog.products[0],
    id: "gid://shopify/Product/456",
    title: "Selected blackout blind",
    url: "https://hd-dev-single.myshopify.com/products/selected-blackout",
  };
  const unrelated = {
    ...catalog.products[0],
    id: "gid://shopify/Product/999",
    title: "An unrelated catalog match",
    url: "https://hd-dev-single.myshopify.com/products/unrelated",
  };
  const ctx = await setup(t, {
    state: { conversation: activeConversation([selected]) },
    onLoadProducts: () => ({
      products: [unrelated, catalog.products[0], second],
      messages: [{ type: "info", text: "One selected item is unavailable." }],
    }),
  });
  await until(
    () => ctx.container.querySelector(".roman-product-card"),
    "Selected product cards did not render",
  );
  assert.deepEqual(ctx.productCalls, [selected.parts[1].productIds]);
  assert.deepEqual(
    [...ctx.container.querySelectorAll(".roman-product-card")].map(
      (card) => card.href,
    ),
    [second.url, catalog.products[0].url],
  );
  assert.doesNotMatch(ctx.container.textContent, /An unrelated catalog match/);
  assert.match(ctx.container.textContent, /One selected item is unavailable/);
});

test("unrelated lookup matches cannot replace an unavailable selected product", async (t) => {
  const ctx = await setup(t, {
    state: { conversation: activeConversation([productsMessage()]) },
    onLoadProducts: () => ({
      products: [{ ...catalog.products[0], id: "gid://shopify/Product/999" }],
      messages: [],
    }),
  });
  await until(
    () =>
      ctx.container.textContent.includes("These products are no longer available"),
    "The unavailable selected product was replaced with an unrelated match",
  );
  assert.equal(ctx.container.querySelector(".roman-product-card"), null);
  assert.doesNotMatch(ctx.container.textContent, /Final price depends/);
});

test("product errors have an explicit retry, and missing products remain honest", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    state: { conversation: activeConversation([productsMessage()]) },
    onLoadProducts: (_ids, window) => {
      if (++attempts === 1)
        throw new window.Error("Shopify is unavailable. Please retry.");
      return {
        products: [],
        messages: [{ type: "info", text: "This item is no longer sold." }],
      };
    },
  });
  await until(
    () => ctx.container.querySelector(".roman-products-status button"),
    "Product retry was not offered",
  );
  assert.match(ctx.container.textContent, /Shopify is unavailable/);
  assert.equal(ctx.container.querySelector(".roman-product-card"), null);
  ctx.container.querySelector(".roman-products-status button").click();
  await until(
    () =>
      ctx.container.textContent.includes(
        "These products are no longer available",
      ),
    "Empty lookup did not display the unavailable state",
  );
  assert.match(ctx.container.textContent, /This item is no longer sold/);
  assert.equal(attempts, 2);
  assert.equal(ctx.container.querySelector(".roman-product-card"), null);
});

test("journey entries are quiet linked text and unsafe URLs never become active links", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([
        {
          ...message("page", "context", ""),
          parts: [
            {
              type: "page_view",
              version: 1,
              title: "Lottie <img src=x>",
              path: "/products/lottie",
              occurredAt: "2026-09-15T10:00:00.000Z",
            },
          ],
        },
        {
          ...message("unsafe", "context", ""),
          parts: [
            {
              type: "page_view",
              version: 1,
              title: "Unsafe link",
              path: "javascript:alert(1)",
              occurredAt: "2026-09-15T10:00:01.000Z",
            },
          ],
        },
      ]),
    },
  });
  const entries = ctx.container.querySelectorAll(".roman-page-view");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].textContent, "Viewed Lottie <img src=x>");
  assert.equal(entries[0].querySelector("img"), null);
  assert.equal(entries[1].querySelector("a"), null);
  entries[0].querySelector("a").click();
  assert.deepEqual(ctx.navigationCalls, [
    "https://hd-dev-single.myshopify.com/products/lottie",
  ]);
});

test("ending a chat retains its transcript and draft until acknowledged, then starts clean", async (t) => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([
        message("reply", "assistant", "Your saved conversation"),
      ]),
    },
    onEnd: () => pending,
  });
  await ctx.type("Unsent draft");
  const end = ctx.container.querySelector(".roman-end-chat");
  end.click();
  end.click();
  await until(() => ctx.input().disabled, "Ending did not lock the composer");
  assert.deepEqual(ctx.endCalls, ["end"]);
  assert.match(ctx.container.textContent, /Your saved conversation/);
  assert.equal(ctx.input().value, "Unsent draft");
  finish();
  // The external-store update can render Welcome before endChat's promise
  // continuation resets the composer and releases its local pending state.
  await until(
    () => ctx.container.querySelector(".roman-welcome") && !ctx.input().disabled,
    "End did not return to a ready empty chat",
  );
  assert.equal(ctx.input().value, "");
  assert.equal(ctx.input().disabled, false);
  assert.equal(ctx.container.querySelector(".roman-end-chat"), null);
  await ctx.type("A new conversation");
  ctx.container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => ctx.calls.length === 1,
    "The empty screen could not start a new chat",
  );
  assert.deepEqual(ctx.calls, ["A new conversation"]);
});

test("an unsuccessful End keeps the conversation and draft available", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([
        message("reply", "assistant", "Keep this conversation"),
      ]),
    },
    onEnd: (window) => {
      throw new window.Error("Could not end the chat. Please retry.");
    },
  });
  await ctx.type("Keep this draft");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "End failure was hidden",
  );
  assert.match(ctx.container.textContent, /Could not end the chat/);
  assert.match(ctx.container.textContent, /Keep this conversation/);
  assert.equal(ctx.input().value, "Keep this draft");
  assert.equal(ctx.input().disabled, false);
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
});

test("late product loading follows the transcript only while the reader stays at its end", async (t) => {
  for (const following of [false, true]) {
    await t.test(
      following ? "following" : "reading earlier messages",
      async (t) => {
        let resolve;
        const pending = new Promise((done) => {
          resolve = done;
        });
        const ctx = await setup(t, {
          state: { conversation: activeConversation([productsMessage()]) },
          onLoadProducts: () => pending,
        });
        const viewport = ctx.container.querySelector(".roman-chat-scroll");
        Object.defineProperties(viewport, {
          scrollHeight: { value: 1300 },
          clientHeight: { value: 200 },
        });
        if (!following) {
          viewport.scrollTop = 100;
          viewport.dispatchEvent(new ctx.window.Event("scroll"));
        }
        resolve(catalog);
        await until(
          () => ctx.container.querySelector(".roman-product-card"),
          "Products did not arrive",
        );
        assert.equal(viewport.scrollTop, following ? 1300 : 100);
      },
    );
  }
});

test("a late card lookup cannot repopulate a cleared conversation", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const ctx = await setup(t, {
    state: { conversation: activeConversation([productsMessage()]) },
    onLoadProducts: () => pending,
  });
  await until(() => ctx.productCalls.length === 1, "Lookup did not start");
  ctx.update({ conversation: null });
  await until(
    () => ctx.container.querySelector(".roman-welcome"),
    "The conversation did not clear",
  );
  resolve(catalog);
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-product-card"), null);
  assert.deepEqual(ctx.errors, []);
});
