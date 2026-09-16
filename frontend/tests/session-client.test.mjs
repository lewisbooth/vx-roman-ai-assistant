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
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().pending, true);
  assert.equal(optimistic.role, "user");
  assert.equal(optimistic.status, "pending");
  assert.equal(optimistic.parts[0].text, "Hello");
  assert.equal(optimistic.id, optimistic.requestId);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
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
  assert.equal(ctx.calls[1].body.requestId, optimistic.requestId);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, optimistic);
  ctx.respond(1, pending);
  await sending;
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
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
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  const retry = ctx.client.sendMessage("Hello");
  assert.equal(ctx.client.getSnapshot().optimisticMessage.id, requestId);
  await until(() => ctx.calls.length === 4, "Explicit retry was not sent");
  assert.equal(ctx.calls[3].body.requestId, requestId);
  ctx.respond(3, pending);
  await retry;
});

test("bootstrap failure removes unconfirmed local text and retry retains the original submission identity", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  const requestId = ctx.client.getSnapshot().optimisticMessage.requestId;
  const rejected = assert.rejects(sending, /could not connect/);
  ctx.calls[0].reject(new TypeError("Offline"));
  await rejected;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
  const retry = ctx.client.sendMessage("Hello");
  assert.equal(ctx.client.getSnapshot().optimisticMessage.id, requestId);
  ctx.respond(1, { ...access, conversation: empty });
  await until(
    () => ctx.calls.length === 3,
    "Retry did not reach the message endpoint",
  );
  assert.equal(ctx.calls[2].body.requestId, requestId);
  ctx.respond(2, pending);
  await retry;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
});

test("a lost response reconciles the exact accepted request without duplicate publication or replay", async (t) => {
  const ctx = setup(t);
  const published = [];
  ctx.client.subscribe(() => published.push(ctx.client.getSnapshot()));
  const sending = ctx.client.sendMessage("Hello");
  const requestId = ctx.client.getSnapshot().optimisticMessage.requestId;
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Message POST did not start");
  ctx.calls[1].reject(new TypeError("Lost response"));
  await until(() => ctx.calls.length === 3, "Message was not reconciled");
  const accepted = {
    ...pending,
    messages: [{ ...pending.messages[0], requestId }, pending.messages[1]],
  };
  ctx.respond(2, accepted);
  await sending;
  const state = ctx.client.getSnapshot();
  assert.equal(state.optimisticMessage, null);
  assert.equal(state.error, null);
  assert.equal(state.conversation.messages[0].requestId, requestId);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
  assert.ok(
    published.every(
      (snapshot) =>
        !snapshot.optimisticMessage ||
        !snapshot.conversation?.messages.some(
          (row) => row.requestId === requestId,
        ),
    ),
  );
});

test("identical older customer text is not evidence that a lost submission was accepted", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, complete);
  const sending = ctx.client.sendMessage("Hello");
  const rejected = assert.rejects(sending, /could not connect/);
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(optimistic.parts[0].text, complete.messages[0].parts[0].text);
  await until(() => ctx.calls.length === 3, "Second message was not sent");
  ctx.calls[2].reject(new TypeError("Lost response"));
  await until(
    () => ctx.calls.length === 4,
    "Second message was not reconciled",
  );
  ctx.respond(3, complete);
  await rejected;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.client.getSnapshot().conversation.messages.length, 2);
});

test("ending clears optimistic text and rejects a late submission response", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  const rejected = assert.rejects(sending, /conversation has changed/);
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Message POST did not start");
  assert.ok(ctx.client.getSnapshot().optimisticMessage);
  const ending = ctx.client.end();
  ctx.respond(2, { ...empty, status: "ended", revision: 1 });
  await ending;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  ctx.respond(1, pending);
  await rejected;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.calls.length, 3);
});

test("customer request identities are optional UUIDs and cannot label assistant rows", async (t) => {
  for (const invalid of [
    { role: "user", requestId: "not-an-id" },
    { role: "assistant", requestId: "22222222-2222-4222-8222-222222222222" },
  ]) {
    const ctx = setup(t, { saved: access });
    await resume(ctx);
    const before = ctx.client.getSnapshot().conversation;
    ctx.client.clearError();
    ctx.respond(2, {
      ...complete,
      revision: 3,
      messages: [{ ...complete.messages[0], ...invalid }],
    });
    await until(
      () => !!ctx.client.getSnapshot().error,
      "Invalid request identity was accepted",
    );
    assert.equal(ctx.client.getSnapshot().conversation, before);
    assert.match(
      ctx.client.getSnapshot().error,
      /invalid conversation response/,
    );
  }
});

