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
      navigate: async () => {},
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
  return { window, container, calls, update, input, type, errors };
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
