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
      import { Timeline } from './frontend/src/chat/Timeline';
      export { reconcileReplyReveal, advanceReplyReveal } from './frontend/src/chat/useReplyReveal';
      export function mount(container) {
        const root = createRoot(container);
        const navigation = {}, onContentChange = () => {}, onAnswer = async () => {};
        const session = {
          getCachedProducts: () => [],
          loadProducts: async (ids) => {
            window.catalogLoads.push(ids);
            return { products: ids.map(id => ({ id, title: 'Blind ' + id,
              url: '/products/' + id, priceLabel: 'From GBP 20.00' })), messages: [] };
          },
          loadProductImage: async (url) => { window.imageLoads.push(url); return undefined; },
        };
        return {
          render(props) { flushSync(() => root.render(<div className="roman-chat-history"><Timeline navigation={navigation} session={session}
            onContentChange={onContentChange} onAnswer={onAnswer} {...props}/></div>)); },
          tick(ms) { flushSync(() => window.tick(ms)); },
          dispose() { flushSync(() => root.unmount()); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RevealTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

function setup(t) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.catalogLoads = [];
  dom.window.imageLoads = [];
  const errors = [];
  const timers = new Map();
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
  const nativeClearTimeout = dom.window.clearTimeout.bind(dom.window);
  let now = 0,
    timerId = 10000;
  dom.window.console.error = (...args) => errors.push(args);
  Object.defineProperty(dom.window.performance, "now", { value: () => now });
  dom.window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 32) return nativeSetTimeout(callback, delay, ...args);
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  };
  dom.window.clearTimeout = (id) => {
    if (!timers.delete(id)) nativeClearTimeout(id);
  };
  dom.window.tick = (ms) => {
    now += ms;
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  dom.window.eval(`${bundle.outputFiles[0].text};window.api=RevealTest;`);
  const container = dom.window.document.querySelector("#root");
  const view = dom.window.api.mount(container);
  t.after(() => {
    view.dispose();
    assert.equal(timers.size, 0, "Unmount must release the reveal timer");
    dom.window.close();
    assert.deepEqual(errors, []);
  });
  return {
    ...view,
    container,
    timers,
    window: dom.window,
    api: dom.window.api,
  };
}

const message = (id, role, parts, status = "complete") => ({
  id,
  role,
  parts,
  status,
  createdAt: "2026-09-21T12:00:00Z",
});
const text = (value) => ({ type: "text", text: value });
const user = (id = "user") => message(id, "user", [text("Help me choose")]);
const question = (overrides = {}) => ({
  type: "question",
  version: 1,
  invocationId: "q",
  question: "Which style would you like?",
  answers: ["Plain", "Patterned"],
  ...overrides,
});
const displayed = (ctx) =>
  [...ctx.container.querySelectorAll(".roman-rich-text")]
    .map((node) => node.textContent)
    .join("");
const choices = (ctx) => ctx.container.querySelector(".roman-question");
const products = (overrides = {}) => ({
  type: "products",
  version: 1,
  invocationId: "carousel",
  productIds: ["plain", "patterned"],
  ...overrides,
});

test("carousels preload invisibly and inline receipts wait for the same text reveal as quick answers", async (t) => {
  const ctx = setup(t);
  ctx.render({ messages: [user()] });
  ctx.render({
    messages: [
      user(),
      message("reply", "assistant", [
        text("Here are two light-filtering blinds to compare."),
        products(),
        question(),
      ]),
      message("receipt", "context", [
        {
          type: "cart_sample_added",
          version: 1,
          invocationId: "sample",
          sample: { title: "Plain blind" },
        },
      ]),
    ],
    activeQuestionId: "q",
  });
  await delay(0);
  const cards = ctx.container.querySelector(".roman-products");
  assert.ok(
    cards?.closest("[hidden]"),
    "Loaded carousel stays out of layout and accessibility tree",
  );
  assert.equal(
    ctx.window.catalogLoads.length,
    1,
    "Catalog preloads while prose reveals",
  );
  assert.equal(
    ctx.window.imageLoads.length,
    2,
    "Both carousel images warm before reveal ends",
  );
  assert.equal(ctx.container.querySelector(".roman-cart-added"), null);
  assert.equal(choices(ctx), null);
  ctx.tick(1000);
  assert.equal(cards.closest("[hidden]"), null);
  assert.equal(
    ctx.container.querySelector(".roman-products"),
    cards,
    "Releasing the carousel keeps its loaded content",
  );
  assert.ok(ctx.container.querySelector(".roman-cart-added"));
  assert.ok(choices(ctx));
});

test("an early widget-only snapshot stays hidden until the final text arrives and finishes", async (t) => {
  const ctx = setup(t);
  ctx.render({ messages: [user()] });
  ctx.render({
    messages: [user(), message("reply", "assistant", [products()], "pending")],
  });
  await delay(0);
  const cards = ctx.container.querySelector(".roman-products");
  assert.ok(cards.closest("[hidden]"));
  assert.equal(ctx.window.catalogLoads.length, 1);
  ctx.tick(1000);
  assert.ok(
    cards.closest("[hidden]"),
    "No timer guesses completion before prose arrives",
  );
  ctx.render({
    messages: [
      user(),
      message("reply", "assistant", [
        text("Here is the finished comparison."),
        products(),
      ]),
    ],
  });
  assert.ok(cards.closest("[hidden]"));
  ctx.tick(1000);
  assert.equal(cards.closest("[hidden]"), null);
});

test("older and voice carousels are not hidden by a new text reply", async (t) => {
  const ctx = setup(t);
  const history = [
    user("old-user"),
    message("old-reply", "assistant", [text("Previous results."), products()]),
  ];
  ctx.render({ messages: history });
  await delay(0);
  const previous = ctx.container.querySelector(".roman-products");
  assert.equal(previous.closest("[hidden]"), null);
  ctx.render({
    messages: [
      ...history,
      user("new-user"),
      message("new-reply", "assistant", [
        text("A new reply is being revealed."),
        products({
          invocationId: "voice-carousel",
          voiceReply: { voiceId: "voice", afterSequence: 1 },
        }),
      ]),
    ],
  });
  await delay(0);
  assert.equal(previous.closest("[hidden]"), null);
  assert.ok(
    [...ctx.container.querySelectorAll(".roman-products")].every(
      (node) => !node.closest("[hidden]"),
    ),
  );
});

test("new complete blocks reveal before answers, preserve formatting and do not restart on polling", (t) => {
  const ctx = setup(t);
  ctx.render({ messages: [user()] });
  const response =
    "Here are **calm, light-filtering blinds** for your living room.";
  const messages = [
    user(),
    message("reply", "assistant", [text(response), question()]),
  ];
  ctx.render({ messages, activeQuestionId: "q" });
  assert.equal(displayed(ctx), "");
  assert.equal(choices(ctx), null);
  assert.equal(ctx.container.querySelector("[aria-busy=true]")?.tagName, "LI");
  assert.equal(ctx.timers.size, 1);
  ctx.tick(150);
  const partial = displayed(ctx);
  assert.ok(partial.length > 0 && partial.length < 50);
  assert.equal(choices(ctx), null);
  ctx.render({ messages: structuredClone(messages), activeQuestionId: "q" });
  assert.equal(displayed(ctx), partial);
  ctx.tick(1000);
  assert.equal(displayed(ctx), response.replaceAll("**", ""));
  assert.equal(
    ctx.container.querySelector("strong").textContent,
    "calm, light-filtering blinds",
  );
  assert.ok(choices(ctx));
  assert.equal(ctx.container.querySelector("[aria-busy=true]"), null);
  assert.equal(ctx.timers.size, 0);
});

test("streamed append holds an early measurement question until both source and reveal finish", (t) => {
  const ctx = setup(t);
  ctx.render({ messages: [user()] });
  const offered = question({
    measurement: {
      productPath: "/products/blind",
      label: "Width",
      unit: "mm",
      instructions: "Take the shortest width.",
    },
  });
  ctx.render({
    messages: [
      user(),
      message(
        "reply",
        "assistant",
        [text("Measure the width."), offered],
        "pending",
      ),
    ],
    activeQuestionId: "q",
  });
  ctx.tick(1000);
  assert.equal(displayed(ctx), "Measure the width.");
  assert.equal(
    choices(ctx),
    null,
    "Caught-up text is not a completed server reply",
  );
  ctx.render({
    messages: [
      user(),
      message("reply", "assistant", [
        text("Measure the width. Use the shortest measurement."),
        offered,
      ]),
    ],
    activeQuestionId: "q",
  });
  assert.equal(displayed(ctx), "Measure the width.");
  assert.equal(choices(ctx), null);
  ctx.tick(1000);
  assert.ok(ctx.container.querySelector(".roman-measurement-form"));
});

test("restored history, question-only replies and voice captions remain immediate", (t) => {
  const ctx = setup(t);
  ctx.render({
    messages: [
      user(),
      message("history", "assistant", [text("Already read."), question()]),
    ],
    activeQuestionId: "q",
  });
  assert.equal(displayed(ctx), "Already read.");
  assert.ok(choices(ctx));
  assert.equal(ctx.timers.size, 0);
  ctx.render({
    messages: [
      user("new"),
      message("question-only", "assistant", [question()]),
    ],
    activeQuestionId: "q",
  });
  assert.ok(choices(ctx));
  const voice = {
    type: "voice",
    version: 1,
    voiceId: "voice",
    text: "Here is your answer.",
    startMs: 0,
    endMs: 1000,
  };
  ctx.render({
    messages: [
      user("voice-user"),
      message("voice", "assistant", [voice]),
      message("offered", "context", [
        question({ voiceReply: { voiceId: "voice", afterSequence: 1 } }),
      ]),
    ],
    activeQuestionId: "q",
    voice: true,
  });
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    voice.text,
  );
  assert.ok(choices(ctx));
  assert.equal(ctx.timers.size, 0);
});