test("configuration read and write commands pass the session boundary but malformed choices do not", async (t) => {
  const commands = [
    {
      name: "get_product_configuration",
      arguments: { productPath: "/products/shade" },
    },
    {
      name: "configure_product",
      arguments: {
        productPath: "/products/shade",
        configurationId: "22222222-2222-4222-8222-222222222222",
        controlId: "c0",
        optionId: "o1",
      },
    },
  ];
  for (const command of commands) {
    const ctx = setup(t, { saved: access });
    const tools = [
      {
        ...command,
        id: "33333333-3333-4333-8333-333333333333",
        status: "pending",
      },
    ];
    await resume(ctx, { ...pending, tools });
    assert.equal(ctx.client.getSnapshot().error, null);
    assert.equal(
      ctx.client.getSnapshot().conversation.tools[0].name,
      command.name,
    );
    const before = ctx.client.getSnapshot().conversation;
    ctx.client.clearError();
    ctx.respond(2, {
      ...pending,
      revision: 2,
      tools: [
        { ...tools[0], arguments: { ...command.arguments, unexpected: true } },
      ],
    });
    await until(
      () => !!ctx.client.getSnapshot().error,
      "Malformed configuration was accepted",
    );
    assert.equal(ctx.client.getSnapshot().conversation, before);
    assert.match(
      ctx.client.getSnapshot().error,
      /invalid conversation response/,
    );
  }
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
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  const store = setup(t);
  for (const text of [" ", "x".repeat(4001)])
    await assert.rejects(
      store.client.sendMessage(text),
      /up to 4000 characters/,
    );
  assert.equal(store.calls.length, 0);
  assert.equal(store.client.getSnapshot().optimisticMessage, null);
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
const orderDraft = {
  productPath: "/products/shade",
  width: 300,
  height: 400,
  unit: "mm",
  kind: "order",
  mount: "unknown",
  updatedAt: "2026-09-15T10:00:00.000Z",
};
const needsMeasurementApplication = {
  ...needsTool,
  tools: [
    {
      ...needsTool.tools[0],
      name: "apply_measurements",
      arguments: { productPath: orderDraft.productPath, draft: orderDraft },
    },
  ],
};
const measurementApplicationResult = {
  status: "applied",
  productPath: orderDraft.productPath,
  draftUpdatedAt: orderDraft.updatedAt,
  message: "Filled width and drop. Nothing was added to the cart.",
};

async function resume(ctx, value = complete) {
  ctx.respond(0, { ...access, conversation: value });
  await until(() => ctx.calls.length >= 2, "Resume read did not start");
  ctx.respond(1, value);
  await until(
    () => !ctx.client.getSnapshot().restoring,
    "Resume did not settle",
  );
}

test("guide tools use the claimed read path without shopper approval or catalog parsing", async (t) => {
  const result = {
    status: "found",
    productPath: "/products/shade",
    guides: [
      {
        kind: "measuring",
        url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=1",
      },
    ],
  };
  const guideTool = {
    ...needsTool,
    tools: [
      {
        ...needsTool.tools[0],
        name: "get_product_guides",
        arguments: { productPath: result.productPath },
      },
    ],
  };
  const executions = [];
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async (...args) => {
        executions.push(args);
        return result;
      },
      prepareApproval: () =>
        assert.fail("Read-only guide tool needs no approval"),
    },
  });
  await resume(ctx, guideTool);
  await until(() => ctx.calls.length === 3, "Guide read was not claimed");
  assert.equal("confirmed" in ctx.calls[2].body, false);
  assert.equal(ctx.client.getSnapshot().approval, null);
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Guide result was not submitted");
  assert.equal(executions[0][0], "get_product_guides");
  assert.deepEqual(JSON.parse(JSON.stringify(executions[0][1])), {
    productPath: result.productPath,
  });
  assert.deepEqual(ctx.calls[3].body.result, result);
  ctx.respond(3, complete);
});

test("restored guide widgets validate their store origin and reject unsafe later snapshots", async (t) => {
  const part = {
    type: "guides",
    version: 1,
    invocationId,
    productPath: "/products/shade",
    guides: [
      {
        kind: "fitting",
        url: "https://hd-dev-single.myshopify.com/cdn/shop/files/fitting.pdf?v=2",
      },
    ],
    voiceReply: {
      voiceId: "22222222-2222-4222-8222-222222222222",
      afterSequence: 3,
    },
  };
  const snapshot = {
    ...complete,
    messages: [{ ...complete.messages[1], parts: [part] }],
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, snapshot);
  const restored = ctx.client.getSnapshot().conversation;
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.messages[0].parts[0])),
    part,
  );
  ctx.client.clearError();
  ctx.respond(2, {
    ...snapshot,
    revision: 3,
    messages: [
      {
        ...snapshot.messages[0],
        parts: [
          {
            ...part,
            guides: [
              { kind: "fitting", url: "https://evil.example/fitting.pdf" },
            ],
          },
        ],
      },
    ],
  });
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Unsafe guide response was accepted",
  );
  assert.equal(ctx.client.getSnapshot().conversation, restored);
});

const questionPart = {
  type: "question",
  version: 1,
  invocationId,
  question: "What matters most for your room?",
  answers: ["Blackout", "Daytime privacy", "A softer look"],
};

test("confirmed navigation notifications survive response validation and unsafe destinations are rejected", async (t) => {
  const part = {
    type: "navigation",
    version: 1,
    invocationId,
    path: "/products/shade",
    title: "A Roman shade <example>",
  };
  const saved = {
    ...complete,
    messages: [{ ...complete.messages[1], role: "context", parts: [part] }],
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, saved);
  const restored = ctx.client.getSnapshot().conversation;
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.messages[0].parts[0])),
    part,
  );
  ctx.client.clearError();
  ctx.respond(2, {
    ...saved,
    revision: 3,
    messages: [
      { ...saved.messages[0], parts: [{ ...part, path: "/cart/add?id=123" }] },
    ],
  });
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Unsafe navigation destination was accepted",
  );
  assert.equal(ctx.client.getSnapshot().conversation, restored);
});

test("navigation history fits alongside maximum captions, visits and text turns", async (t) => {
  const parts = [
    ...Array.from({ length: 1200 }, () => ({
      type: "voice",
      version: 1,
      voiceId: "22222222-2222-4222-8222-222222222222",
      text: "Caption",
      startMs: 0,
      endMs: 1,
    })),
    ...Array.from({ length: 200 }, () => ({
      type: "page_view",
      version: 1,
      title: "Storefront",
      path: "/",
      occurredAt: "2026-09-15T10:00:00Z",
    })),
    ...Array.from({ length: 80 }, () => ({
      type: "text",
      text: "A conversation turn",
    })),
    ...Array.from({ length: 160 }, () => ({
      type: "navigation",
      version: 1,
      invocationId,
      title: "Shade",
      path: "/products/shade",
    })),
  ];
  const saved = {
    ...complete,
    messages: parts.map((part, index) => ({
      ...complete.messages[1],
      id: `history-${index}`,
      parts: [part],
    })),
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, saved);
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.equal(ctx.client.getSnapshot().conversation.messages.length, 1640);
});
const recommendations = {
  ...complete,
  messages: [
    complete.messages[0],
    {
      ...complete.messages[1],
      parts: [
        { type: "text", text: "Here are a few no-drill options." },
        {
          type: "products",
          version: 1,
          invocationId,
          productIds: ["gid://shopify/Product/123"],
        },
        questionPart,
      ],
    },
  ],
};

