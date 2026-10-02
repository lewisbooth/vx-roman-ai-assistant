import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { historySnapshot } from "./helpers/history-snapshot.mjs";

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
  globalName: "WelcomeThemeTest",
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

function message(role, text, voice = false) {
  return {
    id: `${role}-${voice ? "voice" : "text"}`,
    role,
    status: "complete",
    createdAt: "2026-10-02T10:00:00Z",
    parts: [voice ? {
      type: "voice",
      version: 1,
      voiceId: "44444444-4444-4444-8444-444444444444",
      startMs: 0,
      endMs: 1_000,
      text,
    } : { type: "text", text }],
  };
}

function conversation(messages = [], current) {
  return {
    id: "conversation",
    status: "active",
    revision: 1,
    busy: false,
    tools: [],
    messages,
    ...(current ? { current } : {}),
  };
}

async function setup(t, initial = {}, options = {}) {
  const dom = new JSDOM("<!doctype html><body><roman-ai-assistant></roman-ai-assistant></body>", {
    url: "https://hd-dev-single.myshopify.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(window, { Request, Response, Headers });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.document.documentElement.setAttribute("data-roman-open", "");
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.fetch = async (url) => {
    assert.equal(new URL(url).pathname, "/cart.js");
    return { ok: true, json: async () => ({ currency: "GBP", item_count: 0, total_price: 0, items: [] }) };
  };
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  window.eval(`${bundle.outputFiles[0].text};window.WelcomeThemeTest=WelcomeThemeTest;`);
  const container = window.document.querySelector("roman-ai-assistant").attachShadow({ mode: "open" });
  const listeners = new Set();
  let state = {
    conversation: null,
    pending: false,
    restoring: false,
    error: null,
    approval: null,
    voice: { status: "idle", muted: false, error: null },
    ...initial,
  };
  state.conversation = historySnapshot(state.conversation);
  const update = (change) => {
    state = {
      ...state,
      ...change,
      ...("conversation" in change ? { conversation: historySnapshot(change.conversation) } : {}),
    };
    listeners.forEach((listener) => listener());
  };
  const calls = [];
  const session = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    clearError() {},
    loadOlderHistory: async () => {},
    getCachedProducts: () => [],
    loadProducts: async () => ({ products: [], messages: [] }),
    sendMessage: async (text) => calls.push(text),
    startVoice: async () => {},
    stopVoice: async () => {},
    end: async () => {
      await options.onEnd?.();
      update({ conversation: null, optimisticMessage: undefined, voice: { status: "idle", muted: false, error: null } });
    },
  };
  const page = { url: window.location.href, pending: false, error: null };
  let ready = false;
  const dispose = window.WelcomeThemeTest.mount(container, {
    logoUrl: "/roman-logo.svg",
    session,
    navigation: { getSnapshot: () => page, subscribe: () => () => {}, navigate: async () => {} },
    onReady: () => { ready = true; },
    onError: (error) => errors.push(error),
  });
  t.after(() => { dispose(); window.close(); assert.deepEqual(errors, []); });
  await until(() => ready || errors.length, "Assistant did not mount");
  assert.deepEqual(errors, []);
  const tab = (name) => [...container.querySelectorAll(".roman-view-nav a")].find((a) => a.textContent === name);
  return {
    window, container, session, calls, update,
    dark: () => container.querySelector(".roman-chat").getAttribute("data-welcome-theme") === "true",
    async select(name) {
      tab(name).click();
      await until(() => tab(name).getAttribute("aria-current") === "page", `${name} did not become active`);
    },
    async end() {
      container.querySelector(".roman-end-chat").click();
      await until(() => container.querySelector(".roman-dialog-primary"), "End confirmation missing");
      container.querySelector(".roman-dialog-primary").click();
    },
  };
}

test("the burgundy welcome survives voice connection and greeting but never themes Cart or Gallery", async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.dark(), true);
  const welcome = ctx.container.querySelector(".roman-welcome");
  ctx.update({ voice: { status: "starting", muted: false, error: null } });
  await until(() => ctx.container.querySelector(".roman-voice-bar"), "Voice did not start");
  assert.equal(ctx.dark(), true);
  ctx.update({
    conversation: conversation([message("assistant", "Hi! I'm Roman. Where would you like to begin?", true)]),
    voice: { status: "active", muted: false, error: null },
  });
  await until(() => ctx.container.querySelector(".roman-voice-waveform"), "Voice did not connect");
  assert.equal(ctx.dark(), true);
  assert.equal(ctx.container.querySelector(".roman-welcome"), welcome);
  for (const name of ["Cart", "Gallery", "Chat", "Gallery", "Cart", "Chat"]) {
    await ctx.select(name);
    assert.equal(ctx.dark(), name === "Chat", `${name} received the welcome theme`);
  }
  assert.deepEqual(ctx.calls, []);
});