test("a new customer message finishes prior reveal without reviving retired answers", (t) => {
  const ctx = setup(t);
  ctx.render({ messages: [user()] });
  const reply = message("reply", "assistant", [
    text("A response which is still being revealed."),
    question(),
  ]);
  ctx.render({ messages: [user(), reply], activeQuestionId: "q" });
  ctx.tick(50);
  ctx.render({ messages: [user(), reply, user("next")] });
  assert.equal(displayed(ctx), reply.parts[0].text);
  assert.equal(choices(ctx), null);
  assert.equal(ctx.timers.size, 0);
});

test("final same-ID rewrites and failures reconcile safely and removed replies release state", (t) => {
  const { api } = setup(t);
  let state = api.reconcileReplyReveal(undefined, [user()]);
  state = api.reconcileReplyReveal(state, [
    user(),
    message("reply", "assistant", [text("A longer streamed draft")], "pending"),
  ]);
  state = api.advanceReplyReveal(state, 120);
  const prepared = state.parts[0].prepared;
  state = api.reconcileReplyReveal(state, structuredClone(state.messages));
  assert.equal(
    state.parts[0].prepared,
    prepared,
    "Poll clones reuse sanitized Markdown",
  );
  state = api.reconcileReplyReveal(state, [
    user(),
    message("reply", "assistant", [text("Short.")]),
  ]);
  assert.equal(state.parts[0].visible, state.parts[0].prepared.length);
  state = api.reconcileReplyReveal(state, [
    user(),
    message(
      "reply",
      "assistant",
      [text("A final failure explanation.")],
      "failed",
    ),
  ]);
  assert.equal(state.parts[0].visible, state.parts[0].prepared.length);
  state = api.reconcileReplyReveal(state, [user()]);
  assert.equal(state.parts.length, 0);
});

test("one shared reveal budget keeps multi-part replies in order", (t) => {
  const { api } = setup(t);
  let state = api.reconcileReplyReveal(undefined, [user()]);
  state = api.reconcileReplyReveal(state, [
    user(),
    message("reply", "assistant", [text("First part."), text("Second part.")]),
  ]);
  state = api.advanceReplyReveal(state, 50);
  assert.equal(state.parts[0].visible, 6);
  assert.equal(state.parts[1].visible, 0);
  state = api.advanceReplyReveal(state, 1000);
  assert.ok(state.parts.every((part) => part.visible === part.prepared.length));
});