test("a streamed reply completes with a carousel and question through the real response validator", async (t) => {
  const streaming = {
    ...pending,
    messages: [
      pending.messages[0],
      {
        ...pending.messages[1],
        parts: [{ type: "text", text: "Here are a few" }],
      },
    ],
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, streaming);
  ctx.tick();
  await until(() => ctx.calls.length === 3, "Reply completion was not polled");
  ctx.respond(2, recommendations);
  await until(
    () =>
      !ctx.client.getSnapshot().conversation.busy ||
      !!ctx.client.getSnapshot().error,
    "Reply did not settle",
  );
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.client.getSnapshot().conversation.messages)),
    recommendations.messages,
  );
  assert.equal(ctx.timers.size, 0);
});

test("saved questions, including voice associations and answered history, survive bootstrap and reload", async (t) => {
  const saved = {
    ...recommendations,
    messages: [
      recommendations.messages[1],
      { ...complete.messages[0], parts: [{ type: "text", text: "Blackout" }] },
      {
        ...complete.messages[1],
        id: "voice-question",
        parts: [
          {
            ...questionPart,
            voiceReply: {
              voiceId: "22222222-2222-4222-8222-222222222222",
              afterSequence: 3,
            },
          },
        ],
      },
    ],
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, saved);
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.client.getSnapshot().conversation.messages)),
    saved.messages,
  );
});

for (const [name, invalid] of Object.entries({
  "too many answers": { answers: ["One", "Two", "Three", "Four", "Five"] },
  "duplicate answers": { answers: ["Blackout", "blackout"] },
  "HTML question": { question: "<script>alert(1)</script>" },
  "unknown version": { version: 2 },
  "unexpected fields": { extra: true },
  "invalid voice association": {
    voiceReply: { voiceId: "not-a-uuid", afterSequence: -1 },
  },
})) {
  test(`invalid question response (${name}) preserves the last valid snapshot and can recover`, async (t) => {
    const ctx = setup(t, { saved: access });
    await resume(ctx);
    const previous = ctx.client.getSnapshot().conversation;
    ctx.client.clearError();
    ctx.respond(2, {
      ...recommendations,
      revision: 3,
      messages: [
        { ...complete.messages[1], parts: [{ ...questionPart, ...invalid }] },
      ],
    });
    await until(
      () => !!ctx.client.getSnapshot().error,
      "Invalid question was accepted",
    );
    assert.match(
      ctx.client.getSnapshot().error,
      /invalid conversation response/,
    );
    assert.equal(ctx.client.getSnapshot().conversation, previous);
    ctx.client.clearError();
    await until(
      () => ctx.calls.length === 4,
      "Retry did not fetch the conversation",
    );
    ctx.respond(3, { ...recommendations, revision: 3 });
    await until(
      () =>
        ctx.client.getSnapshot().conversation.revision === 3 ||
        !!ctx.client.getSnapshot().error,
      "Corrected conversation did not settle",
    );
    assert.equal(ctx.client.getSnapshot().error, null);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(ctx.client.getSnapshot().conversation.messages),
      ),
      recommendations.messages,
    );
  });
}

for (const [name, role, questionAnswer] of [
  [
    "assistant provenance",
    "assistant",
    {
      questionId: "33333333-3333-4333-8333-333333333333",
      voiceId: "22222222-2222-4222-8222-222222222222",
    },
  ],
  [
    "invalid reference",
    "user",
    { questionId: "invalid", voiceId: "22222222-2222-4222-8222-222222222222" },
  ],
  [
    "unexpected reference data",
    "user",
    {
      questionId: "33333333-3333-4333-8333-333333333333",
      voiceId: "22222222-2222-4222-8222-222222222222",
      extra: true,
    },
  ],
]) {
  test(
    "selected answer rejects " + name + " without replacing valid history",
    async (t) => {
      const ctx = setup(t, { saved: access });
      await resume(ctx);
      const before = ctx.client.getSnapshot().conversation;
      ctx.client.clearError();
      ctx.respond(2, {
        ...complete,
        revision: 3,
        messages: [
          {
            ...complete.messages[0],
            role,
            parts: [{ type: "text", text: "Full blackout", questionAnswer }],
          },
        ],
      });
      await until(
        () => !!ctx.client.getSnapshot().error,
        "Invalid selected answer accepted",
      );
      assert.match(
        ctx.client.getSnapshot().error,
        /invalid conversation response/,
      );
      assert.equal(ctx.client.getSnapshot().conversation, before);
    },
  );
}

