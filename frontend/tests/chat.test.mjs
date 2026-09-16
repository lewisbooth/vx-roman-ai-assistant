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
  options.beforeImport?.(window);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanChatTest = RomanChatTest;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const voiceDock = window.document.createElement("div");
  host.shadowRoot.append(voiceDock);
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
    voice: { status: "idle", muted: false, error: null },
    selectedVoice: "marin",
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
    loadProducts: async (ids, signal) => {
      productCalls.push([...ids]);
      return (
        (await options.onLoadProducts?.(ids, window, signal)) ?? {
          products: [],
          messages: [],
        }
      );
    },
    dispose() {},
    startVoice: async () => {
      update({ voice: { status: "active", muted: false, error: null } });
    },
    setVoice: (selectedVoice) => update({ selectedVoice }),
    stopVoice: async () => {
      await options.onStopVoice?.(window);
      update({ voice: { status: "idle", muted: false, error: null } });
    },
    setVoiceMuted: (muted) => {
      update({ voice: { ...state.voice, muted } });
    },
    resolveToolApproval: (id, confirmed) => options.onApproval?.(id, confirmed),
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
      getSnapshot: () => navigationState,
      subscribe: () => () => {},
      navigate: async (path) => {
        navigationCalls.push(path);
      },
    },
    tools: { execute: async () => ({}) },
    session,
    voiceDock,
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
    voiceDock,
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

