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
    import { useLayoutEffect, useState } from 'react';
    import { useMessageQueue } from './frontend/src/chat/useMessageQueue';
    import { MessageQueue } from './frontend/src/chat/MessageQueue';
    export function mount(container, session) {
      const root = createRoot(container);
      function Harness() {
        const [paused, setPaused] = useState(false);
        window.queue = useMessageQueue(session, paused);
        window.pauseQueue = setPaused;
        useLayoutEffect(() => {
          (window.queueRenders ??= []).push(window.queue.messages.map(({text, status}) => ({text, status})));
        });
        return <MessageQueue messages={window.queue.messages} onRemove={window.queue.remove} onRetry={window.queue.retry} />;
      }
      root.render(<Harness />);
      return () => root.unmount();
    }
  `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "QueueTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("Queue did not reach the expected state");
}

async function setup(t, overrides = {}) {
  const dom = new JSDOM("<div id='root'></div>", {
    runScripts: "outside-only",
  });
  const listeners = new Set();
  let state = {
    conversation: { id: "chat-1", status: "active", busy: false, messages: [] },
    pending: false,
    restoring: false,
    error: null,
    voice: { status: "idle", muted: false, error: null },
    ...overrides,
  };
  const update = (changes) => {
    state = { ...state, ...changes };
    for (const listener of listeners) listener();
  };
  const calls = [];
  const session = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearError() {
      update({ error: null });
    },
    sendMessage(text) {
      update({ pending: true });
      return new Promise((resolve, reject) =>
        calls.push({
          text,
          accept() {
            update({
              pending: false,
              conversation: { ...state.conversation, busy: true },
            });
            resolve();
          },
          fail() {
            update({ pending: false, error: "Connection lost" });
            reject(new Error("Connection lost"));
          },
        }),
      );
    },
  };
  dom.window.eval(
    `${bundle.outputFiles[0].text}\nwindow.QueueTest = QueueTest;`,
  );
  const unmount = dom.window.QueueTest.mount(
    dom.window.document.getElementById("root"),
    session,
  );
  t.after(() => {
    unmount();
    dom.window.close();
  });
  await until(() => dom.window.queue);
  return {
    calls,
    update,
    window: dom.window,
    session,
    queue: () => dom.window.queue,
    finish: () =>
      update({ conversation: { ...state.conversation, busy: false } }),
  };
}

test("idle submissions dispatch immediately without ever rendering a queued preview", async (t) => {
  const ctx = await setup(t);
  ctx.queue().enqueue("send this now");
  assert.equal(
    ctx.calls.length,
    1,
    "Idle dispatch must not wait for an effect or timer",
  );
  await until(() => ctx.queue().messages[0]?.status === "sending");
  assert.equal(ctx.window.document.querySelector(".roman-message-queue"), null);
  assert.ok(
    ctx.window.queueRenders.every((rows) =>
      rows.every((row) => row.status === "sending"),
    ),
  );
  ctx.calls[0].accept();
  await until(() => ctx.queue().messages.length === 0);
  assert.equal(ctx.window.document.querySelector(".roman-message-queue"), null);
});

test("only genuinely waiting input renders a preview, and dispatch transfers it to the client", async (t) => {
  const ctx = await setup(t, { pending: true });
  ctx.queue().enqueue("wait for the current reply");
  assert.equal(ctx.calls.length, 0);
  await until(() => ctx.window.document.querySelector(".roman-queued-message"));
  assert.match(
    ctx.window.document.querySelector(".roman-message-queue").textContent,
    /wait for the current reply/,
  );
  ctx.update({ pending: false });
  await until(
    () =>
      ctx.calls.length === 1 &&
      !ctx.window.document.querySelector(".roman-message-queue"),
  );
  assert.equal(
    ctx.queue().messages[0].status,
    "sending",
    "In-flight ownership remains until acceptance",
  );
});

test("idle failures become visible and deliberate retry uses the same message without a queued flash", async (t) => {
  const ctx = await setup(t);
  ctx.queue().enqueue("retain this request");
  assert.equal(ctx.calls.length, 1);
  ctx.calls[0].fail();
  await until(() =>
    ctx.window.document.querySelector(".roman-message-queue [role=alert]"),
  );
  const id = ctx.queue().messages[0].id;
  assert.equal(ctx.queue().messages[0].status, "failed");
  ctx.window.queueRenders = [];
  ctx.queue().retry(id);
  await until(
    () =>
      ctx.calls.length === 2 &&
      !ctx.window.document.querySelector(".roman-message-queue"),
  );
  assert.equal(ctx.queue().messages[0].id, id);
  assert.ok(
    ctx.window.queueRenders.every((rows) =>
      rows.every((row) => row.status !== "queued"),
    ),
  );
  assert.deepEqual(
    ctx.calls.map((call) => call.text),
    ["retain this request", "retain this request"],
  );
});

test("free text queues once in order and waits for both acceptance and completed reply", async (t) => {
  const ctx = await setup(t);
  ctx.queue().enqueue("first");
  ctx.queue().enqueue("second");
  ctx.queue().enqueue("third");
  assert.equal(
    ctx.calls.length,
    1,
    "Same-tick submissions must serialize before React rerenders",
  );
  await until(() => ctx.calls.length === 1);
  assert.equal(ctx.calls[0].text, "first");
  await until(
    () =>
      ctx.window.document.querySelectorAll(".roman-queued-message").length ===
      2,
  );
  assert.deepEqual(
    [...ctx.window.document.querySelectorAll(".roman-queued-message p")].map(
      (node) => node.textContent,
    ),
    ["second", "third"],
  );
  ctx.calls[0].accept();
  await until(() => ctx.queue().messages.length === 2);
  await delay(20);
  assert.equal(ctx.calls.length, 1);
  ctx.finish();
  await until(() => ctx.calls.length === 2);
  assert.equal(ctx.calls[1].text, "second");
  ctx.calls[1].accept();
  await until(() => ctx.queue().messages.length === 1);
  ctx.finish();
  await until(() => ctx.calls.length === 3);
  assert.equal(ctx.calls[2].text, "third");
});

test("failed submissions remain visible and pause later messages until an explicit retry", async (t) => {
  const ctx = await setup(t);
  ctx.queue().enqueue("keep my original request");
  ctx.queue().enqueue("then this one");
  await until(() => ctx.calls.length === 1);
  ctx.calls[0].fail();
  await until(() => ctx.queue().messages[0]?.status === "failed");
  ctx.update({ error: null });
  await delay(20);
  assert.equal(
    ctx.calls.length,
    1,
    "poll recovery must not replay a failed POST",
  );
  ctx.queue().retry(ctx.queue().messages[0].id);
  await until(() => ctx.calls.length === 2);
  assert.equal(ctx.calls[1].text, "keep my original request");
  ctx.calls[1].accept();
  await until(() => ctx.queue().messages.length === 1);
  ctx.finish();
  await until(() => ctx.calls.length === 3);
  assert.equal(ctx.calls[2].text, "then this one");
});

test("queue is bounded and supports removing only unsent messages", async (t) => {
  const ctx = await setup(t, { pending: true });
  for (let i = 0; i < 5; i++) ctx.queue().enqueue(`message ${i}`);
  assert.throws(() => ctx.queue().enqueue("sixth"), /five messages/);
  await until(() => ctx.queue().messages.length === 5);
  ctx.queue().remove(ctx.queue().messages[2].id);
  await until(() => ctx.queue().messages.length === 4);
  ctx.update({ pending: false });
  await until(() => ctx.calls.length === 1);
  ctx.queue().remove(ctx.queue().messages[0].id);
  await delay(20);
  assert.equal(ctx.queue().messages.length, 4);
  assert.equal(ctx.queue().messages[0].status, "sending");
});

test("a new conversation discards old queued intent and ignores late send completion", async (t) => {
  const ctx = await setup(t);
  ctx.queue().enqueue("old current");
  ctx.queue().enqueue("old queued");
  await until(() => ctx.calls.length === 1);
  ctx.update({ conversation: null, pending: false });
  await until(() => ctx.queue().messages.length === 0);
  ctx.calls[0].fail();
  await delay(20);
  assert.equal(ctx.queue().messages.length, 0);
  assert.equal(ctx.calls.length, 1);
});

test("bootstrap creating the first conversation keeps queued follow-ups", async (t) => {
  const ctx = await setup(t, { conversation: null });
  ctx.queue().enqueue("first");
  ctx.queue().enqueue("follow-up");
  await until(() => ctx.calls.length === 1);
  ctx.update({
    conversation: { id: "new-chat", status: "active", busy: true },
  });
  ctx.calls[0].accept();
  await until(() => ctx.queue().messages.length === 1);
  ctx.finish();
  await until(() => ctx.calls.length === 2);
  assert.equal(ctx.calls[1].text, "follow-up");
});

test("end-chat review pauses the queue, cancelling review resumes it, successful end clears it", async (t) => {
  const ctx = await setup(t, { pending: true });
  ctx.queue().enqueue("queued");
  ctx.window.pauseQueue(true);
  await delay(20);
  ctx.update({ pending: false });
  await delay(20);
  assert.equal(ctx.calls.length, 0);
  ctx.window.pauseQueue(false);
  await until(() => ctx.calls.length === 1);
  ctx.queue().clear();
  await until(() => ctx.queue().messages.length === 0);
});

test("local voice uses the same client input path without ending voice", async (t) => {
  for (const status of ["starting", "active"]) {
    await t.test(status, async (t) => {
      const ctx = await setup(t, {
        voice: { status, muted: false, error: null },
      });
      ctx.queue().enqueue("typed while voice is on");
      await until(() => ctx.calls.length === 1);
      assert.equal(ctx.calls[0].text, "typed while voice is on");
    });
  }
});

test("restoration, remote voice and stopping voice defer dispatch while keeping the draft queued", async (t) => {
  for (const overrides of [
    { restoring: true },
    { voice: { status: "stopping", muted: true, error: null } },
    {
      conversation: {
        id: "chat-1",
        status: "active",
        busy: false,
        voice: { status: "active" },
      },
    },
  ]) {
    await t.test(JSON.stringify(overrides), async (t) => {
      const ctx = await setup(t, overrides);
      ctx.queue().enqueue("wait here");
      await until(() => ctx.queue().messages.length === 1);
      await delay(20);
      assert.equal(ctx.calls.length, 0);
      ctx.update({
        restoring: false,
        voice: { status: "idle", muted: false, error: null },
        conversation: { id: "chat-1", status: "active", busy: false },
      });
      await until(() => ctx.calls.length === 1);
    });
  }
});