test("saved voice lifecycle events restore without reacquiring audio", async (t) => {
  const events = {
    ...complete,
    messages: ["started", "ended", "disconnected"].map((event, index) => ({
      id: "event-" + index,
      role: "context",
      status: "complete",
      createdAt: "2026-09-16T10:00:00Z",
      parts: [
        {
          type: "voice_event",
          version: 1,
          voiceId: "22222222-2222-4222-8222-222222222222",
          event,
        },
      ],
    })),
  };
  const ctx = setup(t, { saved: access, mediaOptions: {} });
  await resume(ctx, events);
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.client.getSnapshot().conversation.messages)),
    events.messages,
  );
  assert.equal(ctx.media.calls.microphone, 0);
});
for (const [name, role, changes] of [
  ["unknown event", "context", { event: "started_again" }],
  ["invalid connection", "context", { voiceId: "invalid" }],
  ["assistant event", "assistant", {}],
  ["extra data", "context", { text: "forged" }],
]) {
  test(
    "voice lifecycle rejects " + name + " and preserves accepted history",
    async (t) => {
      const ctx = setup(t, { saved: access });
      await resume(ctx);
      const before = ctx.client.getSnapshot().conversation;
      ctx.client.clearError();
      ctx.respond(2, {
        ...complete,
        revision: 3,
        messages: [
          {
            id: "event",
            role,
            status: "complete",
            createdAt: "2026-09-16T10:00:00Z",
            parts: [
              {
                type: "voice_event",
                version: 1,
                voiceId: "22222222-2222-4222-8222-222222222222",
                event: "started",
                ...changes,
              },
            ],
          },
        ],
      });
      await until(
        () => !!ctx.client.getSnapshot().error,
        "Invalid voice event accepted",
      );
      assert.match(
        ctx.client.getSnapshot().error,
        /invalid conversation response/,
      );
      assert.equal(ctx.client.getSnapshot().conversation, before);
    },
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

const addedResult = {
  status: "added",
  message: "Added to your cart.",
  quantityAdded: 1,
  addedProduct: {
    productPath: "/products/shade",
    title: "Kitchen blind",
    measurements: { width: 900, height: 1200, unit: "mm" },
  },
};
const needsCartAdd = {
  ...needsTool,
  tools: [
    {
      ...needsTool.tools[0],
      name: "add_to_cart",
      arguments: { productPath: addedResult.addedProduct.productPath },
    },
  ],
};

test("cart additions execute once after their claim without opening an approval panel", async (t) => {
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: () =>
        assert.fail("Adding must not open an approval panel"),
      executeApproved: () =>
        assert.fail("Adding uses the direct execution path"),
      execute: async (name, args) => {
        assert.equal(name, "add_to_cart");
        assert.deepEqual(
          JSON.parse(JSON.stringify(args)),
          needsCartAdd.tools[0].arguments,
        );
        executions++;
        return addedResult;
      },
    },
  });
  await resume(ctx, needsCartAdd);
  await until(() => ctx.calls.length === 3, "Add was not claimed");
  assert.equal(ctx.client.getSnapshot().approval, null);
  assert.equal("confirmed" in ctx.calls[2].body, false);
  assert.equal(executions, 0);
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Add result was not submitted");
  assert.equal(executions, 1);
  assert.deepEqual(ctx.calls[3].body.result, addedResult);
  ctx.respond(3, complete);
});

test("sample additions execute directly with the verified PDP path", async (t) => {
  const result = {
    status: "added",
    message: "Sample added.",
    addedSample: {
      productPath: "/products/shade",
      title: "BiFold Matte Black Venetian - 16mm Slat",
    },
  };
  const requested = {
    ...needsTool,
    tools: [
      {
        ...needsTool.tools[0],
        name: "add_sample_to_cart",
        arguments: { productPath: result.addedSample.productPath },
      },
    ],
  };
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: () => assert.fail("Sample additions do not need review"),
      executeApproved: () =>
        assert.fail("Sample additions use direct execution"),
      execute: async (name, args) => {
        assert.equal(name, "add_sample_to_cart");
        assert.deepEqual(
          JSON.parse(JSON.stringify(args)),
          requested.tools[0].arguments,
        );
        return result;
      },
    },
  });
  await resume(ctx, requested);
  await until(() => ctx.calls.length === 3, "Sample was not claimed");
  assert.equal("confirmed" in ctx.calls[2].body, false);
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Sample outcome was not submitted");
  assert.deepEqual(ctx.calls[3].body.result, result);
  ctx.respond(3, complete);
});

test("saved cart additions survive restoration and malformed later event data is rejected", async (t) => {
  const part = {
    type: "cart_added",
    version: 1,
    invocationId,
    product: addedResult.addedProduct,
  };
  const saved = {
    ...complete,
    messages: [{ ...complete.messages[1], role: "context", parts: [part] }],
  };
  const ctx = setup(t, { saved: access });
  await resume(ctx, saved);
  const restored = ctx.client.getSnapshot().conversation;
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.messages[0].parts[0])),
    part,
  );
  ctx.client.clearError();
  ctx.respond(2, {
    ...saved,
    revision: 3,
    messages: [
      {
        ...saved.messages[0],
        parts: [
          {
            ...part,
            product: {
              ...part.product,
              measurements: { width: -1, height: 1200, unit: "mm" },
            },
          },
        ],
      },
    ],
  });
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Invalid cart dimensions were accepted",
  );
  assert.equal(ctx.client.getSnapshot().conversation, restored);
});

const needsCartApproval = {
  ...needsTool,
  tools: [
    {
      ...needsTool.tools[0],
      name: "remove_from_cart",
      arguments: { lineKey: "123:abc" },
    },
  ],
};
const approvalReview = {
  title: "Remove this item?",
  details: ["Kitchen blind", "Quantity 2"],
};
const removedResult = {
  status: "updated",
  message: "Removed.",
  cart: { currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: [] },
};