test("saved guide cards open verified PDFs separately without fetching products, navigating or stopping voice", async t => {
  const fetches = [];
  const guides = [
    { kind: "measuring", url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=1" },
    { kind: "fitting", url: "https://hd-dev-single.myshopify.com/cdn/shop/files/fitting.pdf?v=2" },
  ];
  const ctx = await setup(t, {
    beforeImport: window => { window.fetch = (...args) => { fetches.push(args); throw new Error("Guide cards must not fetch PDF content"); }; },
    state: { voice: { status: "active", muted: false, error: null }, conversation: {
      id: "chat", status: "active", busy: false, tools: [], messages: [
        { ...message("guide-message", "assistant", ""), parts: [{ type: "guides", version: 1, invocationId: "11111111-1111-4111-8111-111111111111", productPath: "/products/example", guides }] },
      ],
    } },
  });
  const list = ctx.container.querySelector('[aria-label="Product guides"]');
  const links = [...list.querySelectorAll("a")];
  assert.equal(links.length, 2);
  assert.match(links[0].textContent, /Measuring guide/);
  assert.match(links[1].textContent, /Fitting guide/);
  for (const [index, link] of links.entries()) {
    assert.equal(link.href, guides[index].url);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    link.addEventListener("click", event => event.preventDefault(), { once: true });
    link.dispatchEvent(new ctx.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.productCalls, []);
  assert.deepEqual(fetches, []);
  assert.equal(ctx.container.querySelector(".roman-composer textarea").disabled, true);
  assert.match(ctx.voiceDock.textContent, /Voice is on.*Stop voice/);
});

test("malformed or foreign guide records never become active chat links", async t => {
  const ctx = await setup(t, { state: { conversation: {
    id: "chat", status: "active", busy: false, tools: [], messages: [
      { ...message("unsafe-guide", "assistant", ""), parts: [{ type: "guides", version: 1, invocationId: "11111111-1111-4111-8111-111111111111", productPath: "/products/example", guides: [{ kind: "measuring", url: "https://evil.example/measuring.pdf" }] }] },
    ],
  } } });
  assert.equal(ctx.container.querySelectorAll(".roman-guide-card").length, 0);
  assert.match(ctx.container.textContent, /product guides are unavailable/);
});

test("cart approval stays actionable during voice and is also available in the closed-sidebar dock", async t => {
  const choices = [];
  const approval = { invocationId: "cart-one", title: "Remove this item?", details: ["Kitchen blind", "Remove quantity 2."] };
  const ctx = await setup(t, { state: { approval, conversation: { id: "chat", status: "active", messages: [], busy: true, tools: [] }, voice: { status: "active", muted: false, error: null } }, onApproval: (...args) => choices.push(args) });
  const panel = ctx.container.querySelector(".roman-tool-approval");
  const dock = ctx.voiceDock.querySelector(".roman-tool-approval");
  assert.match(panel.textContent, /Kitchen blind.*quantity 2/);
  assert.ok(dock);
  assert.equal(panel.getAttribute("aria-labelledby"), panel.querySelector("h2").id);
  assert.notEqual(panel.querySelector("h2").id, dock.querySelector("h2").id);
  const approve = [...dock.querySelectorAll("button")].find(button => button.textContent === "Approve");
  assert.equal(approve.disabled, false);
  approve.click();
  assert.deepEqual(choices, [["cart-one", true]]);
  ctx.update({ approval: { ...approval, unavailable: "Review the new product." } });
  await until(() => ctx.container.querySelector(".roman-tool-approval button:last-child").disabled, "Unavailable action was still approvable");
  ctx.container.querySelector(".roman-tool-approval button").click();
  assert.deepEqual(choices.at(-1), ["cart-one", false]);
});

test("welcome uses original asset paths, unavailable tiles and one hidden developer tools panel", async (t) => {
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
  const drawer = container.querySelector(".roman-tools");
  assert.equal(drawer.hidden, true);
  assert.equal(container.querySelectorAll(".roman-tools-toggle").length, 1);
  assert.equal(
    container.querySelector(".roman-tools-toggle").getAttribute("aria-controls"),
    drawer.id,
  );
  assert.equal(container.querySelectorAll("details").length, 0);
  assert.ok(drawer.querySelector(".roman-voice-choice select"));
  assert.ok(drawer.querySelector("form"));
  assert.equal(container.querySelector('nav[aria-label="Browse store"]'), null);
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

test("restored carousels hydrate only near the viewport and cancel obsolete display reads", async (t) => {
  const observers = [];
  const signals = [];
  const messages = Array.from({ length: 20 }, (_, index) => {
    const row = productsMessage();
    row.id = `cards-${index}`;
    row.parts[1].invocationId = `catalog-${index}`;
    return row;
  });
  const ctx = await setup(t, {
    state: { conversation: activeConversation(messages) },
    beforeImport: (window) => {
      window.IntersectionObserver = class {
        constructor(callback, options) {
          this.callback = callback;
          this.options = options;
          observers.push(this);
        }
        observe(target) {
          this.target = target;
        }
        disconnect() {
          this.disconnected = true;
        }
      };
    },
    onLoadProducts: (_ids, _window, signal) => {
      signals.push(signal);
      if (signals.length === 1)
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      return catalog;
    },
  });
  await until(
    () => observers.length === 20,
    "Historical card observers were not mounted",
  );
  assert.equal(ctx.productCalls.length, 0);
  assert.equal(
    observers[19].options.root,
    ctx.container.querySelector(".roman-chat-scroll"),
  );
  observers[19].callback([{ isIntersecting: true }]);
  await until(
    () => signals.length === 1,
    "Visible products did not start loading",
  );
  observers[19].callback([{ isIntersecting: false }]);
  await until(() => signals[0].aborted, "Offscreen lookup was not cancelled");
  observers[19].callback([{ isIntersecting: true }]);
  await until(
    () => ctx.container.querySelector(".roman-product-card"),
    "Visible products did not resume loading",
  );
  assert.equal(ctx.productCalls.length, 2);
  assert.equal(ctx.container.querySelectorAll(".roman-product-card").length, 1);
  ctx.update({ conversation: null });
  await until(
    () => observers.every((observer) => observer.disconnected),
    "Card observers were not disposed",
  );
});

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
  ctx.update({
    conversation: activeConversation([
      productsMessage(),
      message("later", "assistant", "A later streamed response"),
    ]),
  });
  await until(
    () => ctx.container.textContent.includes("A later streamed response"),
    "The next snapshot did not render",
  );
  assert.equal(ctx.container.querySelector(".roman-product-card"), card);
  assert.equal(
    ctx.productCalls.length,
    1,
    "New part and ID-array identities must not remount loaded cards",
  );
  assert.doesNotMatch(ctx.container.textContent, /Loading products/);
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
      ctx.container.textContent.includes(
        "These products are no longer available",
      ),
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

test("journey entries use inline notification pills and unsafe URLs never become active links", async (t) => {
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
  assert.ok([...entries].every((entry) => entry.classList.contains("roman-inline-event")));
  assert.equal(entries[0].textContent, "Viewed Lottie <img src=x>");
  assert.equal(entries[0].querySelector("img"), null);
  assert.equal(entries[1].querySelector("a"), null);
  entries[0].querySelector("a").click();
  assert.deepEqual(ctx.navigationCalls, [
    "https://hd-dev-single.myshopify.com/products/lottie",
  ]);
});

test("saved cart additions render product and submitted dimensions with a working cart link", async (t) => {
  const products = [
    { productPath: "/products/lottie", title: "Lottie <img src=x>", measurements: { width: 900, height: 1200, unit: "mm" } },
    { productPath: "/products/lottie", title: "Lottie", measurements: { width: 35.5, height: 48.25, unit: "in" } },
    { productPath: "/products/sample", title: "Sample" },
  ];
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation(products.map((product, index) => ({
        ...message(`cart-${index}`, "context", ""),
        parts: [{ type: "cart_added", version: 1, invocationId: `cart-${index}`, product }],
      }))),
    },
  });
  const entries = ctx.container.querySelectorAll(".roman-cart-added");
  assert.equal(entries.length, 3);
  assert.ok([...entries].every((entry) => entry.classList.contains("roman-inline-event")));
  assert.equal(entries[0].textContent, "Roman added Lottie <img src=x> to your cart at 900 x 1200mm View Cart");
  assert.equal(entries[1].textContent, "Roman added Lottie to your cart at 35.5 x 48.25in View Cart");
  assert.equal(entries[2].textContent, "Roman added Sample to your cart View Cart");
  assert.equal(entries[0].querySelector("img"), null);
  entries[0].querySelector("a").click();
  assert.deepEqual(ctx.navigationCalls, ["https://hd-dev-single.myshopify.com/cart"]);
  assert.deepEqual(ctx.productCalls, []);
  assert.equal(ctx.container.querySelector(".roman-tool-approval"), null);
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
    () =>
      ctx.container.querySelector(".roman-welcome") && !ctx.input().disabled,
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

test("voice captions render as labelled plain text alongside the existing transcript", async (t) => {
  const caption = {
    ...message("voice-message", "assistant", ""),
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: "22222222-2222-4222-8222-222222222222",
        text: "**Hello** <img src=x onerror=alert(1)>",
        startMs: 0,
        endMs: 500,
      },
    ],
  };
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([
        message("text-message", "user", "My kitchen"),
        caption,
      ]),
    },
  });
  const rendered = ctx.container.querySelector(".roman-voice-caption");
  assert.equal(
    rendered.querySelector(".roman-voice-label").textContent,
    "Voice",
  );
  assert.equal(rendered.querySelector("p").textContent, caption.parts[0].text);
  assert.equal(rendered.querySelector("strong, img, script"), null);
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /My kitchen/,
  );
});

