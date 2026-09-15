/* global globalThis */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { voiceMedia } from "./helpers/voice-media.mjs";

const bundle = await build({
  entryPoints: ["frontend/src/session/client.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanSession",
  platform: "browser",
});

const conversationId = "11111111-1111-4111-8111-111111111111";
const access = {
  conversationId,
  token: "a".repeat(43),
  expiresAt: "2099-09-15T10:00:00Z",
  apiBaseUrl: "https://roman.example/api/conversations",
};
const empty = {
  id: conversationId,
  messages: [],
  busy: false,
  status: "active",
  revision: 0,
  tools: [],
};
const pending = {
  status: "active",
  revision: 1,
  tools: [],
  id: conversationId,
  busy: true,
  messages: [
    {
      id: "user-message",
      role: "user",
      status: "complete",
      parts: [{ type: "text", text: "Hello" }],
      createdAt: "2026-09-15T10:00:00Z",
    },
    {
      id: "assistant-message",
      role: "assistant",
      status: "pending",
      parts: [],
      createdAt: "2026-09-15T10:00:00Z",
    },
  ],
};
const complete = {
  ...pending,
  revision: 2,
  busy: false,
  messages: [
    pending.messages[0],
    {
      ...pending.messages[1],
      status: "complete",
      parts: [{ type: "text", text: "Hello from Roman." }],
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

function setup(
  t,
  {
    saved,
    url = "https://hd-dev-single.myshopify.com/",
    executor,
    mediaOptions,
    savedVoice,
    holdReady = false,
  } = {},
) {
  const dom = new JSDOM("<!doctype html>", { url, runScripts: "outside-only" });
  const { window } = dom;
  const media = mediaOptions ? voiceMedia(window, mediaOptions) : undefined;
  // Use the browser-standard AbortSignal.any/timeout behavior available in Node;
  // JSDOM's subset need not implement these transport primitives itself.
  window.AbortController = globalThis.AbortController;
  window.AbortSignal = globalThis.AbortSignal;
  if (saved)
    window.sessionStorage.setItem("roman:conversation", JSON.stringify(saved));
  if (savedVoice !== undefined)
    window.sessionStorage.setItem("roman:voice", savedVoice);
  const calls = [];
  const readyCalls = [];
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, ms) => {
    const id = ++nextTimer;
    timers.set(id, { callback, ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call = {
        url: String(url),
        init,
        body: init.body ? JSON.parse(init.body) : undefined,
        resolve,
        reject,
      };
      if (String(url).endsWith("/ready")) {
        readyCalls.push(call);
        if (!holdReady) finish(call, { ok: true });
      } else calls.push(call);
    });
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanSession = RomanSession;`,
  );
  const client = window.RomanSession.createConversationClient(executor);
  let notifications = 0;
  client.subscribe(() => {
    notifications++;
  });
  t.after(() => {
    client.dispose();
    window.close();
  });
  function finish(call, body, status = 200) {
    if (call.init.method === "GET" && body?.id && Array.isArray(body.messages))
      body = { streamRevision: 0, ...body };
    call.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
    });
  }
  function respond(index, body, status = 200) {
    finish(calls[index], body, status);
  }
  function tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
  }
  return {
    client,
    media,
    window,
    calls,
    readyCalls,
    timers,
    respond,
    respondReady: (index, body, status = 200) =>
      finish(readyCalls[index], body, status),
    tick,
    notifications: () => notifications,
  };
}

test("session creation is lazy and first send uses the signed proxy then the authorized backend", async (t) => {
  const ctx = setup(t);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.client.getSnapshot().conversation, null);
  const sending = ctx.client.sendMessage(" Hello ");
  assert.equal(ctx.calls.length, 1);
  assert.equal(
    ctx.calls[0].url,
    "https://hd-dev-single.myshopify.com/apps/roman/bootstrap?storefront_origin=https%3A%2F%2Fhd-dev-single.myshopify.com",
  );
  assert.equal(ctx.calls[0].init.credentials, "same-origin");
  assert.equal(ctx.calls[0].init.mode, "same-origin");
  assert.equal(ctx.calls[0].init.redirect, "error");
  assert.deepEqual(ctx.calls[0].body, {});
  ctx.respond(0, { ...access, conversation: empty });
  await until(
    () => ctx.calls.length === 2,
    "First message was not sent after bootstrap",
  );
  assert.equal(
    ctx.calls[1].url,
    `${access.apiBaseUrl}/${conversationId}/messages`,
  );
  assert.equal(ctx.calls[1].init.credentials, "omit");
  assert.equal(ctx.calls[1].init.mode, "cors");
  assert.equal(
    ctx.calls[1].init.headers.Authorization,
    `Bearer ${access.token}`,
  );
  assert.equal(ctx.calls[1].body.text, "Hello");
  assert.match(ctx.calls[1].body.requestId, /^[0-9a-f-]{36}$/);
  ctx.respond(1, pending);
  await sending;
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().conversation.busy, true);
  assert.equal(ctx.timers.size, 1);
  assert.equal(
    JSON.parse(ctx.window.sessionStorage.getItem("roman:conversation"))
      .conversationId,
    conversationId,
  );
});

test("resumption verifies through the signed proxy and adopts its current backend origin", async (t) => {
  const old = {
    ...access,
    apiBaseUrl: "https://old-tunnel.example/api/conversations",
  };
  const ctx = setup(t, { saved: old });
  assert.equal(ctx.client.getSnapshot().restoring, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(
    ctx.calls[0].url,
    "https://hd-dev-single.myshopify.com/apps/roman/bootstrap?storefront_origin=https%3A%2F%2Fhd-dev-single.myshopify.com",
  );
  assert.deepEqual(ctx.calls[0].body, { conversationId, token: access.token });
  ctx.respond(0, { ...access, conversation: complete });
  await until(
    () => ctx.calls.length === 2,
    "Resume did not read the conversation",
  );
  assert.equal(ctx.calls[1].url, `${access.apiBaseUrl}/${conversationId}`);
  assert.ok(ctx.calls.every((call) => !call.url.includes("old-tunnel")));
  ctx.respond(1, complete);
  await until(
    () => !ctx.client.getSnapshot().restoring,
    "Resume never settled",
  );
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[1].parts[0].text,
    "Hello from Roman.",
  );
  assert.equal(ctx.timers.size, 0);
});

test("unchanged polls retain state identity and notifications while later partial text advances", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  const initial = ctx.client.getSnapshot();
  const notifications = ctx.notifications();
  ctx.client.clearError();
  assert.equal(ctx.notifications(), notifications);
  for (let index = 0; index < 10; index++) {
    ctx.tick();
    const call = ctx.calls.length - 1;
    assert.match(ctx.calls[call].url, /\?revision=1&streamRevision=0$/);
    ctx.respond(call, {
      id: conversationId,
      revision: 1,
      streamRevision: 0,
      unchanged: true,
    });
    await until(
      () => ctx.timers.size === 1,
      "Unchanged poll did not reschedule",
    );
    assert.equal(ctx.client.getSnapshot(), initial);
    assert.equal(ctx.notifications(), notifications);
  }
  ctx.tick();
  ctx.respond(ctx.calls.length - 1, {
    ...pending,
    streamRevision: 1,
    messages: [
      pending.messages[0],
      {
        ...pending.messages[1],
        parts: [{ type: "text", text: "A streamed answer" }],
      },
    ],
  });
  await until(
    () => ctx.client.getSnapshot().conversation.messages[1].parts.length > 0,
    "Partial text was dropped",
  );
  assert.equal(ctx.client.getSnapshot().conversation.revision, 1);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[1].parts[0].text,
    "A streamed answer",
  );
  const advanced = ctx.client.getSnapshot();
  const page = ctx.client.recordPage({
    title: "Home",
    path: "/",
    occurredAt: "2026-09-15T12:00:00Z",
  });
  await until(
    () => ctx.calls.at(-1).url.endsWith("/journey"),
    "Journey did not start",
  );
  ctx.respond(ctx.calls.length - 1, pending);
  await page;
  assert.equal(
    ctx.client.getSnapshot(),
    advanced,
    "an equal durable-only response must not erase partial text",
  );
});

test("stale unchanged responses cannot override a newer durable mutation", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  ctx.tick();
  const read = ctx.calls.length - 1;
  const page = ctx.client.recordPage({
    title: "Home",
    path: "/",
    occurredAt: "2026-09-15T12:00:00Z",
  });
  await until(
    () => ctx.calls.at(-1).url.endsWith("/journey"),
    "Journey did not start",
  );
  ctx.respond(ctx.calls.length - 1, { ...pending, revision: 2 });
  await page;
  const current = ctx.client.getSnapshot();
  ctx.respond(read, {
    id: conversationId,
    revision: 1,
    streamRevision: 0,
    unchanged: true,
  });
  await until(() => ctx.timers.size === 1, "Poll did not finish");
  assert.equal(ctx.client.getSnapshot(), current);
  ctx.tick();
  assert.equal(
    ctx.calls.at(-1).url,
    `${access.apiBaseUrl}/${conversationId}`,
    "a mutation invalidates the last GET version",
  );
});

test("unsolicited or mismatched unchanged responses are rejected", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  ctx.tick();
  ctx.respond(ctx.calls.length - 1, {
    id: conversationId,
    revision: 1,
    streamRevision: 999,
    unchanged: true,
  });
  await until(
    () => ctx.client.getSnapshot().error,
    "Invalid version was accepted",
  );
  assert.match(ctx.client.getSnapshot().error, /invalid conversation version/);
  assert.equal(ctx.client.getSnapshot().conversation.revision, 1);
});

test("pending replies poll until completion and release their timer", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.respond(0, { ...access, conversation: pending });
  await until(() => ctx.calls.length === 2, "Resume read did not start");
  ctx.respond(1, pending);
  await until(
    () => ctx.timers.size === 1,
    "Pending reply did not schedule polling",
  );
  ctx.tick();
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.calls[2].init.method, "GET");
  ctx.respond(2, complete);
  await until(
    () => !ctx.client.getSnapshot().conversation.busy,
    "Completed reply was not applied",
  );
  assert.equal(ctx.timers.size, 0);
});

test("a lost POST reconciles without replay and an explicit identical retry keeps its request ID", async (t) => {
  const ctx = setup(t);
  const first = ctx.client.sendMessage("Hello");
  const failed = assert.rejects(first, /could not connect/);
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "POST was not sent");
  const requestId = ctx.calls[1].body.requestId;
  ctx.calls[1].reject(new TypeError("Connection lost"));
  await until(() => ctx.calls.length === 3, "Lost response was not reconciled");
  assert.equal(ctx.calls[2].init.method, "GET");
  ctx.respond(2, empty);
  await failed;
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  const retry = ctx.client.sendMessage("Hello");
  await until(() => ctx.calls.length === 4, "Explicit retry was not sent");
  assert.equal(ctx.calls[3].body.requestId, requestId);
  ctx.respond(3, pending);
  await retry;
});

test("disposal aborts the request and does not publish late bootstrap data", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  const rejected = assert.rejects(sending, /removed/);
  ctx.client.dispose();
  const notifications = ctx.notifications();
  assert.equal(ctx.calls[0].init.signal.aborted, true);
  ctx.respond(0, { ...access, conversation: empty });
  await rejected;
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.notifications(), notifications);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
  assert.equal(ctx.timers.size, 0);
});

test("disposing an active message does not start a reconciliation request after disposal", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  const rejected = assert.rejects(sending, /removed/);
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "POST did not start");
  ctx.client.dispose();
  const notifications = ctx.notifications();
  assert.equal(ctx.calls[1].init.signal.aborted, true);
  ctx.respond(1, pending);
  await delay(0);
  // Resolve any forbidden extra fetch to keep a failing test from hanging.
  if (ctx.calls.length > 2) ctx.respond(2, pending);
  await rejected;
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.notifications(), notifications);
});

test("repeated connection retries do not overlap an in-flight poll", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.respond(0, { ...access, conversation: pending });
  await until(() => ctx.calls.length === 2, "Resume read did not start");
  ctx.respond(1, pending);
  await until(() => ctx.timers.size === 1, "Polling was not scheduled");
  ctx.tick();
  assert.equal(ctx.calls.length, 3);
  ctx.client.clearError();
  ctx.client.clearError();
  assert.equal(
    ctx.calls.length,
    3,
    "Retry started competing snapshot requests",
  );
  ctx.respond(2, complete);
  await until(
    () => !ctx.client.getSnapshot().conversation.busy,
    "Polling did not finish",
  );
});

test("local preview and invalid input fail before session creation", async (t) => {
  const ctx = setup(t, { url: "http://127.0.0.1:5173/" });
  await assert.rejects(
    ctx.client.sendMessage("Hello"),
    /installed development storefronts/,
  );
  assert.equal(ctx.calls.length, 0);
  const store = setup(t);
  for (const text of [" ", "x".repeat(4001)])
    await assert.rejects(
      store.client.sendMessage(text),
      /up to 4000 characters/,
    );
  assert.equal(store.calls.length, 0);
});

test("the installed custom storefront can bootstrap text and an explicit voice connection", async (t) => {
  const url = "https://shopify-single-dev.hdecom.com/";
  const text = setup(t, { url });
  const sending = text.client.sendMessage("Hello");
  const expectedBootstrap = `${url}apps/roman/bootstrap?storefront_origin=https%3A%2F%2Fshopify-single-dev.hdecom.com`;
  assert.equal(text.calls[0].url, expectedBootstrap);
  text.respond(0, { ...access, conversation: empty });
  await until(
    () => text.calls.length === 2,
    "Custom storefront did not send text",
  );
  text.respond(1, pending);
  await sending;
  const voice = setup(t, { url, mediaOptions: {} });
  await activeVoice(voice);
  assert.equal(voice.calls[0].url, expectedBootstrap);
  assert.equal(voice.client.getSnapshot().voice.status, "active");
});

test("unsupported origins cannot request a microphone or create conversations", async (t) => {
  for (const url of [
    "http://127.0.0.1:5173/",
    "https://uninstalled.myshopify.com/",
    "https://shopify-single-dev.hdecom.com.example.com/",
  ]) {
    const ctx = setup(t, { url, mediaOptions: {} });
    await assert.rejects(
      ctx.client.startVoice(),
      /installed development storefronts/,
    );
    await assert.rejects(
      ctx.client.sendMessage("Hello"),
      /installed development storefronts/,
    );
    assert.equal(ctx.media.calls.microphone, 0);
    assert.equal(ctx.calls.length, 0);
  }
});

test("an older refresh cannot replace a newer accepted message snapshot", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.respond(0, { ...access, conversation: complete });
  await until(() => ctx.calls.length === 2, "Resume read did not start");
  ctx.respond(1, complete);
  await until(
    () => !ctx.client.getSnapshot().restoring,
    "Resume did not settle",
  );
  ctx.client.clearError();
  assert.equal(ctx.calls.length, 3);
  const sending = ctx.client.sendMessage("A new question");
  await until(() => ctx.calls.length === 4, "New question was not sent");
  const newer = {
    ...pending,
    revision: 3,
    messages: [
      ...complete.messages,
      {
        ...pending.messages[0],
        id: "new-user",
        parts: [{ type: "text", text: "A new question" }],
      },
      { ...pending.messages[1], id: "new-assistant" },
    ],
  };
  ctx.respond(3, newer);
  await sending;
  ctx.respond(2, complete);
  await delay(0);
  assert.equal(ctx.client.getSnapshot().conversation.busy, true);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages.at(-2).id,
    "new-user",
  );
  assert.equal(ctx.timers.size, 1);
});

const invocationId = "22222222-2222-4222-8222-222222222222";
const catalogResult = {
  products: [
    {
      id: "gid://shopify/Product/123",
      title: "Current shade",
      description: "",
      url: "https://hd-dev-single.myshopify.com/products/shade",
    },
  ],
  messages: [],
};
const needsTool = {
  ...pending,
  tools: [
    {
      id: invocationId,
      name: "search_products",
      arguments: { query: "no drill" },
      status: "pending",
    },
  ],
};
const needsNavigation = {
  ...needsTool,
  tools: [
    { ...needsTool.tools[0], name: "navigate", arguments: { path: "/cart" } },
  ],
};
const navigationResult = { status: "navigated", path: "/cart" };

async function resume(ctx, value = complete) {
  ctx.respond(0, { ...access, conversation: value });
  await until(() => ctx.calls.length >= 2, "Resume read did not start");
  ctx.respond(1, value);
  await until(
    () => !ctx.client.getSnapshot().restoring,
    "Resume did not settle",
  );
}

test("only a tab granted the tool claim executes the catalog command", async (t) => {
  const executions = [];
  const first = setup(t, {
    saved: access,
    executor: {
      execute: async (...args) => {
        executions.push(["first", ...args]);
        return catalogResult;
      },
    },
  });
  const second = setup(t, {
    saved: access,
    executor: {
      execute: async (...args) => {
        executions.push(["second", ...args]);
        return catalogResult;
      },
    },
  });
  await Promise.all([resume(first, needsTool), resume(second, needsTool)]);
  await until(
    () => first.calls.length === 3 && second.calls.length === 3,
    "Both tabs did not request claims",
  );
  assert.match(first.calls[2].url, new RegExp(`/tools/${invocationId}/claim$`));
  assert.match(first.calls[2].body.claimToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.calls[2].body.clientId, second.calls[2].body.clientId);
  first.respond(2, { claimed: true });
  second.respond(2, { claimed: false });
  await until(
    () => first.calls.length === 4,
    "The winning tab did not submit its result",
  );
  assert.equal(executions.length, 1);
  assert.equal(executions[0][0], "first");
  assert.equal(executions[0][1], "search_products");
  assert.deepEqual(JSON.parse(JSON.stringify(executions[0][2])), {
    query: "no drill",
  });
  assert.equal(second.calls.length, 3);
  first.respond(3, complete);
  await until(
    () => !first.client.getSnapshot().conversation.busy,
    "Catalog result did not settle",
  );
});

test("a lost tool-result response retries the same result without reexecuting or claiming again", async (t) => {
  for (const [snapshot, result] of [
    [needsTool, catalogResult],
    [needsNavigation, navigationResult],
  ]) {
    await t.test(snapshot.tools[0].name, async (t) => {
      let executions = 0;
      const ctx = setup(t, {
        saved: access,
        executor: {
          execute: async (name, args, signal) => {
            assert.equal(name, snapshot.tools[0].name);
            assert.deepEqual(
              JSON.parse(JSON.stringify(args)),
              snapshot.tools[0].arguments,
            );
            assert.equal(signal.aborted, false);
            executions++;
            return result;
          },
        },
      });
      await resume(ctx, snapshot);
      await until(() => ctx.calls.length === 3, "Tool claim did not start");
      ctx.respond(2, { claimed: true });
      await until(() => ctx.calls.length === 4, "Tool result did not start");
      const original = ctx.calls[3].body;
      assert.deepEqual(original.result, result);
      ctx.calls[3].reject(new TypeError("Lost result response"));
      await until(
        () => !!ctx.client.getSnapshot().error,
        "Lost result was not surfaced",
      );
      assert.equal(executions, 1);
      ctx.tick();
      await until(() => ctx.calls.length === 5, "Pending tool was not polled");
      ctx.respond(4, {
        ...snapshot,
        revision: 2,
        tools: [{ ...snapshot.tools[0], status: "running" }],
      });
      await until(
        () => ctx.calls.length === 6,
        "Stored tool result was not retried",
      );
      assert.deepEqual(ctx.calls[5].body, original);
      assert.match(ctx.calls[5].url, /\/result$/);
      assert.equal(executions, 1);
      assert.equal(
        ctx.calls.filter((call) => call.url.endsWith("/claim")).length,
        1,
      );
      ctx.respond(5, { ...complete, revision: 3 });
      await until(
        () => !ctx.client.getSnapshot().conversation.busy,
        "Retried result did not finish",
      );
    });
  }
});

test("a refreshed client never claims or repeats navigation already running in the previous page", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: () =>
        assert.fail("Previously claimed navigation must not replay"),
    },
  });
  const running = {
    ...needsNavigation,
    tools: [{ ...needsNavigation.tools[0], status: "running" }],
  };
  await resume(ctx, running);
  assert.equal(ctx.calls.length, 2);
  ctx.tick();
  await until(
    () => ctx.calls.length === 3,
    "Pending conversation was not polled",
  );
  ctx.respond(2, running);
  await delay(0);
  assert.equal(
    ctx.calls.filter((call) => /\/(claim|result)$/.test(call.url)).length,
    0,
  );
});

test("the first observed page is durably queued before the first customer message", async (t) => {
  const ctx = setup(t);
  let observed = false;
  let visit;
  ctx.client.subscribe(() => {
    if (!observed && ctx.client.getSnapshot().conversation) {
      observed = true;
      visit = ctx.client.recordPage({
        title: "No drill shades",
        path: "/collections/no-drill",
        occurredAt: "2026-09-15T12:00:00Z",
      });
    }
  });
  const sending = ctx.client.sendMessage(
    "Which of these works without drilling?",
  );
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Page visit was not submitted");
  assert.match(ctx.calls[1].url, /\/journey$/);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/messages")).length,
    0,
  );
  const withPage = {
    ...empty,
    revision: 1,
    messages: [
      {
        id: "page-observation",
        role: "context",
        status: "complete",
        createdAt: "2026-09-15T12:00:00Z",
        parts: [
          {
            type: "page_view",
            version: 1,
            title: "No drill shades",
            path: "/collections/no-drill",
            occurredAt: "2026-09-15T12:00:00Z",
          },
        ],
      },
    ],
  };
  ctx.respond(1, withPage);
  await visit;
  await until(
    () => ctx.calls.length === 3,
    "Message did not follow the page observation",
  );
  assert.match(ctx.calls[2].url, /\/messages$/);
  ctx.respond(2, {
    ...pending,
    revision: 2,
    messages: [...withPage.messages, ...pending.messages],
  });
  await sending;
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[0].role,
    "context",
  );
});

test("End keeps the current chat on failure and clears it only after server acknowledgement", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx);
  const ending = ctx.client.end();
  const failed = assert.rejects(ending, /Temporary failure/);
  assert.equal(ctx.client.getSnapshot().pending, true);
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.ok(ctx.window.sessionStorage.getItem("roman:conversation"));
  ctx.respond(2, { error: { message: "Temporary failure" } }, 500);
  await failed;
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.ok(ctx.window.sessionStorage.getItem("roman:conversation"));
  assert.match(ctx.client.getSnapshot().error, /could not end/);
  const retry = ctx.client.end();
  ctx.respond(3, { ...complete, status: "ended", revision: 3 });
  await retry;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
  assert.equal(ctx.timers.size, 0);
});

test("BFCache restoration clears an old session when its tab credential was removed", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  ctx.window.sessionStorage.removeItem("roman:conversation");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.timers.size, 0);
  assert.equal(ctx.calls.length, 2);
});

test("a cleared BFCache credential cannot be recreated by a late bootstrap response", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.window.sessionStorage.removeItem("roman:conversation");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  ctx.respond(0, { ...access, conversation: complete });
  await delay(0);
  // Resolve forbidden follow-on work so a failing test does not leave it pending.
  if (ctx.calls[1]) ctx.respond(1, complete);
  await delay(0);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.calls.length, 1);
});

test("a newer request cannot overwrite a snapshot with a lower durable revision", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, { ...complete, revision: 5 });
  ctx.client.clearError();
  ctx.respond(2, { ...pending, revision: 4 });
  await delay(0);
  assert.equal(ctx.client.getSnapshot().conversation.revision, 5);
  assert.equal(ctx.client.getSnapshot().conversation.busy, false);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[1].parts[0].text,
    "Hello from Roman.",
  );
});

test("End cancels browser tools and prevents late results from entering the closed chat", async (t) => {
  for (const [snapshot, result] of [
    [needsTool, catalogResult],
    [needsNavigation, navigationResult],
  ]) {
    await t.test(snapshot.tools[0].name, async (t) => {
      let resolveLookup;
      let toolSignal;
      const ctx = setup(t, {
        saved: access,
        executor: {
          execute: (_name, _args, signal) =>
            new Promise((resolve) => {
              toolSignal = signal;
              resolveLookup = resolve;
            }),
        },
      });
      await resume(ctx, snapshot);
      await until(() => ctx.calls.length === 3, "Tool claim did not start");
      ctx.respond(2, { claimed: true });
      await until(() => !!resolveLookup, "Catalog execution did not start");
      const ending = ctx.client.end();
      assert.equal(toolSignal.aborted, true);
      assert.match(ctx.calls[3].url, /\/end$/);
      ctx.respond(3, { ...complete, status: "ended", revision: 3 });
      await ending;
      resolveLookup(result);
      await delay(0);
      assert.equal(
        ctx.calls.filter((call) => call.url.endsWith("/result")).length,
        0,
      );
      assert.equal(ctx.client.getSnapshot().conversation, null);
      assert.equal(
        ctx.window.sessionStorage.getItem("roman:conversation"),
        null,
      );
    });
  }
});

test("a late poll after End cannot restore the old conversation or display a stale error", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx);
  ctx.client.clearError();
  assert.equal(ctx.calls.length, 3);
  const ending = ctx.client.end();
  ctx.respond(3, { ...complete, status: "ended", revision: 3 });
  await ending;
  ctx.respond(2, complete);
  await delay(0);
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.equal(ctx.timers.size, 0);
});

async function activeVoice(ctx) {
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "Voice did not bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Voice offer was not sent");
  const request = ctx.calls[1];
  assert.match(request.url, /\/voice$/);
  assert.equal(request.init.headers.Authorization, `Bearer ${access.token}`);
  assert.match(request.body.sdp, /roman-offer/);
  assert.equal(request.body.voice, ctx.client.getSnapshot().selectedVoice);
  const voice = {
    id: request.body.requestId,
    clientId: request.body.clientId,
    status: "active",
  };
  ctx.respond(1, { voiceId: voice.id, sdp: "v=0\r\no=roman-answer" });
  await until(
    () => !!ctx.media.peers[0].remoteDescription,
    "Voice answer was not applied",
  );
  ctx.media.connect();
  await starting;
  assert.equal(ctx.readyCalls.length, 1);
  assert.match(ctx.readyCalls[0].url, new RegExp(`/voice/${voice.id}/ready$`));
  assert.equal(ctx.readyCalls[0].body.clientId, voice.clientId);
  assert.equal(
    ctx.readyCalls[0].init.headers.Authorization,
    `Bearer ${access.token}`,
  );
  await until(
    () => ctx.calls.length === 3,
    "Active voice did not refresh the transcript",
  );
  ctx.respond(2, { ...empty, revision: 1, voice });
  await delay(0);
  return voice;
}

test("microphone denial creates no conversation or API request", async (t) => {
  const ctx = setup(t, {
    mediaOptions: { getUserMedia: () => Promise.reject(new Error("denied")) },
  });
  await assert.rejects(ctx.client.startVoice(), /Allow microphone/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().voice.status, "error");
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
});

test("voice starts explicitly, polls while idle, heartbeats, and drains before text is allowed", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  assert.equal(ctx.media.calls.microphone, 0);
  const voice = await activeVoice(ctx);
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.ok([...ctx.timers.values()].some((timer) => timer.ms === 500));
  const [heartbeatId, heartbeat] = [...ctx.timers].find(
    ([, timer]) => timer.ms === 20_000,
  );
  ctx.timers.delete(heartbeatId);
  heartbeat.callback();
  assert.match(ctx.calls[3].url, new RegExp(`/voice/${voice.id}/heartbeat$`));
  assert.equal(ctx.calls[3].body.clientId, voice.clientId);
  ctx.respond(3, { ok: true });
  await delay(0);
  assert.ok([...ctx.timers.values()].some((timer) => timer.ms === 20_000));
  await assert.rejects(
    ctx.client.sendMessage("Hello in text"),
    /current reply/,
  );
  ctx.client.setVoiceMuted(true);
  assert.equal(ctx.media.tracks[0].enabled, false);
  assert.equal(ctx.client.getSnapshot().voice.muted, true);
  const stopping = ctx.client.stopVoice();
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.equal(ctx.client.getSnapshot().voice.status, "stopping");
  await assert.rejects(
    ctx.client.sendMessage("Hello in text"),
    /current reply/,
  );
  ctx.respond(4, {
    ...empty,
    revision: 2,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(ctx.timers.size, 0);
  const sending = ctx.client.sendMessage("Hello in text");
  await until(() => ctx.calls.length === 6, "Text did not resume after voice");
  assert.match(ctx.calls[5].url, /\/messages$/);
  ctx.respond(5, { ...pending, revision: 3 });
  await sending;
});

test("voice restoration never reacquires a microphone and explicitly stops the previous lease", async (t) => {
  const voice = {
    id: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    status: "active",
  };
  const caption = {
    id: "caption",
    role: "user",
    status: "complete",
    createdAt: "2026-09-15T10:00:00Z",
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: voice.id,
        text: "My kitchen",
        startMs: 0.25,
        endMs: 1_500.75,
      },
    ],
  };
  const restored = { ...empty, voice, revision: 4, messages: [caption] };
  const ctx = setup(t, { saved: access, mediaOptions: {} });
  await resume(ctx, restored);
  assert.equal(ctx.media.calls.microphone, 0);
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[0].parts[0].text,
    "My kitchen",
  );
  await assert.rejects(ctx.client.startVoice(), /current session/);
  const stopping = ctx.client.stopVoice();
  assert.equal(ctx.calls[2].body.clientId, voice.clientId);
  assert.match(ctx.calls[2].url, new RegExp(`/voice/${voice.id}/stop$`));
  ctx.respond(2, {
    ...restored,
    revision: 5,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  assert.equal(ctx.media.calls.microphone, 0);
  assert.equal(ctx.timers.size, 0);
});

test("stopping a pending start releases late media and never sends the offer", async (t) => {
  let allow;
  const ctx = setup(t, {
    mediaOptions: {
      getUserMedia: (stream) =>
        new Promise((resolve) => {
          allow = () => resolve(stream);
        }),
    },
  });
  const starting = ctx.client.startVoice();
  await ctx.client.stopVoice();
  allow();
  await starting;
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.media.tracks[0].stopped, true);
});

test("a lost start response is stopped with its known ID and is not retried", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "Missing bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Missing start request");
  const id = ctx.calls[1].body.requestId;
  ctx.calls[1].reject(new Error("response lost"));
  await until(
    () => ctx.calls.length === 3,
    "Lost start did not stop its lease",
  );
  assert.match(ctx.calls[2].url, new RegExp(`/voice/${id}/stop$`));
  ctx.respond(2, {
    ...empty,
    revision: 2,
    voice: { id, clientId: ctx.calls[1].body.clientId, status: "closed" },
  });
  await assert.rejects(starting, /could not connect/);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/voice")).length,
    1,
  );
  assert.equal(ctx.media.tracks[0].stopped, true);
});

test("page exit immediately stops media and sends a keepalive stop without rejoining on pageshow", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx);
  ctx.window.dispatchEvent(new ctx.window.PageTransitionEvent("pagehide"));
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.equal(ctx.media.peers[0].closed, true);
  const stop = ctx.calls[3];
  assert.equal(stop.init.keepalive, true);
  assert.match(stop.url, new RegExp(`/voice/${voice.id}/stop$`));
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
});

test("server voice failure tears down an active connection while retaining the transcript", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx);
  const [id, poll] = [...ctx.timers].find(([, timer]) => timer.ms === 500);
  ctx.timers.delete(id);
  poll.callback();
  ctx.respond(3, {
    ...empty,
    revision: 2,
    voice: { ...voice, status: "failed", error: "Voice was interrupted." },
  });
  await until(
    () => ctx.client.getSnapshot().voice.status === "error",
    "Server failure was not observed",
  );
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.equal(ctx.media.peers[0].closed, true);
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.equal(ctx.timers.size, 0);
});

test("Stop voice cancels claimed navigation and ignores its late outcome", async (t) => {
  let resolveNavigation;
  let navigationSignal;
  const ctx = setup(t, {
    mediaOptions: {},
    executor: {
      execute: (_name, _arguments, signal) =>
        new Promise((resolve) => {
          resolveNavigation = resolve;
          navigationSignal = signal;
        }),
    },
  });
  const voice = await activeVoice(ctx);
  const [timerId, poll] = [...ctx.timers].find(([, timer]) => timer.ms === 500);
  ctx.timers.delete(timerId);
  poll.callback();
  const tool = {
    id: "44444444-4444-4444-8444-444444444444",
    name: "navigate",
    arguments: { path: "/cart" },
    status: "pending",
  };
  ctx.respond(3, { ...empty, revision: 2, voice, tools: [tool] });
  await until(() => ctx.calls.length === 5, "Voice tool was not claimed");
  ctx.respond(4, { claimed: true });
  await until(() => !!resolveNavigation, "Claimed navigation did not execute");
  const stopping = ctx.client.stopVoice();
  assert.equal(navigationSignal.aborted, true);
  ctx.respond(5, {
    ...empty,
    revision: 3,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  resolveNavigation({ status: "navigated", path: "/cart" });
  await delay(0);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/result")).length,
    0,
  );
});

test("an offer response arriving after cancellation cannot reopen its peer", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "Missing bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Missing offer");
  const voice = {
    id: ctx.calls[1].body.requestId,
    clientId: ctx.calls[1].body.clientId,
    status: "closed",
  };
  const stopping = ctx.client.stopVoice();
  ctx.respond(2, { ...empty, revision: 2, voice });
  await stopping;
  ctx.respond(1, { voiceId: voice.id, sdp: "late answer" });
  await starting;
  assert.equal(ctx.media.peers[0].closed, true);
  assert.equal(ctx.media.peers[0].remoteDescription, undefined);
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(ctx.calls[3].init.keepalive, true);
  assert.match(ctx.calls[3].url, new RegExp(`/voice/${voice.id}/stop$`));
});

test("Switch to text preserves a failed finalization warning while allowing typed replies", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx);
  const stopping = ctx.client.stopVoice();
  ctx.respond(3, {
    ...empty,
    revision: 2,
    voice: {
      ...voice,
      status: "failed",
      error: "Some final captions may be missing.",
    },
  });
  await stopping;
  const state = ctx.client.getSnapshot();
  assert.equal(state.voice.status, "error");
  assert.equal(state.voice.muted, false);
  assert.match(state.voice.error, /final captions may be missing/);
  const sending = ctx.client.sendMessage("Continue in text");
  await until(
    () => ctx.calls.length === 5,
    "Failed finalization incorrectly blocked text",
  );
  ctx.respond(4, { ...pending, revision: 3 });
  await sending;
});

test("a capacity-rejected start can cancel an unknown ID and return to text", async (t) => {
  const old = {
    id: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    status: "closed",
  };
  const conversation = { ...empty, revision: 10, voice: old };
  const ctx = setup(t, { saved: access, mediaOptions: {} });
  await resume(ctx, conversation);
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 3, "Voice start was not sent");
  const attemptedId = ctx.calls[2].body.requestId;
  ctx.respond(
    2,
    {
      error: {
        message:
          "This chat has reached its voice session limit. Start a new chat.",
      },
    },
    429,
  );
  await until(() => ctx.calls.length === 4, "Failed start was not cleaned up");
  assert.match(ctx.calls[3].url, new RegExp(`/voice/${attemptedId}/stop$`));
  // At capacity an unknown cancellation is a no-op: a future start is already impossible.
  ctx.respond(3, conversation);
  await assert.rejects(starting, /voice session limit/);
  assert.equal(ctx.client.getSnapshot().voice.muted, false);
  assert.equal(ctx.timers.size, 0);
  const sending = ctx.client.sendMessage("Continue in text");
  await until(
    () => ctx.calls.length === 5,
    "Capacity rejection left text blocked",
  );
  ctx.respond(4, { ...pending, revision: 11 });
  await sending;
});

test("a server correction aborts retired navigation before executing its replacement", async (t) => {
  const executions = [];
  let finishRetired;
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async (_name, arguments_, signal) => {
        executions.push({ path: arguments_.path, signal });
        if (arguments_.path === "/cart")
          return new Promise((resolve) => {
            finishRetired = resolve;
          });
        return { status: "navigated", path: arguments_.path };
      },
    },
  });
  await resume(ctx, needsNavigation);
  await until(() => ctx.calls.length === 3, "First navigation was not claimed");
  ctx.respond(2, { claimed: true });
  await until(() => !!finishRetired, "First navigation did not start");
  const replacementId = "55555555-5555-4555-8555-555555555555";
  const replacement = {
    ...needsNavigation,
    revision: needsNavigation.revision + 1,
    tools: [
      {
        id: replacementId,
        name: "navigate",
        arguments: { path: "/collections/all" },
        status: "pending",
      },
    ],
  };
  ctx.client.clearError();
  ctx.respond(3, replacement);
  await until(
    () => executions[0].signal.aborted,
    "Retired navigation was not aborted by the accepted snapshot",
  );
  finishRetired({ status: "navigated", path: "/cart" });
  await delay(0);
  assert.equal(
    ctx.calls.filter((call) =>
      call.url.endsWith(`/tools/${invocationId}/result`),
    ).length,
    0,
  );
  assert.equal(executions.length, 1);
  ctx.tick();
  ctx.respond(4, replacement);
  await until(
    () => ctx.calls.length === 6,
    "Replacement navigation was not claimed",
  );
  assert.match(ctx.calls[5].url, new RegExp(`/tools/${replacementId}/claim$`));
  ctx.respond(5, { claimed: true });
  await until(
    () => ctx.calls.length === 7,
    "Replacement navigation result was not sent",
  );
  assert.deepEqual(
    executions.map((execution) => execution.path),
    ["/cart", "/collections/all"],
  );
  assert.equal(executions[1].signal.aborted, false);
  assert.match(ctx.calls[6].url, new RegExp(`/tools/${replacementId}/result$`));
  ctx.respond(6, { ...complete, revision: replacement.revision + 1 });
  await until(
    () => !ctx.client.getSnapshot().conversation.busy,
    "Replacement did not finish",
  );
});

test("voice choice defaults to Marin, validates tab preferences and survives ended chat", async (t) => {
  const ctx = setup(t, { saved: access });
  assert.equal(ctx.client.getSnapshot().selectedVoice, "marin");
  ctx.client.setVoice("gleam");
  assert.equal(ctx.window.sessionStorage.getItem("roman:voice"), "gleam");
  await resume(ctx);
  const ending = ctx.client.end();
  ctx.respond(2, { ...complete, status: "ended", revision: 3 });
  await ending;
  assert.equal(ctx.client.getSnapshot().selectedVoice, "gleam");
  assert.equal(ctx.window.sessionStorage.getItem("roman:voice"), "gleam");
  assert.throws(() => ctx.client.setVoice("invented"), /available voices/);
  assert.equal(
    setup(t, { savedVoice: "gleam" }).client.getSnapshot().selectedVoice,
    "gleam",
  );
  assert.equal(
    setup(t, { savedVoice: "willow" }).client.getSnapshot().selectedVoice,
    "willow",
    "A new default must not replace an existing voice preference",
  );
  assert.equal(
    setup(t, { savedVoice: "invented" }).client.getSnapshot().selectedVoice,
    "marin",
  );
});

test("selected voice is fixed during startup and active media, then can change after stop", async (t) => {
  const ctx = setup(t, { mediaOptions: {}, savedVoice: "gleam" });
  const activating = activeVoice(ctx);
  assert.throws(() => ctx.client.setVoice("willow"), /Switch to text/);
  await assert.rejects(ctx.client.startVoice(), /current session/);
  const voice = await activating;
  assert.equal(ctx.calls[1].body.voice, "gleam");
  assert.equal(ctx.media.calls.microphone, 1);
  assert.throws(() => ctx.client.setVoice("willow"), /Switch to text/);
  const stopping = ctx.client.stopVoice();
  assert.throws(() => ctx.client.setVoice("willow"), /Switch to text/);
  ctx.respond(3, {
    ...empty,
    revision: 2,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  ctx.client.setVoice("willow");
  assert.equal(ctx.client.getSnapshot().selectedVoice, "willow");
});

test("transport-ready request precedes playback completion and a late acknowledgement cannot revive stopped voice", async (t) => {
  let allowPlayback;
  const ctx = setup(t, {
    holdReady: true,
    mediaOptions: {
      play: () =>
        new Promise((resolve) => {
          allowPlayback = resolve;
        }),
    },
  });
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "Missing bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Missing voice offer");
  const id = ctx.calls[1].body.requestId;
  ctx.respond(1, { voiceId: id, sdp: "answer" });
  await until(
    () => !!ctx.media.peers[0].remoteDescription,
    "Missing SDP answer",
  );
  ctx.media.connect();
  await until(
    () => ctx.readyCalls.length === 1,
    "Ready was blocked by pending playback",
  );
  assert.equal(ctx.client.getSnapshot().voice.status, "starting");
  const stopping = ctx.client.stopVoice();
  ctx.respond(2, {
    ...empty,
    revision: 1,
    voice: { id, clientId: ctx.calls[1].body.clientId, status: "closed" },
  });
  await stopping;
  ctx.respondReady(0, { ok: true });
  allowPlayback();
  await starting;
  await delay(0);
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.equal(ctx.readyCalls.length, 1);
});

test("busy polling uses 250ms while connection failures retain exponential backoff", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  assert.equal([...ctx.timers.values()][0].ms, 250);
  ctx.tick();
  ctx.calls[2].reject(new Error("network unavailable"));
  await until(() => ctx.timers.size === 1, "Failure did not schedule retry");
  assert.equal([...ctx.timers.values()][0].ms, 1000);
  ctx.tick();
  ctx.calls[3].reject(new Error("network unavailable"));
  await until(
    () => ctx.timers.size === 1,
    "Second failure did not schedule retry",
  );
  assert.equal([...ctx.timers.values()][0].ms, 2000);
});

test("successful tool results queue one immediate poll behind an existing poll and release the next tool", async (t) => {
  const executed = [];
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async (...args) => {
        executed.push(args);
        return catalogResult;
      },
    },
  });
  await resume(ctx, needsTool);
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Tool result was not sent");
  ctx.client.clearError();
  assert.equal(ctx.calls.length, 5);
  ctx.respond(3, { ...pending, revision: 2 });
  await delay(0);
  assert.equal(ctx.calls.length, 5, "Follow-up poll overlapped existing poll");
  ctx.respond(4, { ...pending, revision: 2 });
  await until(
    () => ctx.calls.length === 6,
    "Tool completion waited for a polling timer",
  );
  const next = {
    ...needsTool,
    revision: 3,
    tools: [
      { ...needsTool.tools[0], id: "44444444-4444-4444-8444-444444444444" },
    ],
  };
  ctx.respond(5, next);
  await until(
    () => ctx.calls.length === 7,
    "Replacement tool was not claimed after follow-up",
  );
  ctx.respond(6, { claimed: true });
  await until(
    () => ctx.calls.length === 8,
    "Replacement result was not submitted",
  );
  assert.equal(executed.length, 2);
  ctx.respond(7, { ...complete, revision: 4 });
  await until(
    () => ctx.calls.length === 9,
    "Final tool did not refresh immediately",
  );
  ctx.respond(8, { ...complete, revision: 4 });
  await delay(0);
  assert.equal(ctx.timers.size, 0);
});

test("product widgets use the display lookup without changing fresh model execution", async (t) => {
  const calls = [];
  const ctx = setup(t, {
    saved: access,
    executor: {
      loadProducts: async (ids) => {
        calls.push(ids);
        return catalogResult;
      },
      execute: () => assert.fail("Widget bypassed the display lookup"),
    },
  });
  await resume(ctx);
  const ids = ["gid://shopify/Product/123"];
  assert.equal(await ctx.client.loadProducts(ids), catalogResult);
  assert.deepEqual(calls, [ids]);
});
