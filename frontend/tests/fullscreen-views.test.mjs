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
  globalName: "ViewsTest",
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

function conversation(messages = []) {
  return {
    id: "conversation",
    status: "active",
    revision: 1,
    busy: false,
    tools: [],
    messages,
  };
}

function message(parts) {
  return {
    id: "message",
    role: "assistant",
    status: "complete",
    createdAt: "2026-09-18T10:00:00Z",
    parts,
  };
}

async function setup(t, initial = {}) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main"><h1>Linen blind</h1>
      <div data-main-product-media-gallery><swiper-container id="product-main-swiper-initial"><img data-testid="pdp-product-image-main" src="/cdn/shop/files/linen.jpg"></swiper-container></div>
      <dynamic-pricing><form data-dynamic-pricing-form>
        <dynamic-pricing-measurements><select data-measurement-select><option value="mm">mm</option></select>
          <div data-input-measurement-group="mm" data-active-input-measurement><input type="number" data-width-input value="500"><input type="number" data-drop-input value="600"></div>
        </dynamic-pricing-measurements>
        <fieldset data-feature="1"><input type="radio" name="Fitting##1" value="Recess##8" data-feature-option="1##8" checked><input type="radio" name="Fitting##1" value="Exact##7" data-feature-option="1##7"></fieldset>
        <p data-dynamic-price>£45.00</p>
      </form></dynamic-pricing>
    </main></app-provider><roman-ai-assistant></roman-ai-assistant></body>`,
    {
      url: "https://hd-dev-single.myshopify.com/products/linen",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  Object.assign(window, { Request, Response, Headers });
  for (const name of ["dynamic-pricing", "dynamic-pricing-measurements"])
    window.customElements.define(
      name,
      class extends window.HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
        }
      },
    );
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  const fetches = [];
  window.fetch = async (url) => {
    fetches.push(String(url));
    assert.equal(new URL(url).pathname, "/cart.js");
    return {
      ok: true,
      json: async () => ({
        currency: "GBP",
        item_count: 0,
        total_price: 0,
        items: [],
      }),
    };
  };
  window.eval(`${bundle.outputFiles[0].text};window.ViewsTest=ViewsTest;`);
  const container = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const listeners = new Set();
  let state = {
    conversation: conversation([
      message([{ type: "text", text: "Let's find your blind." }]),
    ]),
    pending: false,
    restoring: false,
    error: null,
    approval: null,
    voice: { status: "idle", muted: false, error: null },
    selectedVoice: "marin",
    ...initial,
  };
  const update = (change) => {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  };
  const calls = [];
  const session = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearError() {},
    sendMessage: async (text) => calls.push(["text", text]),
    startVoice: async () => calls.push(["startVoice"]),
    stopVoice: async () => calls.push(["stopVoice"]),
    setVoiceMuted: (muted) => update({ voice: { ...state.voice, muted } }),
    end: async () => {
      calls.push(["end"]);
      update({
        conversation: null,
        voice: { status: "idle", muted: false, error: null },
      });
    },
    loadProducts: async () => ({ products: [], messages: [] }),
  };
  const navigationCalls = [];
  let page = { url: window.location.href, pending: false, error: null };
  const navigationListeners = new Set();
  let ready = false;
  const dispose = window.ViewsTest.mount(container, {
    logoUrl: "/roman-logo.svg",
    session,
    showTools: false,
    navigation: {
      getSnapshot: () => page,
      subscribe(listener) {
        navigationListeners.add(listener);
        return () => navigationListeners.delete(listener);
      },
      navigate: async (path) => navigationCalls.push(path),
    },
    tools: { execute: async () => ({}) },
    onReady: () => {
      ready = true;
    },
    onError: (error) => errors.push(error),
  });
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(errors, []);
  });
  await until(() => ready || errors.length, "Assistant did not mount");
  assert.deepEqual(errors, []);
  const tab = (name) =>
    [...container.querySelectorAll(".roman-view-nav a")].find(
      (a) => a.textContent === name,
    );
  async function select(name) {
    tab(name).click();
    await until(
      () => tab(name).getAttribute("aria-current") === "page",
      `${name} did not become active`,
    );
  }
  return {
    window,
    container,
    update,
    state: () => state,
    calls,
    navigationCalls,
    fetches,
    select,
    nativeCart() {
      window.history.pushState({}, "", "/cart");
      window.document.body.className = "template-cart";
      window.document.querySelector("app-provider > main#main").innerHTML =
        "<h1>Cart</h1>";
      page = { ...page, url: window.location.href };
      navigationListeners.forEach((listener) => listener());
    },
  };
}

test("Cart and Gallery use memory navigation while retaining the transcript and composer draft", async (t) => {
  const ctx = await setup(t);
  const originalUrl = ctx.window.location.href;
  const history = ctx.container.querySelector(".roman-timeline");
  const textarea = ctx.container.querySelector("textarea");
  Object.getOwnPropertyDescriptor(
    ctx.window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(textarea, "Keep my draft");
  textarea.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
  await delay(0);
  assert.deepEqual(ctx.fetches, []);
  await ctx.select("Cart");
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Cart did not load",
  );
  assert.equal(ctx.container.querySelector(".roman-chat-scroll").hidden, true);
  assert.equal(ctx.container.querySelector("textarea"), textarea);
  assert.equal(textarea.value, "Keep my draft");
  await ctx.select("Gallery");
  assert.ok(ctx.container.querySelector('[aria-label="Your gallery"]'));
  assert.equal(ctx.container.querySelector(".roman-cart-stage"), null);
  await ctx.select("Chat");
  assert.equal(ctx.container.querySelector(".roman-chat-scroll").hidden, false);
  assert.equal(ctx.container.querySelector(".roman-timeline"), history);
  assert.equal(ctx.container.querySelector("textarea"), textarea);
  assert.equal(textarea.value, "Keep my draft");
  assert.equal(ctx.window.location.href, originalUrl);
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.fetches.length, 1);
});

test("active voice remains connected and retains its controls through every Roman tab", async (t) => {
  const ctx = await setup(t, {
    voice: { status: "active", muted: false, error: null },
  });
  const controls = ctx.container.querySelector(".roman-voice-composer");
  assert.ok(controls);
  for (const name of ["Gallery", "Cart", "Chat"]) {
    await ctx.select(name);
    assert.equal(
      ctx.container.querySelector(".roman-voice-composer"),
      controls,
    );
    assert.equal(ctx.state().voice.status, "active");
    assert.ok(ctx.container.querySelector('[aria-label="End voice"]'));
  }
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("a background PDP cannot activate itself and ending a chat unloads its selected blind", async (t) => {
  const ctx = await setup(t, { conversation: null });
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  ctx.update({
    conversation: conversation([
      message([{ type: "text", text: "Help me choose a blind." }]),
    ]),
  });
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  ctx.update({
    conversation: conversation([
      {
        ...message([
          { type: "navigation", path: "/products/linen", title: "Linen blind" },
        ]),
        role: "context",
      },
    ]),
  });
  await until(
    () => ctx.container.querySelector(".roman-product-stage"),
    "A confirmed selection did not appear",
  );
  assert.equal(
    ctx.container.querySelector(".roman-product-stage h2").textContent,
    "Linen blind",
  );
  await ctx.select("Cart");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => !ctx.container.querySelector(".roman-end-chat"),
    "Conversation did not end",
  );
  await until(
    () => !ctx.container.querySelector(".roman-chat-scroll").hidden,
    "End chat did not return to Chat",
  );
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  assert.equal(ctx.window.location.pathname, "/products/linen");
  ctx.update({
    conversation: conversation([
      message([{ type: "text", text: "Another room" }]),
    ]),
  });
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.calls, [["end"]]);
});

test("cart additions stay in Chat until View Cart is explicitly chosen", async (t) => {
  const ctx = await setup(t, {
    conversation: conversation([
      message([
        {
          type: "cart_added",
          version: 1,
          product: { productPath: "/products/linen", title: "Linen blind" },
        },
      ]),
    ]),
    voice: { status: "active", muted: false, error: null },
  });
  assert.equal(ctx.container.querySelector(".roman-chat-scroll").hidden, false);
  assert.deepEqual(ctx.fetches, []);
  ctx.container.querySelector(".roman-cart-added a").click();
  await until(
    () => ctx.container.querySelector(".roman-cart-stage"),
    "View Cart did not select the internal cart",
  );
  assert.equal(ctx.window.location.pathname, "/products/linen");
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.state().voice.status, "active");
});

test("submitting text from Cart immediately returns to the visible conversation", async (t) => {
  const ctx = await setup(t);
  await ctx.select("Cart");
  const textarea = ctx.container.querySelector("textarea");
  Object.getOwnPropertyDescriptor(
    ctx.window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(textarea, "Show me more blinds");
  textarea.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
  await until(
    () =>
      !ctx.container.querySelector('.roman-composer button[type="submit"]')
        .disabled,
    "Composer did not accept text",
  );
  ctx.container
    .querySelector(".roman-composer form")
    .dispatchEvent(
      new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await until(
    () => !ctx.container.querySelector(".roman-chat-scroll").hidden,
    "Text submission did not reveal Chat",
  );
  assert.deepEqual(ctx.calls, [["text", "Show me more blinds"]]);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("quick answers and pending activity remain visible alongside Cart and Gallery", async (t) => {
  const question = {
    type: "question",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    question: "What would you like next?",
    answers: ["Show me more", "Help me measure"],
  };
  const ctx = await setup(t, {
    conversation: conversation([message([question])]),
  });
  for (const name of ["Cart", "Gallery"]) {
    await ctx.select(name);
    const dock = ctx.container.querySelector(".roman-response-dock");
    assert.equal(dock.hidden, false);
    assert.ok(dock.querySelector(".roman-question"));
    assert.equal(
      dock.querySelector(".roman-question").closest("[hidden]"),
      null,
    );
    ctx.update({ pending: true });
    await until(
      () =>
        ctx.container.querySelector(".roman-dialogue > .roman-reply-activity"),
      "Pending activity was hidden by the selected tab",
    );
    ctx.update({ pending: false });
    await delay(0);
  }
});

test("native cart work preserves selected imagery across tabs without displaying stale price or dimensions", async (t) => {
  const ctx = await setup(t, {
    conversation: conversation([
      {
        ...message([
          { type: "navigation", path: "/products/linen", title: "Linen blind" },
        ]),
        role: "context",
      },
    ]),
  });
  await until(
    () => ctx.container.querySelector(".roman-product-stage-price"),
    "Product quote did not load",
  );
  const stage = ctx.container.querySelector(".roman-product-stage");
  const image = stage.querySelector("img").src;
  assert.match(stage.textContent, /£45\.00/);
  assert.ok(stage.querySelector(".roman-product-stage-measurements"));
  await ctx.select("Cart");
  assert.equal(ctx.container.querySelector(".roman-product-stage"), stage);
  assert.equal(stage.hidden, true);
  ctx.nativeCart();
  await until(
    () => !stage.querySelector(".roman-product-stage-price"),
    "Native cart retained stale product quote",
  );
  await ctx.select("Chat");
  assert.equal(ctx.container.querySelector(".roman-product-stage"), stage);
  assert.equal(stage.hidden, false);
  assert.equal(stage.querySelector("img").src, image);
  assert.equal(stage.querySelector("h2").textContent, "Linen blind");
  assert.equal(
    stage.querySelector(
      ".roman-product-stage-price, .roman-product-stage-measurements, .roman-product-stage-configuration",
    ),
    null,
  );
  assert.deepEqual(
    ctx.navigationCalls,
    [],
    "Returning to Chat must not silently reload the configured PDP",
  );
});

test("new voice carousel results reveal Chat while historical widgets and repeated snapshots respect the chosen tab", async (t) => {
  const oldPart = {
    type: "products",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    productIds: ["gid://shopify/Product/1"],
  };
  const original = conversation([message([oldPart])]);
  const ctx = await setup(t, {
    conversation: original,
    voice: { status: "active", muted: false, error: null },
  });
  const controls = ctx.container.querySelector(".roman-voice-composer");
  await ctx.select("Cart");
  ctx.update({ conversation: JSON.parse(JSON.stringify(original)) });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-scroll").hidden,
    true,
    "Historical cards cannot pull the customer out of Cart",
  );
  const next = conversation([
    ...original.messages,
    {
      ...message([
        {
          ...oldPart,
          invocationId: "22222222-2222-4222-8222-222222222222",
          productIds: ["gid://shopify/Product/2"],
        },
      ]),
      id: "new-carousel",
    },
  ]);
  ctx.update({ conversation: next });
  await until(
    () => !ctx.container.querySelector(".roman-chat-scroll").hidden,
    "New voice carousel stayed hidden on Cart",
  );
  assert.equal(ctx.container.querySelector(".roman-voice-composer"), controls);
  assert.equal(ctx.state().voice.status, "active");
  await ctx.select("Gallery");
  for (let revision = 2; revision < 5; revision++)
    ctx.update({
      conversation: { ...JSON.parse(JSON.stringify(next)), revision },
    });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-scroll").hidden,
    true,
    "Repeated snapshots cannot steal Gallery focus",
  );
  assert.ok(ctx.container.querySelector('[aria-label="Your gallery"]'));
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("a new numeric measurement reveals Chat without interrupting voice or reopening restored old questions", async (t) => {
  const ctx = await setup(t, {
    voice: { status: "active", muted: false, error: null },
  });
  await ctx.select("Gallery");
  const numeric = {
    ...message([
      {
        type: "question",
        version: 1,
        invocationId: "33333333-3333-4333-8333-333333333333",
        question: "What is the width?",
        answers: [],
        measurement: {
          productPath: "/products/linen",
          label: "Width",
          unit: "mm",
          instructions:
            "Measure the recess at the top, middle and bottom, and enter the smallest width.",
        },
      },
    ]),
    id: "measurement",
  };
  ctx.update({
    conversation: conversation([...ctx.state().conversation.messages, numeric]),
  });
  await until(
    () => !ctx.container.querySelector(".roman-chat-scroll").hidden,
    "Numeric voice question stayed hidden on Gallery",
  );
  assert.ok(
    ctx.container.querySelector('.roman-response-dock input[type="number"]'),
  );
  await ctx.select("Cart");
  ctx.update({
    conversation: { ...conversation([numeric]), id: "restored-conversation" },
  });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-scroll").hidden,
    true,
    "Restoring a different history cannot override the selected view",
  );
  assert.equal(ctx.state().voice.status, "active");
  assert.deepEqual(ctx.calls, []);
});