test("explicit voice controls mute, preserve chat, and expose a dock outside the panel", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([
        message("user-message", "user", "My kitchen"),
      ]),
    },
  });
  const button = (label, parent = ctx.container) =>
    [...parent.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
  assert.equal(ctx.input().disabled, false);
  button("Start voice").click();
  await until(
    () => !!button("Mute microphone"),
    "Voice controls did not become active",
  );
  assert.equal(ctx.input().disabled, true);
  assert.ok(button("Stop voice", ctx.voiceDock));
  assert.equal(ctx.container.contains(ctx.voiceDock), false);
  button("Mute microphone", ctx.voiceDock).click();
  await until(
    () => !!button("Unmute microphone"),
    "Mute did not synchronize with sidebar",
  );
  assert.equal(
    button("Unmute microphone").getAttribute("aria-pressed"),
    "true",
  );
  button("Stop voice", ctx.voiceDock).click();
  await until(() => !!button("Start voice"), "Stop did not return to text");
  assert.equal(ctx.input().disabled, false);
  assert.equal(ctx.voiceDock.childElementCount, 0);
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /My kitchen/,
  );
});

test("a restored server voice shows an explicit switch to text without activating the microphone", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: {
        ...activeConversation([]),
        voice: { id: "voice", clientId: "previous-owner", status: "active" },
      },
    },
  });
  assert.match(
    ctx.container.querySelector(".roman-voice-status").textContent,
    /Voice is active in another page/,
  );
  assert.ok(
    [...ctx.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Switch to text",
    ),
  );
  assert.equal(ctx.input().disabled, true);
  assert.equal(ctx.voiceDock.childElementCount, 0);
});