test("cart review waits for the exact shopper approval before claim and never sends confirmation as model input or result", async (t) => {
  const executions = [];
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => approvalReview,
      execute: () =>
        assert.fail("Mutation must use the approved executor path"),
      executeApproved: async (...args) => {
        executions.push(args);
        return removedResult;
      },
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Review was not presented",
  );
  assert.equal(ctx.calls.length, 2);
  assert.equal(executions.length, 0);
  ctx.client.resolveToolApproval("wrong-invocation", true);
  await delay(5);
  assert.equal(ctx.calls.length, 2);
  ctx.client.resolveToolApproval(invocationId, true);
  await until(() => ctx.calls.length === 3, "Approved tool was not claimed");
  assert.equal(ctx.calls[2].body.confirmed, true);
  assert.equal(ctx.client.getSnapshot().approval, null);
  assert.equal(executions.length, 0);
  ctx.respond(2, { claimed: true });
  await until(
    () => ctx.calls.length === 4,
    "Approved result was not submitted",
  );
  assert.equal(executions.length, 1);
  assert.equal(executions[0][1], approvalReview);
  assert.deepEqual(JSON.parse(JSON.stringify(executions[0][0].arguments)), {
    lineKey: "123:abc",
  });
  assert.equal("confirmed" in ctx.calls[3].body, false);
  assert.deepEqual(ctx.calls[3].body.result, removedResult);
  ctx.respond(3, complete);
});

test("shopper cancellation declines the invocation without execution even if a server incorrectly grants it", async (t) => {
  for (const claimed of [false, true])
    await t.test(String(claimed), async (t) => {
      const ctx = setup(t, {
        saved: access,
        executor: {
          prepareApproval: async () => approvalReview,
          executeApproved: () =>
            assert.fail("Cancelled action must never execute"),
        },
      });
      await resume(ctx, needsCartApproval);
      await until(
        () => !!ctx.client.getSnapshot().approval,
        "Review was not presented",
      );
      ctx.client.resolveToolApproval(invocationId, false);
      await until(() => ctx.calls.length === 3, "Decline was not sent");
      assert.equal(ctx.calls[2].body.confirmed, false);
      ctx.respond(2, { claimed });
      await delay(10);
      assert.equal(
        ctx.calls.some((call) => call.url.endsWith("/result")),
        false,
      );
      if (!claimed) {
        await until(
          () => ctx.calls.length === 4,
          "Decline did not refresh the chat",
        );
        ctx.respond(3, complete);
      } else
        assert.match(
          ctx.client.getSnapshot().error,
          /cancelled action was not executed/,
        );
    });
});

test("an unavailable configuration cannot be approved, but can be declined", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => {
        throw new ctx.window.Error("Open the matching product.");
      },
      executeApproved: () => assert.fail("Unavailable action must not execute"),
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Unavailable review was not presented",
  );
  assert.match(
    ctx.client.getSnapshot().approval.unavailable,
    /matching product/,
  );
  ctx.client.resolveToolApproval(invocationId, true);
  await delay(5);
  assert.equal(ctx.calls.length, 2);
  ctx.client.resolveToolApproval(invocationId, false);
  await until(() => ctx.calls.length === 3, "Decline was not sent");
  ctx.respond(2, { claimed: false });
});

test("authoritative removal cancels a waiting review and stale approval clicks cannot claim it", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => approvalReview,
      executeApproved: () => assert.fail("Expired action must never execute"),
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Review was not presented",
  );
  ctx.tick();
  await until(
    () => ctx.calls.length === 3,
    "Poll did not start while review waited",
  );
  ctx.respond(2, complete);
  await until(
    () => !ctx.client.getSnapshot().approval,
    "Expired review did not close",
  );
  ctx.client.resolveToolApproval(invocationId, true);
  await delay(5);
  assert.equal(
    ctx.calls.some((call) => call.url.endsWith("/claim")),
    false,
  );
  assert.equal(ctx.client.getSnapshot().error, null);
});

test("a lost approved mutation result retries only the outcome, not approval, claim or mutation", async (t) => {
  let executions = 0;
  let reviews = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => {
        reviews++;
        return approvalReview;
      },
      executeApproved: async () => {
        executions++;
        return removedResult;
      },
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Review was not presented",
  );
  ctx.client.resolveToolApproval(invocationId, true);
  await until(() => ctx.calls.length === 3, "Claim did not start");
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Result did not start");
  const original = ctx.calls[3].body;
  ctx.calls[3].reject(new TypeError("Lost result response"));
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Failure was not surfaced",
  );
  ctx.tick();
  await until(() => ctx.calls.length === 5, "Poll did not start");
  ctx.respond(4, {
    ...needsCartApproval,
    revision: 2,
    tools: [{ ...needsCartApproval.tools[0], status: "running" }],
  });
  await until(() => ctx.calls.length === 6, "Result was not retried");
  assert.deepEqual(ctx.calls[5].body, original);
  assert.equal(executions, 1);
  assert.equal(reviews, 1);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/claim")).length,
    1,
  );
  ctx.respond(5, { ...complete, revision: 3 });
});

test("a lost approval claim acknowledgement reuses the same decision and token once", async (t) => {
  let reviews = 0;
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => {
        reviews++;
        return approvalReview;
      },
      executeApproved: async () => {
        executions++;
        return removedResult;
      },
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Review was not presented",
  );
  ctx.client.resolveToolApproval(invocationId, true);
  await until(() => ctx.calls.length === 3, "Claim did not start");
  const original = ctx.calls[2].body;
  ctx.calls[2].reject(new TypeError("Lost claim acknowledgement"));
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Claim failure was not surfaced",
  );
  ctx.tick();
  await until(() => ctx.calls.length === 4, "Poll did not start");
  ctx.respond(3, {
    ...needsCartApproval,
    revision: 2,
    tools: [{ ...needsCartApproval.tools[0], status: "running" }],
  });
  await until(() => ctx.calls.length === 5, "Claim retry did not start");
  assert.deepEqual(ctx.calls[4].body, original);
  assert.equal(reviews, 1);
  assert.equal(executions, 0);
  ctx.respond(4, { claimed: true });
  await until(() => ctx.calls.length === 6, "Result did not start");
  assert.equal(executions, 1);
  ctx.respond(5, { ...complete, revision: 3 });
});

