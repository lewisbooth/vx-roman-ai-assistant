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

function customerMessage(text = "Help me find a blind for my kitchen.") {
  return {
    ...message([{ type: "text", text }]),
    id: "customer-message",
    role: "user",
  };
}

function engagedConversation(messages = []) {
  return conversation([customerMessage(), ...messages]);
}

async function setup(t, initial = {}, options = {}) {
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
  window.matchMedia = (query) => ({
    matches: !!options.mobile && /max-width:\s*(767|1023)px/.test(query),
    addEventListener() {},
    removeEventListener() {},
  });
  window.document.documentElement.setAttribute("data-roman-open", "");
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
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
    conversation: engagedConversation([
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
    end: async () => {
      calls.push(["end"]);
      await options.onEnd?.();
      update({
        conversation: null,
        voice: { status: "idle", muted: false, error: null },
      });
    },
    getCachedProducts: () => [],
    loadProducts: async () => ({ products: [], messages: [] }),
  };
  const navigationCalls = [];
  const toolCalls = [];
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
    tools: {
      execute: async (...args) => {
        toolCalls.push(args);
        return {};
      },
    },
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
    session,
    navigationCalls,
    toolCalls,
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
  assert.equal(
    ctx.fetches.length,
    1,
    "The open assistant reads the shared cart once for its badge",
  );
  await ctx.select("Cart");
  await until(
    () => ctx.container.textContent.includes("Your cart is empty"),
    "Cart did not load",
  );
  assert.equal(ctx.container.querySelector(".roman-chat-history").hidden, true);
  assert.equal(ctx.container.querySelector("textarea"), textarea);
  assert.equal(textarea.value, "Keep my draft");
  await ctx.select("Gallery");
  assert.ok(ctx.container.querySelector('[aria-label="Your gallery"]'));
  assert.equal(ctx.container.querySelector(".roman-cart-stage"), null);
  await ctx.select("Chat");
  assert.equal(
    ctx.container.querySelector(".roman-chat-history").hidden,
    false,
  );
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
  const controls = ctx.container.querySelector(".roman-voice-bar");
  assert.ok(controls);
  for (const name of ["Gallery", "Cart", "Chat"]) {
    await ctx.select(name);
    assert.equal(ctx.container.querySelector(".roman-voice-bar"), controls);
    assert.equal(ctx.state().voice.status, "active");
    assert.ok(ctx.container.querySelector('[aria-label="End voice"]'));
  }
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("the shared flow retains each tab's scroll position and background replies do not move Cart or Gallery", async (t) => {
  const ctx = await setup(t);
  const flow = ctx.container.querySelector(".roman-chat-scroll");
  Object.defineProperties(flow, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
  });
  function scrollTo(top) {
    flow.scrollTop = top;
    flow.dispatchEvent(
      new ctx.window.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
    );
    flow.dispatchEvent(new ctx.window.Event("scroll"));
  }
  scrollTo(120);
  await ctx.select("Cart");
  assert.equal(flow.scrollTop, 0);
  scrollTo(45);
  await ctx.select("Gallery");
  assert.equal(flow.scrollTop, 0);
  scrollTo(20);
  ctx.update({
    conversation: engagedConversation([
      message([{ type: "text", text: "Your next options are ready." }]),
    ]),
  });
  await delay(0);
  assert.equal(flow.scrollTop, 20);
  await ctx.select("Cart");
  assert.equal(flow.scrollTop, 45);
  await ctx.select("Chat");
  assert.equal(flow.scrollTop, 120);
  assert.ok(ctx.container.querySelector(".roman-return-current"));
});

test("a background PDP cannot activate itself and ending a chat unloads its selected blind", async (t) => {
  const ctx = await setup(t, { conversation: null });
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  ctx.update({
    conversation: engagedConversation([
      message([{ type: "text", text: "Help me choose a blind." }]),
    ]),
  });
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  ctx.update({
    conversation: engagedConversation([
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
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "Confirmation missing",
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () => !ctx.container.querySelector(".roman-end-chat"),
    "Conversation did not end",
  );
  await until(
    () => !ctx.container.querySelector(".roman-chat-history").hidden,
    "End chat did not return to Chat",
  );
  assert.equal(ctx.container.querySelector(".roman-product-stage"), null);
  assert.equal(ctx.window.location.pathname, "/products/linen");
  ctx.update({
    conversation: engagedConversation([
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
    conversation: engagedConversation([
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
  assert.equal(
    ctx.container.querySelector(".roman-chat-history").hidden,
    false,
  );
  assert.equal(
    ctx.fetches.length,
    1,
    "The cart badge shares its background read without showing Cart",
  );
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
    () => !ctx.container.querySelector(".roman-chat-history").hidden,
    "Text submission did not reveal Chat",
  );
  assert.deepEqual(ctx.calls, [["text", "Show me more blinds"]]);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("quick answers stay in Chat while pending activity remains visible in Cart and Gallery", async (t) => {
  const question = {
    type: "question",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    question: "What would you like next?",
    answers: ["Show me more", "Help me measure"],
  };
  const ctx = await setup(t, {
    conversation: engagedConversation([message([question])]),
  });
  const card = ctx.container.querySelector(".roman-question");
  for (const name of ["Cart", "Gallery"]) {
    await ctx.select(name);
    assert.equal(ctx.container.querySelector(".roman-question"), card);
    assert.ok(card.closest("[hidden]"));
    ctx.update({ pending: true });
    await until(
      () =>
        ctx.container.querySelector(
          ".roman-chat-scroll > .roman-reply-activity",
        ),
      "Pending activity was hidden by the selected tab",
    );
    ctx.update({ pending: false });
    await delay(0);
  }
  await ctx.select("Chat");
  assert.equal(ctx.container.querySelector(".roman-question"), card);
  assert.equal(card.closest("[hidden]"), null);
});

test("native cart work preserves selected imagery across tabs without displaying stale price or dimensions", async (t) => {
  const ctx = await setup(t, {
    conversation: engagedConversation([
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

function selectedConversation() {
  return engagedConversation([
    {
      ...message([
        { type: "navigation", path: "/products/linen", title: "Linen blind" },
      ]),
      role: "context",
    },
  ]);
}

test("selected-product actions share the message queue while busy and preserve connected voice", async (t) => {
  const ctx = await setup(t, {
    conversation: { ...selectedConversation(), busy: true },
    voice: { status: "active", muted: false, error: null },
  });
  await until(
    () => ctx.container.querySelector(".roman-product-stage-price"),
    "Product details loaded",
  );
  const voice = ctx.container.querySelector(".roman-voice-bar");
  const actions = ctx.container.querySelectorAll(
    ".roman-product-actions button",
  );
  assert.ok([...actions].every((button) => !button.disabled));
  actions[0].click();
  await until(
    () => ctx.container.querySelectorAll(".roman-queued-message").length === 1,
    "Cart intent is queued while Roman is working",
  );
  await until(
    () => !actions[1].disabled,
    "Enqueue acceptance unlocks product actions",
  );
  actions[1].click();
  await until(
    () => ctx.container.querySelectorAll(".roman-queued-message").length === 2,
    "Sample intent uses the same queue",
  );
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.toolCalls, []);
  assert.deepEqual(ctx.navigationCalls, []);
  const queued = [
    ...ctx.container.querySelectorAll(".roman-queued-message p"),
  ].map((element) => element.textContent);
  assert.match(queued[0], /^I'd like to add the Linen blind to my cart\.$/);
  assert.match(queued[1], /order a sample of the Linen blind, if available/i);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  ctx.update({ conversation: { ...ctx.state().conversation, busy: false } });
  await until(
    () => ctx.calls.length === 2,
    "Queued requests drain through the session client",
  );
  assert.deepEqual(
    ctx.calls,
    queued.map((text) => ["text", text]),
  );
  assert.equal(ctx.state().voice.status, "active");
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  assert.equal(
    ctx.fetches.length,
    1,
    "Actions do not directly mutate or refetch Shopify cart",
  );
});

test("product actions stay disabled during restoration, end confirmation and ending", async (t) => {
  let releaseEnd;
  const ctx = await setup(
    t,
    { conversation: selectedConversation() },
    {
      onEnd: () =>
        new Promise((resolve) => {
          releaseEnd = resolve;
        }),
    },
  );
  const buttons = () => [
    ...ctx.container.querySelectorAll(".roman-product-actions button"),
  ];
  await until(() => buttons().length === 2, "Product actions appeared");
  ctx.update({ restoring: true });
  await until(
    () => buttons().every((button) => button.disabled),
    "Restoration disables actions",
  );
  buttons().forEach((button) => button.click());
  assert.deepEqual(ctx.calls, []);
  ctx.update({ restoring: false });
  await until(
    () => buttons().every((button) => !button.disabled),
    "Restoration completion unlocks actions",
  );
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "End confirmation opens",
  );
  assert.ok(buttons().every((button) => button.disabled));
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(() => releaseEnd, "End starts");
  assert.ok(buttons().every((button) => button.disabled));
  assert.deepEqual(ctx.calls, [["end"]]);
  releaseEnd();
  await until(
    () => !ctx.container.querySelector(".roman-product-stage"),
    "End clears selected product",
  );
});

test("mobile product action closes only after queue acceptance and preserves its modal on queue overflow", async (t) => {
  const ctx = await setup(
    t,
    {
      conversation: { ...selectedConversation(), busy: true },
      voice: { status: "active", muted: false, error: null },
    },
    { mobile: true },
  );
  await until(
    () => ctx.container.querySelector('[aria-label="Expand selected product"]'),
    "Mobile selected product appears",
  );
  assert.equal(ctx.container.querySelector(".roman-product-actions"), null);
  for (let index = 0; index < 5; index++) {
    ctx.container
      .querySelector('[aria-label="Expand selected product"]')
      .click();
    await until(
      () => ctx.container.querySelector(".roman-product-expanded[open]"),
      "Product expanded",
    );
    const dialog = ctx.container.querySelector(".roman-product-expanded");
    assert.equal(
      dialog.querySelector("header > span").textContent,
      "Your selection",
    );
    dialog.querySelectorAll(".roman-product-actions button")[index % 2].click();
    await until(
      () => !ctx.container.querySelector(".roman-product-expanded"),
      "Accepted action returns to conversation",
    );
    assert.equal(
      ctx.container.querySelectorAll(".roman-queued-message").length,
      index + 1,
    );
  }
  ctx.container.querySelector('[aria-label="Expand selected product"]').click();
  await until(
    () => ctx.container.querySelector(".roman-product-expanded[open]"),
    "Product reopens at queue capacity",
  );
  const dialog = ctx.container.querySelector(".roman-product-expanded");
  dialog.querySelector(".roman-product-sample").click();
  await until(
    () => dialog.querySelector('[role="alert"]'),
    "Queue rejection is actionable inside the modal",
  );
  assert.match(
    dialog.querySelector('[role="alert"]').textContent,
    /queue up to five/,
  );
  assert.ok(dialog.open);
  assert.equal(dialog.querySelector(".roman-product-sample").disabled, false);
  assert.equal(
    ctx.container.querySelectorAll(".roman-queued-message").length,
    5,
  );
  assert.equal(ctx.state().voice.status, "active");
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.toolCalls, []);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("new voice carousel results reveal Chat while historical widgets and repeated snapshots respect the chosen tab", async (t) => {
  const oldPart = {
    type: "products",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    productIds: ["gid://shopify/Product/1"],
  };
  const original = engagedConversation([message([oldPart])]);
  const ctx = await setup(t, {
    conversation: original,
    voice: { status: "active", muted: false, error: null },
  });
  const controls = ctx.container.querySelector(".roman-voice-bar");
  await ctx.select("Cart");
  ctx.update({ conversation: JSON.parse(JSON.stringify(original)) });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-history").hidden,
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
    () => !ctx.container.querySelector(".roman-chat-history").hidden,
    "New voice carousel stayed hidden on Cart",
  );
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), controls);
  assert.equal(ctx.state().voice.status, "active");
  await ctx.select("Gallery");
  for (let revision = 2; revision < 5; revision++)
    ctx.update({
      conversation: { ...JSON.parse(JSON.stringify(next)), revision },
    });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-history").hidden,
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
    () => !ctx.container.querySelector(".roman-chat-history").hidden,
    "Numeric voice question stayed hidden on Gallery",
  );
  assert.ok(ctx.container.querySelector('.roman-question input[type="text"]'));
  await ctx.select("Cart");
  ctx.update({
    conversation: {
      ...engagedConversation([numeric]),
      id: "restored-conversation",
    },
  });
  await delay(0);
  assert.equal(
    ctx.container.querySelector(".roman-chat-history").hidden,
    true,
    "Restoring a different history cannot override the selected view",
  );
  assert.equal(ctx.state().voice.status, "active");
  assert.deepEqual(ctx.calls, []);
});

function voiceOpening() {
  const voiceId = "44444444-4444-4444-8444-444444444444";
  return [
    {
      ...message([
        { type: "voice_event", version: 1, voiceId, event: "started" },
      ]),
      id: "voice-started",
      role: "context",
    },
    {
      ...message([
        {
          type: "voice",
          version: 1,
          voiceId,
          startMs: 0,
          endMs: 1_000,
          text: "Hi! I'm Roman. Where would you like to begin?",
        },
      ]),
      id: "voice-greeting",
    },
  ];
}

function enterText(ctx, text) {
  const textarea = ctx.container.querySelector("textarea");
  Object.getOwnPropertyDescriptor(
    ctx.window.HTMLTextAreaElement.prototype,
    "value",
  ).set.call(textarea, text);
  textarea.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
  return textarea;
}

test("voice startup and Roman's opening retain live home tiles until customer speech", async (t) => {
  const ctx = await setup(t, { conversation: null });
  const welcome = ctx.container.querySelector(".roman-welcome");
  const textarea = enterText(ctx, "A blind for my kitchen");
  // Real layout is visible: exercise the focus transfer rather than JSDOM's
  // default no-layout guard masking an unwanted move to the voice controls.
  ctx.container.querySelector(".roman-conversation").getClientRects = () => [
    {},
  ];
  textarea.focus();
  await delay(0);
  ctx.update({ voice: { status: "starting", muted: false, error: null } });
  await until(
    () => ctx.container.querySelector(".roman-voice-bar"),
    "Voice controls did not appear",
  );
  assert.equal(ctx.container.querySelector(".roman-welcome"), welcome);
  assert.equal(ctx.container.querySelector("textarea"), null);
  assert.equal(ctx.container.querySelector('[type="submit"]'), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-welcome-tile:not(:disabled)").length,
    4,
  );
  assert.equal(ctx.container.querySelector(".roman-timeline"), null);

  const opening = voiceOpening();
  ctx.update({
    conversation: conversation(opening),
    voice: { status: "active", muted: false, error: null },
  });
  await until(
    () => ctx.container.querySelector(".roman-voice-waveform"),
    "Voice did not become active",
  );
  assert.equal(ctx.container.querySelector(".roman-welcome"), welcome);
  assert.equal(ctx.container.querySelector("textarea"), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-welcome-tile:not(:disabled)").length,
    4,
  );
  assert.equal(ctx.container.querySelector(".roman-timeline"), null);

  ctx.update({
    conversation: conversation([
      ...opening,
      {
        ...customerMessage(),
        parts: [
          {
            ...opening[1].parts[0],
            text: "I need a kitchen blind",
            startMs: 1_100,
            endMs: 2_000,
          },
        ],
      },
    ]),
  });
  await until(
    () => ctx.container.querySelector(".roman-timeline"),
    "Customer speech did not reveal the transcript",
  );
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /I need a kitchen blind/,
  );
  assert.equal(ctx.container.querySelector("textarea"), null);
  assert.equal(ctx.state().voice.status, "active");
  assert.deepEqual(ctx.calls, []);
  ctx.update({ voice: { status: "idle", muted: false, error: null } });
  await until(
    () => ctx.container.querySelector("textarea"),
    "Text did not return after voice ended",
  );
  assert.equal(
    ctx.container.querySelector("textarea").value,
    "A blind for my kitchen",
  );
});

test("first text or tile reply immediately opens the transcript and tiles preserve active voice", async (t) => {
  for (const { voiceStatus, input } of [
    { voiceStatus: "idle", input: "text" },
    { voiceStatus: "starting", input: "tile" },
    { voiceStatus: "active", input: "tile" },
  ]) {
    const ctx = await setup(t, {
      conversation: conversation(voiceOpening()),
      voice: { status: voiceStatus, muted: false, error: null },
    });
    let acknowledge;
    let completed = false;
    ctx.session.sendMessage = async (text) => {
      ctx.calls.push(["text", text]);
      ctx.update({ optimisticMessage: customerMessage(text), pending: true });
      await new Promise((resolve) => {
        acknowledge = resolve;
      });
      completed = true;
    };
    let text;
    if (input === "text") {
      text = "Blackout blinds for my bedroom";
      enterText(ctx, text);
      await until(
        () =>
          !ctx.container.querySelector('.roman-composer button[type="submit"]')
            .disabled,
        "Text entry stayed unavailable during the opening",
      );
      ctx.container
        .querySelector(".roman-composer form")
        .dispatchEvent(
          new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
        );
    } else {
      text = "Help me measure my windows for blinds.";
      ctx.container.querySelector(".roman-welcome-tile").click();
    }
    await until(
      () => ctx.container.querySelector(".roman-timeline"),
      `${input} did not open the transcript before submission completed`,
    );
    assert.equal(completed, false);
    assert.equal(ctx.container.querySelector(".roman-welcome"), null);
    assert.ok(
      ctx.container.querySelector(".roman-timeline").textContent.includes(text),
    );
    assert.equal(ctx.state().voice.status, voiceStatus);
    assert.equal(
      !!ctx.container.querySelector(".roman-voice-bar"),
      voiceStatus !== "idle",
    );
    assert.deepEqual(
      ctx.calls,
      [["text", text]],
      "A first visual response must not stop or restart voice",
    );
    acknowledge();
    await until(() => completed, "Submission did not complete");
  }
});

test("restored customer conversation opens the transcript and ending it restores the welcome for the next voice opening", async (t) => {
  const ctx = await setup(t, { conversation: null, restoring: true });
  assert.ok(ctx.container.querySelector(".roman-chat-restoring"));
  ctx.update({
    restoring: false,
    conversation: engagedConversation([
      message([{ type: "text", text: "Let's continue measuring." }]),
    ]),
  });
  await until(
    () => ctx.container.querySelector(".roman-timeline"),
    "Restored customer history was mistaken for a new greeting",
  );
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "Confirmation missing",
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () => ctx.container.querySelector(".roman-welcome"),
    "End chat did not reset the welcome",
  );
  ctx.update({
    conversation: { ...conversation(voiceOpening()), id: "next-conversation" },
    voice: { status: "active", muted: false, error: null },
  });
  await delay(0);
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  assert.equal(ctx.container.querySelector(".roman-timeline"), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-welcome-tile:not(:disabled)").length,
    4,
  );
  assert.equal(ctx.container.querySelector("textarea"), null);
  assert.ok(ctx.container.querySelector('[aria-label="End voice"]'));
  assert.deepEqual(ctx.calls, [["end"]]);
});

function cartReceipt(id, sample = false) {
  return {
    ...message([
      sample
        ? {
            type: "cart_sample_added",
            version: 1,
            invocationId: id,
            sample: { title: "Linen blind", productPath: "/products/linen" },
          }
        : {
            type: "cart_added",
            version: 1,
            invocationId: id,
            product: { title: "Linen blind", productPath: "/products/linen" },
          },
    ]),
    id,
    role: "context",
  };
}

function receiveCart(ctx, id, sample = false) {
  ctx.update({
    conversation: {
      ...ctx.state().conversation,
      messages: [...ctx.state().conversation.messages, cartReceipt(id, sample)],
    },
  });
}

const addedDialog = (ctx) =>
  [...ctx.container.querySelectorAll("dialog[open]")].find((dialog) =>
    dialog.querySelector("h2")?.textContent.includes("added to cart"),
  );

async function waitForAdded(ctx) {
  await until(
    () => addedDialog(ctx),
    "Confirmed addition opens Roman's shared modal",
  );
  return addedDialog(ctx);
}

test("cart confirmation persists until a customer action and Keep Shopping sends receipt context without replay", async (t) => {
  const ctx = await setup(t, {
    conversation: engagedConversation([cartReceipt("restored")]),
  });
  assert.equal(addedDialog(ctx), undefined);
  receiveCart(ctx, "fresh");
  const dialog = await waitForAdded(ctx);
  assert.equal(
    dialog.querySelector("h2").textContent,
    "Linen blind added to cart",
  );
  ctx.update({ conversation: structuredClone(ctx.state().conversation) });
  await delay(2100);
  assert.equal(
    addedDialog(ctx),
    dialog,
    "Confirmation remains open beyond the retired two-second timer",
  );
  dialog.querySelector(".roman-dialog-secondary").click();
  await until(
    () => !addedDialog(ctx),
    "Keep Shopping accepts the continuation and dismisses",
  );
  assert.deepEqual(ctx.calls, [
    [
      "text",
      "I'd like to keep shopping after adding the Linen blind to my cart.",
    ],
  ]);
  ctx.update({ conversation: structuredClone(ctx.state().conversation) });
  await delay(10);
  assert.equal(addedDialog(ctx), undefined);
  receiveCart(ctx, "sample", true);
  const sample = await waitForAdded(ctx);
  assert.equal(
    sample.querySelector("h2").textContent,
    "Linen blind sample added to cart",
  );
  sample.querySelector(".roman-dialog-secondary").click();
  await until(
    () => !addedDialog(ctx),
    "Keep Shopping submits sample context and closes",
  );
  assert.deepEqual(ctx.calls[1], [
    "text",
    "I'd like to continue where we left off with the Linen blind after adding its sample to my cart.",
  ]);
  assert.equal(
    ctx.container.querySelector('[aria-current="page"]').textContent,
    "Chat",
  );
});

test("View Cart is immediate memory navigation with no message, tool or voice interruption", async (t) => {
  const ctx = await setup(t, {
    voice: { status: "active", muted: false, error: null },
  });
  const voice = ctx.container.querySelector(".roman-voice-bar");
  const url = ctx.window.location.href;
  receiveCart(ctx, "added");
  const dialog = await waitForAdded(ctx);
  dialog.querySelector(".roman-dialog-primary").click();
  await until(
    () =>
      ctx.container.querySelector('[aria-current="page"]').textContent ===
      "Cart",
    "Cart tab opens",
  );
  assert.equal(addedDialog(ctx), undefined);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.toolCalls, []);
  assert.deepEqual(ctx.navigationCalls, []);
  assert.equal(ctx.window.location.href, url);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
});

test("closed, restored and blocked cart receipts are consumed without later flashes", async (t) => {
  const ctx = await setup(t);
  ctx.window.document.documentElement.removeAttribute("data-roman-open");
  receiveCart(ctx, "while-closed");
  await delay(10);
  ctx.window.document.documentElement.setAttribute("data-roman-open", "");
  await delay(10);
  assert.equal(addedDialog(ctx), undefined);
  ctx.update({ restoring: true });
  receiveCart(ctx, "restoring");
  await delay(10);
  ctx.update({ restoring: false });
  await delay(10);
  assert.equal(addedDialog(ctx), undefined);
  ctx.update({
    approval: { invocationId: "clear", title: "Empty your cart?", details: [] },
  });
  receiveCart(ctx, "while-approving");
  await delay(10);
  ctx.update({ approval: null });
  await delay(10);
  assert.equal(addedDialog(ctx), undefined);
  receiveCart(ctx, "visible");
  await waitForAdded(ctx);
  ctx.window.document.documentElement.removeAttribute("data-roman-open");
  await until(() => !addedDialog(ctx), "Closing Roman closes its native modal");
  ctx.window.document.documentElement.setAttribute("data-roman-open", "");
  await delay(10);
  assert.equal(addedDialog(ctx), undefined);
  receiveCart(ctx, "new-visible");
  await waitForAdded(ctx);
  ctx.update({
    conversation: {
      ...engagedConversation([cartReceipt("another-session")]),
      id: "another",
    },
  });
  await until(
    () => !addedDialog(ctx),
    "New session cannot inherit a notification",
  );
});

test("Keep Shopping uses the busy voice queue and retains a failed continuation for retry", async (t) => {
  const ctx = await setup(t, {
    conversation: { ...selectedConversation(), busy: true },
    voice: { status: "active", muted: false, error: null },
  });
  const voice = ctx.container.querySelector(".roman-voice-bar");
  const sample = ctx.container.querySelector(".roman-product-sample");
  for (let i = 1; i <= 5; i++) {
    sample.click();
    await until(
      () =>
        ctx.container.querySelectorAll(".roman-queued-message").length === i,
      "Fill bounded message queue",
    );
    await until(() => !sample.disabled, "Action enqueue accepted");
  }
  receiveCart(ctx, "confirmed-sample", true);
  const dialog = await waitForAdded(ctx);
  const keep = dialog.querySelector(".roman-dialog-secondary");
  keep.click();
  await until(
    () => dialog.querySelector('[role="alert"]'),
    "Full queue error is actionable inside modal",
  );
  assert.equal(addedDialog(ctx), dialog);
  assert.deepEqual(ctx.calls, []);
  assert.equal(keep.disabled, false);
  ctx.update({ conversation: { ...ctx.state().conversation, busy: false } });
  await until(
    () => ctx.calls.length === 5,
    "Existing messages drain when voice work completes",
  );
  keep.click();
  keep.click();
  await until(
    () => !addedDialog(ctx),
    "Successful continuation retry closes the modal",
  );
  await until(() => ctx.calls.length === 6, "Continuation sent exactly once");
  assert.match(
    ctx.calls[5][1],
    /continue where we left off with the Linen blind after adding its sample/,
  );
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), voice);
  assert.deepEqual(ctx.toolCalls, []);
  assert.deepEqual(ctx.navigationCalls, []);
});