test("voice selector offers all Live voices, defaults to Marin and changes only a stopped connection", async (t) => {
  const ctx = await setup(t, { showTools: true });
  const selector = ctx.container.querySelector(".roman-voice-choice select");
  assert.ok(selector.closest(".roman-tools"));
  assert.equal(ctx.container.querySelectorAll(".roman-tools-toggle").length, 1);
  assert.equal(ctx.container.querySelectorAll("details").length, 0);
  assert.equal(
    ctx.container.querySelector(".roman-voice-controls select"),
    null,
  );
  assert.equal(selector.value, "marin");
  assert.equal(selector.options.length, 22);
  assert.ok([...selector.options].some((option) => option.value === "gleam"));
  assert.equal(
    ctx.container.querySelector(`label[for="${selector.id}"]`).textContent,
    "Voice",
  );
  selector.value = "gleam";
  selector.dispatchEvent(new ctx.window.Event("change", { bubbles: true }));
  await until(
    () => selector.value === "gleam",
    "Voice selection did not update",
  );
  const button = (text) =>
    [...ctx.container.querySelectorAll("button")].find(
      (node) => node.textContent === text,
    );
  button("Start voice").click();
  await until(() => selector.disabled, "Active voice selector stayed enabled");
  assert.match(
    ctx.container.querySelector(".roman-voice-choice-hint").textContent,
    /Switch to text/,
  );
  assert.equal(ctx.voiceDock.querySelectorAll("select").length, 0);
  button("Switch to text").click();
  await until(
    () => !selector.disabled,
    "Stopped voice selector stayed disabled",
  );
  assert.equal(selector.value, "gleam");
});

test("starting, stopping and restored remote voice disable changing the voice", async (t) => {
  for (const state of [
    { voice: { status: "starting", muted: false, error: null } },
    { voice: { status: "stopping", muted: true, error: null } },
    {
      conversation: {
        id: "restored",
        messages: [],
        voice: { id: "voice", clientId: "old", status: "active" },
      },
    },
  ]) {
    const ctx = await setup(t, { state, showTools: true });
    assert.equal(
      ctx.container.querySelector(".roman-voice-choice select").disabled,
      true,
    );
    assert.match(
      ctx.container.querySelector(".roman-voice-choice-hint").textContent,
      /Switch to text/,
    );
  }
});

test("voice selection stays out of the customer controls when developer tools are hidden", async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.container.querySelector(".roman-voice-choice"), null);
  assert.ok(
    [...ctx.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Start voice",
    ),
  );
});

function questionMessage(id = "question-one", question = "What matters most?") {
  return {
    ...message(id, "assistant", ""),
    parts: [
      {
        type: "question",
        version: 1,
        invocationId: id,
        question,
        answers: ["Full blackout", "Daytime privacy"],
      },
    ],
  };
}

test("easy answers render once beneath all cards with a labelled literal question", async (t) => {
  const row = questionMessage("question-one", "What matters most? <img src=x>");
  row.parts.push(
    { type: "text", text: "Here are a few useful options." },
    productsMessage().parts[1],
    {
      type: "guides",
      version: 1,
      invocationId: "33333333-3333-4333-8333-333333333333",
      productPath: "/products/example",
      guides: [
        {
          kind: "measuring",
          url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=1",
        },
      ],
    },
  );
  const ctx = await setup(t, {
    state: { conversation: activeConversation([row]) },
  });
  const parts = ctx.container.querySelector(".roman-message-parts");
  const widget = ctx.container.querySelector(".roman-question");
  assert.ok(widget, "Question widget must be visible");
  assert.ok(
    ctx.container
      .querySelector(".roman-timeline")
      .lastElementChild.contains(widget),
    "Question must follow all cards",
  );
  assert.ok(parts.querySelector(".roman-guides"));
  assert.equal(widget.querySelector("p").textContent, row.parts[0].question);
  assert.equal(
    widget.getAttribute("aria-labelledby"),
    widget.querySelector("p").id,
  );
  assert.deepEqual(
    [...widget.querySelectorAll("button")].map((button) => button.textContent),
    row.parts[0].answers,
  );
  assert.equal(widget.querySelector("img, a"), null);
  assert.match(widget.textContent, /Or reply in your own words/);
});