test("failed End cannot revive an approved action whose claim was in flight", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: async () => approvalReview,
      executeApproved: () =>
        assert.fail("An abandoned approval must never execute"),
    },
  });
  await resume(ctx, needsCartApproval);
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Review was not presented",
  );
  ctx.client.resolveToolApproval(invocationId, true);
  await until(() => ctx.calls.length === 3, "Claim did not start");
  const originalClaim = ctx.calls[2].body;
  const ending = ctx.client.end();
  const rejected = assert.rejects(ending);
  ctx.respond(3, { error: { message: "Temporary failure" } }, 500);
  await rejected;
  ctx.respond(2, { claimed: true });
  await delay(10);
  ctx.client.clearError();
  await until(
    () => ctx.calls.length === 5,
    "Reconciliation read did not start",
  );
  ctx.respond(4, {
    ...needsCartApproval,
    revision: 2,
    tools: [{ ...needsCartApproval.tools[0], status: "running" }],
  });
  await until(() => ctx.calls.length === 6, "Ownership was not reconciled");
  assert.deepEqual(ctx.calls[5].body, originalClaim);
  ctx.respond(5, { claimed: true });
  await until(
    () => ctx.calls.length === 7,
    "Interrupted outcome was not reported",
  );
  assert.match(ctx.calls[6].body.error, /interrupted/);
  assert.equal("result" in ctx.calls[6].body, false);
  assert.equal(ctx.client.getSnapshot().approval, null);
  ctx.respond(6, { ...complete, revision: 3 });
});

test("failed End cannot revive an add-to-cart action whose ordinary claim was in flight", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: () => assert.fail("An abandoned cart add must never execute"),
      prepareApproval: () =>
        assert.fail("Cart adds must not open an approval panel"),
    },
  });
  await resume(ctx, needsCartAdd);
  await until(() => ctx.calls.length === 3, "Add claim did not start");
  const originalClaim = ctx.calls[2].body;
  const ending = ctx.client.end();
  const rejected = assert.rejects(ending);
  ctx.respond(3, { error: { message: "Temporary failure" } }, 500);
  await rejected;
  ctx.respond(2, { claimed: true });
  await delay(10);
  ctx.client.clearError();
  await until(
    () => ctx.calls.length === 5,
    "Reconciliation read did not start",
  );
  ctx.respond(4, {
    ...needsCartAdd,
    revision: 2,
    tools: [{ ...needsCartAdd.tools[0], status: "running" }],
  });
  await until(() => ctx.calls.length === 6, "Ownership was not reconciled");
  assert.deepEqual(ctx.calls[5].body, originalClaim);
  ctx.respond(5, { claimed: true });
  await until(
    () => ctx.calls.length === 7,
    "Interrupted outcome was not reported",
  );
  assert.match(ctx.calls[6].body.error, /interrupted/);
  assert.equal("result" in ctx.calls[6].body, false);
  ctx.respond(6, { ...complete, revision: 3 });
});

test("failed End cannot revive a measurement action whose ordinary claim was in flight", async (t) => {
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: () => assert.fail("An abandoned measurement must never execute"),
      prepareApproval: () =>
        assert.fail("Measurements must not open another approval panel"),
    },
  });
  await resume(ctx, needsMeasurementApplication);
  await until(() => ctx.calls.length === 3, "Measurement claim did not start");
  const originalClaim = ctx.calls[2].body;
  assert.equal("confirmed" in originalClaim, false);
  const ending = ctx.client.end();
  const rejected = assert.rejects(ending);
  ctx.respond(3, { error: { message: "Temporary failure" } }, 500);
  await rejected;
  ctx.respond(2, { claimed: true });
  await delay(10);
  ctx.client.clearError();
  await until(
    () => ctx.calls.length === 5,
    "Reconciliation read did not start",
  );
  ctx.respond(4, {
    ...needsMeasurementApplication,
    revision: 2,
    tools: [{ ...needsMeasurementApplication.tools[0], status: "running" }],
  });
  await until(() => ctx.calls.length === 6, "Ownership was not reconciled");
  assert.deepEqual(ctx.calls[5].body, originalClaim);
  ctx.respond(5, { claimed: true });
  await until(
    () => ctx.calls.length === 7,
    "Interrupted outcome was not reported",
  );
  assert.match(ctx.calls[6].body.error, /interrupted/);
  assert.equal("result" in ctx.calls[6].body, false);
  assert.equal(ctx.client.getSnapshot().approval, null);
  ctx.respond(6, { ...complete, revision: 3 });
});

test("measurement application claims the frozen order draft without a second on-screen approval", async (t) => {
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      prepareApproval: () =>
        assert.fail("Measurements must not open another approval panel"),
      executeApproved: () =>
        assert.fail("Measurements do not use cart approvals"),
      execute: async (name, args) => {
        assert.equal(name, "apply_measurements");
        assert.deepEqual(JSON.parse(JSON.stringify(args.draft)), orderDraft);
        executions++;
        return measurementApplicationResult;
      },
    },
  });
  await resume(ctx, needsMeasurementApplication);
  await until(() => ctx.calls.length === 3, "Measurement claim did not start");
  assert.equal(ctx.client.getSnapshot().approval, null);
  assert.equal(executions, 0);
  assert.equal("confirmed" in ctx.calls[2].body, false);
  assert.equal("draft" in ctx.calls[2].body, false);
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Measurement result did not start");
  assert.equal(ctx.calls[3].body.result.draftUpdatedAt, orderDraft.updatedAt);
  assert.equal(executions, 1);
  assert.equal("confirmed" in ctx.calls[3].body, false);
  ctx.respond(3, complete);
});