test("a queued first tile switches to light before the customer message reaches the server", async (t) => {
  const ctx = await setup(t, { pending: true });
  assert.equal(ctx.dark(), true);
  ctx.container.querySelector(".roman-welcome-tile").click();
  await until(() => !ctx.dark(), "Queued tile did not switch the theme immediately");
  assert.deepEqual(ctx.calls, [], "Busy transport should not send the queued tile yet");
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
  ctx.container.querySelector('[aria-label^="Remove queued message:"]').click();
  await delay(10);
  assert.equal(ctx.dark(), false, "Removing a queued customer turn must not restore the empty theme");
});

test("optimistic text switches to light and transient errors or empty snapshots cannot switch it back", async (t) => {
  const ctx = await setup(t);
  ctx.update({ optimisticMessage: message("user", "Help me choose a blind."), pending: true });
  await until(() => !ctx.dark(), "Optimistic text did not switch the theme");
  ctx.update({ optimisticMessage: undefined, pending: false, error: "Connection unavailable" });
  await delay(10);
  assert.equal(ctx.dark(), false);
  ctx.update({ error: null, conversation: conversation() });
  await delay(10);
  assert.equal(ctx.dark(), false);
  await ctx.select("Cart");
  assert.equal(ctx.dark(), false);
  await ctx.select("Chat");
  assert.equal(ctx.dark(), false);
});

test("the first streaming customer voice caption switches the welcome to light", async (t) => {
  const opening = message("assistant", "Hi! I'm Roman.", true);
  const ctx = await setup(t, {
    conversation: conversation([opening]),
    voice: { status: "active", muted: false, error: null },
  });
  assert.equal(ctx.dark(), true);
  ctx.update({ conversation: conversation([
    opening,
    { ...message("user", "I need", true), status: "streaming" },
  ]) });
  await until(() => !ctx.dark(), "Customer caption waited for a completed voice turn");
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
});

test("restoring paginated history uses the authoritative customer-turn state without flashing burgundy", async (t) => {
  const ctx = await setup(t, { restoring: true });
  assert.equal(ctx.dark(), false);
  ctx.update({
    restoring: false,
    conversation: conversation([message("assistant", "Let's continue.")], { hasCustomerReply: true }),
  });
  await until(() => ctx.container.querySelector(".roman-timeline"), "Restored conversation was treated as a new welcome");
  assert.equal(ctx.dark(), false);
});

test("external conversation clearing restores welcome while an empty snapshot of the same conversation stays light", async (t) => {
  const ctx = await setup(t, {
    conversation: conversation([message("user", "I need a kitchen blind.")]),
  });
  assert.equal(ctx.dark(), false);
  ctx.update({ conversation: conversation() });
  await delay(10);
  assert.equal(ctx.dark(), false, "An empty message page is not a cleared conversation");
  ctx.update({ conversation: null });
  await until(() => ctx.dark(), "Session-owned conversation clearing did not restore welcome");
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  assert.equal(ctx.container.querySelector(".roman-timeline"), null);
  ctx.update({
    conversation: { ...conversation([message("assistant", "Hi! I'm Roman.", true)]), id: "next-conversation" },
    voice: { status: "active", muted: false, error: null },
  });
  await until(() => ctx.container.querySelector(".roman-voice-waveform"), "The next voice session did not start");
  assert.equal(ctx.dark(), true, "The previous customer's turn carried over after clearing");
});

test("only successful End chat restores the burgundy welcome", async (t) => {
  let failEnd = true;
  const ctx = await setup(t, {
    conversation: conversation([message("user", "I need a kitchen blind.")]),
  }, {
    onEnd: async () => { if (failEnd) throw new ctx.window.Error("Could not clear chat"); },
  });
  assert.equal(ctx.dark(), false);
  await ctx.end();
  await until(() => ctx.container.textContent.includes("Could not clear chat"), "End failure was not shown");
  assert.equal(ctx.dark(), false);
  failEnd = false;
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(() => ctx.dark(), "Clearing chat did not restore the burgundy welcome");
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  for (const name of ["Cart", "Gallery", "Chat"]) {
    await ctx.select(name);
    assert.equal(ctx.dark(), name === "Chat");
  }
});