test("clicking an easy answer submits ordinary customer text once and retires choices after acceptance", async (t) => {
  const row = questionMessage();
  let release;
  const accepted = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await setup(t, {
    state: { conversation: activeConversation([row]) },
    onSend: () => accepted,
  });
  const button = ctx.container.querySelector(".roman-question button");
  button.click();
  button.click();
  await until(
    () => button.disabled,
    "Question was not locked during submission",
  );
  assert.deepEqual(ctx.calls, ["Full blackout"]);
  assert.equal(
    ctx.container.querySelector(".roman-question").getAttribute("aria-busy"),
    "true",
  );
  ctx.update({
    conversation: activeConversation([
      row,
      message("reply", "user", "Full blackout"),
    ]),
  });
  release();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Accepted answer retained choices",
  );
  const first = ctx.container.querySelector(".roman-message-parts");
  assert.equal(first.textContent, row.parts[0].question);
  assert.equal(first.querySelectorAll("button").length, 0);
  assert.ok(
    ctx.container.getRootNode().activeElement === first.querySelector("p"),
    "Focus should stay on the retired question",
  );
  assert.match(
    ctx.container.querySelector(".roman-message-user").textContent,
    /Full blackout/,
  );
});

test("journey activity leaves choices available but text and voice customer replies retire them", async (t) => {
  for (const spoken of [false, true]) {
    const row = questionMessage();
    const journey = {
      ...message("visit", "context", ""),
      parts: [
        {
          type: "page_view",
          version: 1,
          path: "/products/example",
          title: "Example",
          occurredAt: row.createdAt,
        },
      ],
    };
    const ctx = await setup(t, {
      state: { conversation: activeConversation([row, journey]) },
    });
    assert.ok(ctx.container.querySelector(".roman-question button"));
    assert.ok(
      ctx.container
        .querySelector(".roman-timeline")
        .lastElementChild.querySelector(".roman-question"),
      "The active question must remain beneath journey activity",
    );
    const reply = message("reply", "user", "I prefer privacy");
    if (spoken)
      reply.parts = [
        {
          type: "voice",
          version: 1,
          voiceId: "22222222-2222-4222-8222-222222222222",
          text: "I prefer privacy",
          startMs: 10,
          endMs: 20,
        },
      ];
    ctx.update({ conversation: activeConversation([row, journey, reply]) });
    await until(
      () => !ctx.container.querySelector(".roman-question"),
      "Customer reply retained choices",
    );
    assert.equal(
      ctx.container.querySelector(".roman-message-parts").textContent,
      row.parts[0].question,
    );
    assert.deepEqual(ctx.calls, []);
  }
});

test("typing a free-text answer uses the normal composer and retires choices only when accepted", async (t) => {
  const row = questionMessage();
  let ctx;
  ctx = await setup(t, {
    state: { conversation: activeConversation([row]) },
    onSend: (text) =>
      ctx.update({
        conversation: activeConversation([row, message("reply", "user", text)]),
      }),
  });
  await ctx.type("A little of both, please");
  assert.ok(ctx.container.querySelector(".roman-question"));
  ctx.container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Typed answer retained choices",
  );
  assert.deepEqual(ctx.calls, ["A little of both, please"]);
  assert.equal(
    ctx.container.querySelector(".roman-message-parts").textContent,
    row.parts[0].question,
  );
});