test("a lost tool-result response retries the same result without reexecuting or claiming again", async (t) => {
  for (const [snapshot, result] of [
    [needsTool, catalogResult],
    [needsNavigation, navigationResult],
    [needsMeasurementApplication, measurementApplicationResult],
    [needsCartAdd, addedResult],
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

test("a refreshed client never claims or repeats navigation or measurement application already running in the previous page", async (t) => {
  for (const snapshot of [needsNavigation, needsMeasurementApplication])
    await t.test(snapshot.tools[0].name, async (t) => {
      const ctx = setup(t, {
        saved: access,
        executor: {
          execute: () =>
            assert.fail("Previously claimed action must not replay"),
        },
      });
      const running = {
        ...snapshot,
        tools: [{ ...snapshot.tools[0], status: "running" }],
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
      assert.equal(ctx.client.getSnapshot().approval, null);
    });
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

async function activeVoice(ctx, conversation = empty) {
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "Voice did not bootstrap");
  ctx.respond(0, { ...access, conversation });
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
  ctx.respond(2, {
    ...conversation,
    revision: conversation.revision + 1,
    voice,
  });
  await delay(0);
  return voice;
}

const voiceQuestionId = "33333333-3333-4333-8333-333333333333";
const voiceQuestion = {
  ...empty,
  messages: [
    {
      id: "question",
      role: "assistant",
      status: "complete",
      createdAt: "2026-09-16T10:00:00Z",
      parts: [
        {
          type: "question",
          version: 1,
          invocationId: voiceQuestionId,
          question: "What matters most?",
          answers: ["Full blackout", "Daylight"],
        },
      ],
    },
  ],
};
function acceptedVoiceAnswer(request, voice) {
  return {
    ...voiceQuestion,
    revision: 2,
    voice,
    messages: [
      ...voiceQuestion.messages,
      {
        id: request.requestId,
        role: "user",
        status: "complete",
        createdAt: "2026-09-16T10:00:01Z",
        parts: [
          {
            type: "text",
            text: request.answer,
            questionAnswer: {
              questionId: request.questionId,
              voiceId: voice.id,
            },
          },
        ],
      },
    ],
  };
}

test("suggested voice answers preserve media and mute, persist once and reject duplicate/stale choices", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx, voiceQuestion);
  ctx.client.setVoiceMuted(true);
  const sending = ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout");
  assert.equal(ctx.calls.length, 4);
  const call = ctx.calls[3];
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(optimistic.id, call.body.requestId);
  assert.equal(optimistic.parts[0].text, "Full blackout");
  assert.equal(optimistic.parts[0].questionAnswer.questionId, voiceQuestionId);
  assert.equal(optimistic.parts[0].questionAnswer.voiceId, voice.id);
  assert.equal(
    call.url,
    access.apiBaseUrl +
      "/" +
      conversationId +
      "/voice/" +
      voice.id +
      "/answers",
  );
  assert.equal(call.init.headers.Authorization, "Bearer " + access.token);
  assert.equal(call.body.clientId, voice.clientId);
  assert.equal(call.body.questionId, voiceQuestionId);
  assert.equal(call.body.answer, "Full blackout");
  assert.match(call.body.requestId, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout"),
    /finished replying/,
  );
  ctx.respond(3, acceptedVoiceAnswer(call.body, voice));
  await sending;
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(ctx.client.getSnapshot().voice.muted, true);
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.tracks[0].enabled, false);
  assert.equal(ctx.media.peers[0].closed, undefined);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages.at(-1).parts[0].text,
    "Full blackout",
  );
  await assert.rejects(
    ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout"),
    /no longer waiting/,
  );
  assert.equal(ctx.calls.length, 4);
});

test("lost voice answer responses reconcile without replay and explicit retry retains request identity", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx, voiceQuestion);
  const sending = ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout");
  const rejected = assert.rejects(sending, /could not connect/);
  ctx.calls[3].reject(new Error("offline"));
  await until(() => ctx.calls.length === 5, "Lost answer did not reconcile");
  assert.equal(ctx.calls[4].init.method, "GET");
  ctx.respond(4, { ...voiceQuestion, revision: 1, voice });
  await rejected;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.calls.length, 5);
  assert.equal(ctx.media.tracks[0].stopped, false);
  const retry = ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout");
  assert.deepEqual(ctx.calls[5].body, ctx.calls[3].body);
  ctx.respond(5, acceptedVoiceAnswer(ctx.calls[5].body, voice));
  await retry;
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(
    ctx.calls.filter(
      (call) => call.url.endsWith("/messages") || call.url.endsWith("/stop"),
    ).length,
    0,
  );
});

test("a lost response with a durable answer reconciles successfully without sending it again", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx, voiceQuestion);
  const sending = ctx.client.sendVoiceAnswer(voiceQuestionId, "Full blackout");
  ctx.calls[3].reject(new Error("response lost"));
  await until(
    () => ctx.calls.length === 5,
    "Accepted answer did not reconcile",
  );
  ctx.respond(4, acceptedVoiceAnswer(ctx.calls[3].body, voice));
  await sending;
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/answers")).length,
    1,
  );
  assert.equal(ctx.media.tracks[0].stopped, false);
});

test("unoffered and remote voice answers are rejected without contacting the backend", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx, voiceQuestion);
  await assert.rejects(
    ctx.client.sendVoiceAnswer(voiceQuestionId, "Unlisted"),
    /no longer waiting/,
  );
  await assert.rejects(
    ctx.client.sendVoiceAnswer(
      "44444444-4444-4444-8444-444444444444",
      "Full blackout",
    ),
    /no longer waiting/,
  );
  assert.equal(ctx.calls.length, 3);
  const remote = setup(t, { saved: access });
  const conversation = { ...voiceQuestion, voice };
  remote.respond(0, { ...access, conversation });
  await until(() => remote.calls.length === 2, "Remote restore missing");
  remote.respond(1, conversation);
  await until(
    () => !remote.client.getSnapshot().restoring,
    "Remote restore did not finish",
  );
  await assert.rejects(
    remote.client.sendVoiceAnswer(voiceQuestionId, "Full blackout"),
    /connected here/,
  );
  assert.equal(remote.calls.length, 2);
});

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