test("only the newest question has choices and ended sessions retain plain questions", async (t) => {
  const first = questionMessage();
  const next = questionMessage("question-two", "Which room is this for?");
  const ctx = await setup(t, {
    state: { conversation: activeConversation([first, next]) },
  });
  assert.equal(ctx.container.querySelectorAll(".roman-question").length, 1);
  assert.match(
    ctx.container.querySelector(".roman-question").textContent,
    /Which room is this for/,
  );
  assert.equal(
    ctx.container.querySelector(".roman-message-parts").textContent,
    first.parts[0].question,
  );
  ctx.update({
    conversation: { ...activeConversation([first, next]), status: "ended" },
  });
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Ended session retained clickable choices",
  );
  assert.ok(ctx.container.textContent.includes(first.parts[0].question));
  assert.ok(ctx.container.textContent.includes(next.parts[0].question));
});

test("a failed easy answer stays retryable without automatically resending", async (t) => {
  const row = questionMessage();
  let attempts = 0;
  let ctx;
  ctx = await setup(t, {
    state: { conversation: activeConversation([row]) },
    onSend: (text, window) => {
      if (++attempts === 1)
        throw new window.Error("Connection lost. Please retry.");
      ctx.update({
        conversation: activeConversation([row, message("reply", "user", text)]),
      });
    },
  });
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => ctx.container.querySelector('.roman-question [role="alert"]'),
    "Question failure was not displayed",
  );
  assert.match(
    ctx.container.querySelector('.roman-question [role="alert"]').textContent,
    /Connection lost/,
  );
  assert.deepEqual(ctx.calls, ["Full blackout"]);
  assert.equal(
    ctx.container.querySelector(".roman-question button").disabled,
    false,
  );
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Retried answer was not accepted",
  );
  assert.deepEqual(ctx.calls, ["Full blackout", "Full blackout"]);
});

test("a voice answer button waits for voice shutdown before submitting text", async (t) => {
  const row = questionMessage();
  let stop;
  let stopCalls = 0;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  let ctx;
  ctx = await setup(t, {
    state: {
      conversation: activeConversation([row]),
      voice: { status: "active", muted: false, error: null },
    },
    onStopVoice: () => {
      stopCalls++;
      return stopped;
    },
    onSend: (text) =>
      ctx.update({
        conversation: activeConversation([row, message("reply", "user", text)]),
      }),
  });
  assert.match(
    ctx.container.querySelector(".roman-question-hint").textContent,
    /switch to text/,
  );
  const button = ctx.container.querySelector(".roman-question button");
  button.click();
  button.click();
  await until(() => stopCalls === 1, "Answer did not stop voice");
  assert.deepEqual(ctx.calls, []);
  stop();
  await until(
    () => ctx.calls.length === 1,
    "Stopped voice did not submit the answer",
  );
  assert.deepEqual(ctx.calls, ["Full blackout"]);
  assert.equal(stopCalls, 1);
});

test("voice shutdown rechecks that the question is current and does not submit a stale answer", async (t) => {
  const row = questionMessage();
  let stop;
  let stopCalls = 0;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([row]),
      voice: { status: "active", muted: false, error: null },
    },
    onStopVoice: () => {
      stopCalls++;
      return stopped;
    },
  });
  ctx.container.querySelector(".roman-question button").click();
  await until(() => stopCalls === 1, "Answer did not stop voice");
  const replacement = questionMessage(
    "question-two",
    "Which room is this for?",
  );
  ctx.update({ conversation: activeConversation([row, replacement]) });
  stop();
  await until(
    () =>
      ctx.container.querySelector(".roman-question button")?.disabled === false,
    "Voice stop did not release the new question",
  );
  assert.deepEqual(ctx.calls, []);
  assert.match(
    ctx.container.querySelector(".roman-question").textContent,
    /Which room is this for/,
  );
});

test("failed voice shutdown preserves easy answers and never submits competing text", async (t) => {
  const row = questionMessage();
  const ctx = await setup(t, {
    state: {
      conversation: activeConversation([row]),
      voice: { status: "active", muted: false, error: null },
    },
    onStopVoice: (window) => {
      throw new window.Error("Voice is still ending. Retry.");
    },
  });
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => ctx.container.querySelector('.roman-question [role="alert"]'),
    "Failed voice shutdown was not reported",
  );
  assert.deepEqual(ctx.calls, []);
  assert.equal(
    ctx.container.querySelector(".roman-question button").disabled,
    false,
  );
  assert.match(
    ctx.container.querySelector('.roman-question [role="alert"]').textContent,
    /Voice is still ending/,
  );
});