test("Stop voice withdraws an unclaimed cart review and ignores late approval clicks", async (t) => {
  const ctx = setup(t, {
    mediaOptions: {},
    executor: {
      prepareApproval: async () => approvalReview,
      executeApproved: () =>
        assert.fail("Stopped voice must not mutate a cart"),
    },
  });
  const voice = await activeVoice(ctx);
  const [timerId, poll] = [...ctx.timers].find(([, timer]) => timer.ms === 500);
  ctx.timers.delete(timerId);
  poll.callback();
  ctx.respond(3, { ...needsCartApproval, revision: 2, voice });
  await until(
    () => !!ctx.client.getSnapshot().approval,
    "Voice cart review did not appear",
  );
  const stopping = ctx.client.stopVoice();
  assert.equal(ctx.client.getSnapshot().approval, null);
  ctx.client.resolveToolApproval(invocationId, true);
  assert.equal(
    ctx.calls.some((call) => call.url.endsWith("/claim")),
    false,
  );
  ctx.respond(4, {
    ...empty,
    revision: 3,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  assert.equal(
    ctx.calls.some((call) => call.url.endsWith("/result")),
    false,
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
  assert.throws(() => ctx.client.setVoice("willow"), /End voice/);
  await assert.rejects(ctx.client.startVoice(), /current session/);
  const voice = await activating;
  assert.equal(ctx.calls[1].body.voice, "gleam");
  assert.equal(ctx.media.calls.microphone, 1);
  assert.throws(() => ctx.client.setVoice("willow"), /End voice/);
  const stopping = ctx.client.stopVoice();
  assert.throws(() => ctx.client.setVoice("willow"), /End voice/);
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

test("product images use their separate display owner and stop after client disposal", async (t) => {
  const calls = [];
  const image = "https://cdn.shopify.com/main.jpg";
  const ctx = setup(t, {
    saved: access,
    executor: {
      loadProductImage: async (...args) => {
        calls.push(args);
        return image;
      },
      execute: () => assert.fail("Image loading must not invoke a model tool"),
    },
  });
  await resume(ctx);
  const controller = new ctx.window.AbortController();
  const url = `${ctx.window.location.origin}/products/shade`;
  assert.equal(
    await ctx.client.loadProductImage(url, controller.signal),
    image,
  );
  assert.equal(calls[0][0], url);
  assert.equal(calls[0][1], controller.signal);
  ctx.client.dispose();
  await assert.rejects(
    ctx.client.loadProductImage(url, controller.signal),
    /Start a chat/,
  );
  assert.equal(calls.length, 1);
});

const measurementInput = {
  productPath: "/products/lottie",
  width: 300,
  height: 400,
  unit: "mm",
  kind: "window",
  mount: "unknown",
};
const savedMeasurement = {
  status: "saved",
  draft: { ...measurementInput, updatedAt: "2026-09-15T00:00:00.000Z" },
};

test("manual measurements lazily create a conversation and persist without requesting a model reply", async (t) => {
  const ctx = setup(t);
  const saving = ctx.client.executeMeasurements(
    "set_measurements",
    measurementInput,
  );
  assert.equal(ctx.calls.length, 1);
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Measurement request missing");
  assert.equal(
    ctx.calls[1].url,
    `${access.apiBaseUrl}/${conversationId}/measurements`,
  );
  assert.equal(ctx.calls[1].body.name, "set_measurements");
  assert.deepEqual(ctx.calls[1].body.arguments, measurementInput);
  assert.match(ctx.calls[1].body.requestId, /^[0-9a-f-]{36}$/);
  ctx.respond(1, { result: savedMeasurement });
  await until(() => ctx.calls.length === 3, "Snapshot refresh missing");
  ctx.respond(2, { ...empty, revision: 1 });
  assert.equal((await saving).draft.width, 300);
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(
    ctx.calls.some((call) => call.url.endsWith("/messages")),
    false,
  );
});

test("an unconfirmed measurement save retains its identity and blocks different values until resolved", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, empty);
  const first = ctx.client.executeMeasurements(
    "set_measurements",
    measurementInput,
  );
  const rejected = assert.rejects(first, /connect/);
  ctx.calls[2].reject(new Error("lost response"));
  await rejected;
  const id = ctx.calls[2].body.requestId;
  await assert.rejects(
    ctx.client.executeMeasurements("set_measurements", {
      ...measurementInput,
      width: 500,
    }),
    /unconfirmed/,
  );
  assert.equal(ctx.calls.length, 3);
  const retry = ctx.client.executeMeasurements(
    "set_measurements",
    measurementInput,
  );
  assert.equal(ctx.calls[3].body.requestId, id);
  ctx.respond(3, { result: savedMeasurement });
  await until(() => ctx.calls.length === 5, "Retry refresh missing");
  ctx.respond(4, { ...empty, revision: 1 });
  assert.equal((await retry).status, "saved");
});

test("measurements reject a mismatched product result and a late response after ending without starting more work", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, empty);
  const reading = ctx.client.executeMeasurements("get_measurements", {
    productPath: measurementInput.productPath,
  });
  const invalid = assert.rejects(reading, /different request/);
  ctx.respond(2, {
    result: { status: "not_found", productPath: "/products/other" },
  });
  await invalid;
  const saving = ctx.client.executeMeasurements(
    "set_measurements",
    measurementInput,
  );
  const late = assert.rejects(saving, /conversation.*changed/i);
  const ending = ctx.client.end();
  ctx.respond(4, { ...empty, status: "ended", revision: 1 });
  await ending;
  ctx.respond(3, { result: savedMeasurement });
  await late;
  assert.equal(ctx.calls.length, 5);
  assert.equal(ctx.client.getSnapshot().conversation, null);
});
