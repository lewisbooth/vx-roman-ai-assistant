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
  const availabilityCalls = [];
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
      if (String(url).endsWith("/availability")) {
        availabilityCalls.push(call);
      } else if (String(url).endsWith("/ready")) {
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
    availabilityCalls,
    readyCalls,
    timers,
    respond,
    respondReady: (index, body, status = 200) =>
      finish(readyCalls[index], body, status),
    respondAvailability: (index, body, status = 200) =>
      finish(availabilityCalls[index], body, status),
    tick,
    notifications: () => notifications,
  };
}

test("a suspended service pauses a restored chat and resumes it after availability recovers", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.respond(0, { ...access, conversation: complete });
  await until(() => ctx.calls.length === 2, "Restored chat was not refreshed");
  ctx.respond(1, complete);
  await until(
    () => ctx.client.getSnapshot().restoring === false,
    "Restored chat did not settle",
  );

  ctx.client.setOpen(true);
  assert.equal(
    ctx.availabilityCalls[0].url,
    "https://hd-dev-single.myshopify.com/apps/roman/availability",
  );
  assert.equal(ctx.availabilityCalls[0].init.method, "GET");
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspended status was not applied",
  );
  assert.equal(ctx.client.getSnapshot().conversation.messages.length, 2);
  await assert.rejects(
    ctx.client.sendMessage("Please continue"),
    /Roman is currently unavailable/,
  );
  await assert.rejects(
    ctx.client.startVoice(),
    /Roman is currently unavailable/,
  );
  assert.equal(ctx.calls.length, 2);
  assert.equal([...ctx.timers.values()][0].ms, 3_000);

  ctx.tick();
  await until(
    () => ctx.availabilityCalls.length === 2,
    "Suspended service was not checked again",
  );
  ctx.respondAvailability(1, { status: "available" });
  await until(
    () => ctx.client.getSnapshot().availability === "available",
    "Recovered status was not applied",
  );
  await until(() => ctx.calls.length === 3, "Chat was not refreshed on recovery");
  ctx.respond(2, complete);
  assert.equal(ctx.client.getSnapshot().conversation.messages.length, 2);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation") !== null, true);
});

test("SERVICE_UNAVAILABLE from a chat request suspends input before the next status poll", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Message was not sent");
  ctx.respond(
    1,
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Roman is currently unavailable",
      },
    },
    503,
  );
  await until(() => ctx.calls.length === 3, "Rejected send was not reconciled");
  assert.equal(ctx.calls[2].init.method, "GET");
  ctx.respond(2, empty);
  await assert.rejects(sending, /Roman is currently unavailable/);
  assert.equal(ctx.client.getSnapshot().availability, "suspended");
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.equal(ctx.client.getSnapshot().error, null);
  await assert.rejects(ctx.client.sendMessage("Again"), /currently unavailable/);

  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "available" });
  await until(() => ctx.calls.length === 4, "Recovery did not refresh chat");
  ctx.respond(3, empty);
  await until(
    () => ctx.client.getSnapshot().availability === "available",
    "Recovery was not applied",
  );
});

test("an unconfirmed availability check keeps automatic voice startup gated and retries", async (t) => {
  const ctx = setup(t);
  ctx.client.setOpen(true);
  ctx.availabilityCalls[0].reject(new Error("Storefront connection lost"));
  await until(() => ctx.timers.size === 1, "Availability retry was not scheduled");
  assert.equal(ctx.client.getSnapshot().availabilityChecked, false);
  assert.equal([...ctx.timers.values()][0].ms, 10_000);

  ctx.tick();
  await until(() => ctx.availabilityCalls.length === 2, "Availability was not retried");
  ctx.respondAvailability(1, { status: "degraded" });
  await until(
    () => ctx.client.getSnapshot().availabilityChecked,
    "Valid degraded status was not accepted",
  );
  assert.equal(ctx.client.getSnapshot().availability, "degraded");
});

test("End chat remains available during suspension and clears the local conversation", async (t) => {
  const ctx = setup(t, { saved: access });
  ctx.respond(0, { ...access, conversation: complete });
  await until(() => ctx.calls.length === 2, "Restored chat was not refreshed");
  ctx.respond(1, complete);
  await until(() => !ctx.client.getSnapshot().restoring, "Restore did not settle");
  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspension was not applied",
  );
  const ending = ctx.client.end();
  assert.equal(ctx.calls[2].url, `${access.apiBaseUrl}/${conversationId}/end`);
  ctx.respond(2, { ...empty, status: "ended" });
  await ending;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().availability, "suspended");
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
});

test("recovery refresh waits for an in-flight message before reading the conversation", async (t) => {
  const ctx = setup(t);
  const sending = ctx.client.sendMessage("Hello");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "Message was not sent");
  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspension was not applied",
  );
  ctx.tick();
  ctx.respondAvailability(1, { status: "available" });
  await until(
    () => ctx.client.getSnapshot().availability === "available",
    "Recovery was not applied",
  );
  assert.equal(ctx.calls.length, 2, "Recovery read raced the pending send");

  ctx.respond(1, pending);
  await sending;
  await until(() => ctx.calls.length === 3, "Accepted message was not refreshed");
  assert.equal(ctx.calls[2].init.method, "GET");
  ctx.respond(2, pending);
});

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

for (const role of ["assistant", "context"]) {
  test(`${role} guide activity advances without a durable revision and clears without stale replay`, async (t) => {
    const ctx = setup(t, { saved: access });
    const working = {
      ...pending,
      messages: role === "context" ? [pending.messages[0]] : pending.messages,
    };
    await resume(ctx, working);
    ctx.tick();
    ctx.respond(ctx.calls.length - 1, {
      ...working,
      streamRevision: 1,
      readingGuides: ["measuring"],
    });
    await until(
      () => ctx.client.getSnapshot().conversation.readingGuides?.length === 1,
      "Reading activity was not applied",
    );
    const reading = ctx.client.getSnapshot();
    ctx.tick();
    assert.match(ctx.calls.at(-1).url, /revision=1&streamRevision=1$/);
    ctx.respond(ctx.calls.length - 1, {
      id: conversationId,
      revision: 1,
      streamRevision: 1,
      unchanged: true,
    });
    await until(() => ctx.timers.size === 1, "Unchanged read did not settle");
    assert.equal(ctx.client.getSnapshot(), reading);
    ctx.tick();
    ctx.respond(ctx.calls.length - 1, { ...working, streamRevision: 2 });
    await until(
      () => !ctx.client.getSnapshot().conversation.readingGuides,
      "Finished guide reading remained sticky",
    );
    const cleared = ctx.client.getSnapshot();
    ctx.tick();
    ctx.respond(ctx.calls.length - 1, {
      ...working,
      streamRevision: 1,
      readingGuides: ["fitting"],
    });
    await until(() => ctx.timers.size === 1, "Stale read did not settle");
    assert.equal(ctx.client.getSnapshot(), cleared);
    ctx.tick();
    ctx.respond(ctx.calls.length - 1, complete);
    await until(
      () => !ctx.client.getSnapshot().conversation.busy,
      "Reply did not complete",
    );
    assert.equal(
      ctx.client.getSnapshot().conversation.readingGuides,
      undefined,
    );
    assert.equal(ctx.client.getSnapshot().error, null);
  });
}

for (const [name, invalid] of Object.entries({
  empty: [],
  duplicate: ["measuring", "measuring"],
  unknown: ["installation"],
  oversized: ["measuring", "fitting", "measuring"],
  string: "measuring",
  null: null,
})) {
  test(`malformed guide activity ${name} is rejected without replacing the last snapshot`, async (t) => {
    const ctx = setup(t, { saved: access });
    await resume(ctx, pending);
    const previous = ctx.client.getSnapshot().conversation;
    ctx.tick();
    ctx.respond(ctx.calls.length - 1, {
      ...pending,
      streamRevision: 1,
      readingGuides: invalid,
    });
    await until(
      () => !!ctx.client.getSnapshot().error,
      "Invalid guide activity was accepted",
    );
    assert.match(
      ctx.client.getSnapshot().error,
      /invalid conversation response/,
    );
    assert.equal(ctx.client.getSnapshot().conversation, previous);
  });
}

test("idle snapshots cannot claim guide-reading work", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, pending);
  ctx.tick();
  ctx.respond(ctx.calls.length - 1, {
    ...complete,
    readingGuides: ["fitting"],
  });
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Idle reading state was accepted",
  );
  assert.equal(ctx.client.getSnapshot().conversation.busy, true);
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

for (const [name, args, result] of [
  [
    "discover_guides",
    { library: "curtains" },
    {
      library: "curtains",
      pagePath: "/pages/measuring-curtains",
      title: "Measuring curtains",
      sections: [
        {
          id: `s_${"b".repeat(24)}`,
          title: "Curtains",
          text: "Read the guide.",
        },
      ],
      guides: [],
      diagramNotice:
        "Diagrams and videos were not interpreted; do not infer instructions that depend on them.",
    },
  ],
  ["get_store_support", {}, { status: "unavailable" }],
]) {
  test(`${name} uses one claimed read without approval or catalog parsing`, async (t) => {
    const pending = {
      ...needsTool,
      tools: [{ ...needsTool.tools[0], name, arguments: args }],
    };
    const executions = [];
    const ctx = setup(t, {
      saved: access,
      executor: {
        execute: async (...call) => {
          executions.push(call);
          return result;
        },
        prepareApproval: () =>
          assert.fail("Read-only context needs no approval"),
        executeApproved: () =>
          assert.fail("Read-only context has no approval path"),
      },
    });
    await resume(ctx, pending);
    await until(() => ctx.calls.length === 3, "Context read was not claimed");
    assert.equal("confirmed" in ctx.calls[2].body, false);
    assert.equal(ctx.client.getSnapshot().approval, null);
    assert.equal(
      executions.length,
      0,
      "Execution must wait for its one-use claim",
    );
    ctx.respond(2, { claimed: true });
    await until(
      () => ctx.calls.length === 4,
      "Context result was not submitted",
    );
    assert.equal(executions.length, 1);
    assert.equal(executions[0][0], name);
    assert.deepEqual(JSON.parse(JSON.stringify(executions[0][1])), args);
    assert.deepEqual(ctx.calls[3].body.result, result);
    ctx.respond(3, complete);
  });
}

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

test("library guide cards survive authenticated snapshot restoration with their voice association", async (t) => {
  const part = {
    type: "guides",
    version: 2,
    invocationId,
    libraryPagePath: "/pages/measuring-blinds",
    guides: [
      {
        kind: "measuring",
        url: "https://cdn.shopify.com/s/files/1/0123/4567/files/bay.pdf?v=123",
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
        parts: [{ ...part, libraryPagePath: "/pages/not-a-library" }],
      },
    ],
  });
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Invalid library provenance was accepted",
  );
  assert.equal(ctx.client.getSnapshot().conversation, restored);
});

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

test("carousel snapshots accept ten products and reject eleven", async (t) => {
  for (const count of [10, 11]) {
    await t.test(`${count} products`, async (t) => {
      const saved = JSON.parse(JSON.stringify(recommendations));
      const products = saved.messages[1].parts.find(
        (part) => part.type === "products",
      );
      products.productIds = Array.from(
        { length: count },
        (_, index) => `gid://shopify/Product/${index + 1}`,
      );
      const ctx = setup(t, { saved: access });
      if (count === 10) await resume(ctx, saved);
      else {
        ctx.respond(0, { ...access, conversation: saved });
        await until(
          () => !!ctx.client.getSnapshot().error,
          "Oversized carousel was accepted",
        );
      }
      const state = ctx.client.getSnapshot();
      if (count === 10) {
        assert.equal(state.error, null);
        assert.equal(
          state.conversation.messages[1].parts.find(
            (part) => part.type === "products",
          ).productIds.length,
          10,
        );
      } else {
        assert.match(state.error, /invalid session response/i);
      }
    });
  }
});

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

test("a claimed cart action reports its result during suspension before End chat", async (t) => {
  let finishAction;
  let actionSignal;
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async (name, _args, signal) => {
        assert.equal(name, "add_to_cart");
        executions++;
        actionSignal = signal;
        return new Promise((resolve) => {
          finishAction = () => resolve(addedResult);
        });
      },
    },
  });
  await resume(ctx, needsCartAdd);
  await until(() => ctx.calls.length === 3, "Cart action was not claimed");
  ctx.respond(2, { claimed: true });
  await until(() => !!finishAction, "Claimed action did not begin");

  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspension was not applied",
  );
  assert.equal(actionSignal.aborted, false);
  await ctx.client.stopVoice();
  assert.equal(actionSignal.aborted, false);
  const ending = ctx.client.end();
  await delay(0);
  assert.equal(ctx.calls.length, 3, "End raced the claimed cart action");

  finishAction();
  await until(() => ctx.calls.length === 4, "Cart result was not reported");
  assert.match(ctx.calls[3].url, /\/result$/);
  assert.deepEqual(ctx.calls[3].body.result, addedResult);
  assert.equal(executions, 1);
  ctx.respond(3, complete);
  await until(() => ctx.calls.length === 5, "End did not follow the cart receipt");
  assert.match(ctx.calls[4].url, /\/end$/);
  ctx.respond(4, { ...empty, status: "ended" });
  await ending;
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(executions, 1);
});

test("suspension before a claim response never starts a new storefront action", async (t) => {
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async () => {
        executions++;
        return addedResult;
      },
    },
  });
  await resume(ctx, needsCartAdd);
  await until(() => ctx.calls.length === 3, "Claim request did not start");
  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspension was not applied",
  );
  ctx.respond(2, { claimed: true });
  await delay(0);
  assert.equal(executions, 0);
  assert.equal(ctx.calls.length, 3);
});

test("End retries a lost claimed cart receipt during suspension without replaying the action", async (t) => {
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    executor: {
      execute: async () => {
        executions++;
        return addedResult;
      },
    },
  });
  await resume(ctx, needsCartAdd);
  await until(() => ctx.calls.length === 3, "Cart action was not claimed");
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Cart receipt did not start");
  const original = ctx.calls[3].body;
  ctx.client.setOpen(true);
  ctx.respondAvailability(0, { status: "suspended" });
  await until(
    () => ctx.client.getSnapshot().availability === "suspended",
    "Suspension was not applied",
  );
  ctx.calls[3].reject(new TypeError("Lost receipt response"));
  await delay(0);
  const ending = ctx.client.end();
  await until(() => ctx.calls.length === 5, "End did not retry the receipt");
  assert.match(ctx.calls[4].url, /\/result$/);
  assert.deepEqual(ctx.calls[4].body, original);
  assert.equal(executions, 1);
  ctx.respond(4, complete);
  await until(() => ctx.calls.length === 6, "End did not follow the receipt");
  assert.match(ctx.calls[5].url, /\/end$/);
  ctx.respond(5, { ...empty, status: "ended" });
  await ending;
  assert.equal(executions, 1);
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

test("explicit End voice and End chat preserve text mode while manual voice start clears that tab preference", async (t) => {
  const key = "roman:voice-autostart";
  const ctx = setup(t, { mediaOptions: {} });
  ctx.window.sessionStorage.setItem(key, "off");
  const voice = await activeVoice(ctx);
  assert.equal(ctx.window.sessionStorage.getItem(key), null);
  const stopping = ctx.client.stopVoice();
  assert.equal(ctx.window.sessionStorage.getItem(key), "off");
  ctx.respond(3, {
    ...empty,
    revision: 2,
    voice: { ...voice, status: "closed" },
  });
  await stopping;
  assert.equal(ctx.window.sessionStorage.getItem(key), "off");
  const ending = ctx.client.end();
  ctx.respond(4, { ...empty, status: "ended", revision: 3 });
  await ending;
  assert.equal(ctx.window.sessionStorage.getItem(key), "off");
  const another = setup(t, {
    mediaOptions: {},
    url: "https://unsupported.example/",
  });
  another.window.sessionStorage.setItem(key, "off");
  await assert.rejects(
    another.client.startVoice(),
    /installed development storefronts/,
  );
  assert.equal(another.window.sessionStorage.getItem(key), null);
  another.client.dispose();
  assert.equal(
    another.window.sessionStorage.getItem(key),
    null,
    "internal disposal is not a customer opt-out",
  );
});

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

test("suggested voice answers preserve active media, persist once and reject duplicate/stale choices", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx, voiceQuestion);
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
  assert.equal(ctx.client.getSnapshot().voice.muted, false);
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.tracks[0].enabled, true);
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

test("choosing a saved carousel product is immediate customer input without closing voice", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const carousel = structuredClone(voiceQuestion);
  const choice = {
    carouselId: "44444444-4444-4444-8444-444444444444",
    productId: "gid://shopify/Product/123",
    title: "Green roller blind",
    productPath: "/products/green-roller",
  };
  carousel.messages[0].parts.unshift({
    type: "products",
    version: 1,
    invocationId: choice.carouselId,
    productIds: [choice.productId],
  });
  const voice = await activeVoice(ctx, carousel);
  const text = "I'd like the Green roller blind.";
  await assert.rejects(
    ctx.client.sendMessage(text, {
      ...choice,
      productId: "gid://shopify/Product/999",
    }),
    /shown in this conversation/,
  );
  await assert.rejects(
    ctx.client.sendMessage(text, {
      ...choice,
      productPath: "https://foreign.test/products/green-roller",
    }),
    /product.*path/i,
  );
  assert.equal(ctx.calls.length, 3);
  const sending = ctx.client.sendMessage(text, choice);
  const call = ctx.calls[3];
  assert.deepEqual(
    { ...call.body },
    { clientId: voice.clientId, requestId: call.body.requestId, ...choice },
  );
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(optimistic.parts[0].text, "I'd like the Green roller blind.");
  assert.equal(optimistic.parts[0].productChoice.voiceId, voice.id);
  await assert.rejects(
    ctx.client.sendMessage(text, choice),
    /finished replying/,
  );
  ctx.respond(3, {
    ...carousel,
    revision: 2,
    voice,
    messages: [...carousel.messages, { ...optimistic, status: "complete" }],
  });
  await sending;
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(ctx.client.getSnapshot().voice.muted, false);
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.peers[0].closed, undefined);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
});

test("measurement widget answers retain live audio, unmodified free text and retry identity", async (t) => {
  const ctx = setup(t, {
    mediaOptions: {},
    url: "https://hd-dev-single.myshopify.com/products/example",
  });
  const conversation = structuredClone(voiceQuestion);
  Object.assign(conversation.messages[0].parts[0], {
    question: "What is the width?",
    answers: [],
    measurement: {
      productPath: "/products/example",
      label: "Width",
      unit: "mm",
      instructions: "Measure across the top without deductions.",
    },
  });
  const voice = await activeVoice(ctx, conversation);
  await assert.rejects(
    ctx.client.sendVoiceAnswer(voiceQuestionId, "Drop: 500 cm"),
    /no longer waiting/,
  );
  const sending = ctx.client.sendVoiceAnswer(
    voiceQuestionId,
    "Width: 1 1/2 in or 38 mm",
  );
  const rejected = assert.rejects(sending, /could not connect/);
  assert.equal(
    ctx.client.getSnapshot().optimisticMessage.parts[0].text,
    "Width: 1 1/2 in or 38 mm",
  );
  ctx.calls[3].reject(new Error("offline"));
  await until(() => ctx.calls.length === 5, "Lost answer did not reconcile");
  ctx.respond(4, { ...conversation, revision: 1, voice });
  await rejected;
  const retry = ctx.client.sendVoiceAnswer(
    voiceQuestionId,
    "Width: 1 1/2 in or 38 mm",
  );
  assert.deepEqual(ctx.calls[5].body, ctx.calls[3].body);
  const accepted = acceptedVoiceAnswer(ctx.calls[5].body, voice);
  accepted.messages[0] = conversation.messages[0];
  ctx.respond(5, accepted);
  await retry;
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(
    ctx.calls.some((call) => /\/(?:messages|stop)$/.test(call.url)),
    false,
  );
});

test("measurement answers reject stale current product before the page observation reaches the server", async (t) => {
  const ctx = setup(t, {
    mediaOptions: {},
    url: "https://hd-dev-single.myshopify.com/products/example",
  });
  const conversation = structuredClone(voiceQuestion);
  Object.assign(conversation.messages[0].parts[0], {
    question: "What is the width?",
    answers: [],
    measurement: {
      productPath: "/products/example",
      label: "Width",
      unit: "mm",
      instructions: "Measure across the top.",
    },
  });
  await activeVoice(ctx, conversation);
  ctx.window.history.replaceState({}, "", "/products/other");
  await assert.rejects(
    ctx.client.sendVoiceAnswer(voiceQuestionId, "Width: 500 mm"),
    /no longer waiting/,
  );
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.media.tracks[0].stopped, false);
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
    mediaOptions: {
      getUserMedia: () => Promise.reject({ name: "NotAllowedError" }),
    },
  });
  await assert.rejects(ctx.client.startVoice(), /Allow microphone/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.client.getSnapshot().voice.status, "error");
  assert.equal(ctx.client.getSnapshot().voice.errorCode, "microphone_denied");
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
});

test("device failures stay distinct from permission denial and a new start clears stale denial", async (t) => {
  let name = "NotAllowedError";
  const ctx = setup(t, {
    mediaOptions: { getUserMedia: () => Promise.reject({ name }) },
  });
  await assert.rejects(ctx.client.startVoice(), /Allow microphone/);
  assert.equal(ctx.client.getSnapshot().voice.errorCode, "microphone_denied");
  name = "NotReadableError";
  const starting = ctx.client.startVoice();
  assert.equal(ctx.client.getSnapshot().voice.errorCode, undefined);
  await assert.rejects(starting, /connected and available/);
  assert.equal(ctx.client.getSnapshot().voice.errorCode, undefined);
  assert.equal(ctx.client.getSnapshot().voice.status, "error");
  assert.equal(ctx.calls.length, 0);
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
  assert.equal(ctx.media.tracks[0].enabled, true);
  assert.equal(ctx.client.getSnapshot().voice.muted, false);
  const stopping = ctx.client.stopVoice();
  assert.deepEqual(ctx.calls[4].body, { clientId: voice.clientId });
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

test("transient voice disconnect keeps the active session and performs no stop or restart request", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  await activeVoice(ctx);
  const peer = ctx.media.peers[0];
  peer.connectionState = "disconnected";
  peer.onconnectionstatechange();
  assert.ok([...ctx.timers.values()].some((timer) => timer.ms === 10_000));
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  assert.ok(![...ctx.timers.values()].some((timer) => timer.ms === 10_000));
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.tracks[0].enabled, true);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(ctx.calls.length, 3);
});

test("terminal browser failure reports connection loss instead of a deliberate voice stop", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const warnings = [];
  ctx.window.console.warn = (...args) => warnings.push(args);
  const voice = await activeVoice(ctx);
  ctx.media.peers[0].channel.onclose();
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.match(ctx.calls[3].url, new RegExp(`/voice/${voice.id}/stop$`));
  assert.deepEqual(ctx.calls[3].body, {
    clientId: voice.clientId,
    reason: "connection_lost",
  });
  ctx.respond(3, {
    ...empty,
    revision: 2,
    voice: { ...voice, status: "failed", error: "Voice disconnected." },
  });
  await until(
    () => ctx.client.getSnapshot().voice.status === "error",
    "Browser failure did not settle",
  );
  assert.match(ctx.client.getSnapshot().voice.error, /disconnected/);
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.equal(ctx.media.peers.length, 1);
  assert.equal(warnings[0][1].reason, "data_channel_closed");
  assert.equal(ctx.timers.size, 0);
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
  await assert.rejects(ctx.client.startVoice(), /already connecting/);
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

test("cached product previews require an active conversation and never start network work", async (t) => {
  const reads = [];
  const ids = ["gid://shopify/Product/123"];
  const ctx = setup(t, {
    saved: access,
    executor: {
      getCachedProducts: (requested) => {
        reads.push(requested);
        return catalogResult.products;
      },
      execute: () => assert.fail("Preview must not execute storefront work"),
    },
  });
  assert.equal(ctx.client.getCachedProducts(ids).length, 0);
  assert.equal(reads.length, 0);
  await resume(ctx);
  const requests = ctx.calls.length;
  assert.equal(ctx.client.getCachedProducts(ids), catalogResult.products);
  assert.deepEqual(reads, [ids]);
  assert.equal(ctx.calls.length, requests);
  ctx.client.dispose();
  assert.equal(ctx.client.getCachedProducts(ids).length, 0);
  assert.equal(reads.length, 1);
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

test("active gallery loading uses the display executor and cannot outlive its conversation client", async (t) => {
  const calls = [];
  const gallery = { productPath: "/products/shade", items: [] };
  const ctx = setup(t, {
    saved: access,
    executor: {
      loadProductGallery: async (...args) => {
        calls.push(args);
        return gallery;
      },
      execute: () => assert.fail("Gallery loading is not a model tool"),
    },
  });
  await resume(ctx);
  const controller = new ctx.window.AbortController();
  const url = `${ctx.window.location.origin}/products/shade`;
  assert.equal(
    await ctx.client.loadProductGallery(url, controller.signal),
    gallery,
  );
  assert.equal(calls[0][0], url);
  assert.equal(calls[0][1], controller.signal);
  ctx.client.dispose();
  await assert.rejects(
    ctx.client.loadProductGallery(url, controller.signal),
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

function acceptedVoiceText(input, voice) {
  return {
    ...empty,
    revision: 2,
    voice,
    messages: [
      {
        id: input.requestId,
        role: "user",
        status: "complete",
        createdAt: "2026-09-18T10:00:00Z",
        parts: [
          { type: "text", text: input.text, voiceInput: { voiceId: voice.id } },
        ],
      },
    ],
  };
}

test("a typed welcome reply enters the connected voice without stopping audio", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const voice = await activeVoice(ctx);
  const sending = ctx.client.sendMessage(" Help me measure my windows. ");
  const call = ctx.calls[3];
  assert.match(call.url, /\/answers$/);
  assert.equal(call.body.text, "Help me measure my windows.");
  assert.equal(
    ctx.client.getSnapshot().optimisticMessage.parts[0].text,
    call.body.text,
  );
  ctx.respond(3, acceptedVoiceText(call.body, voice));
  await sending;
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(ctx.client.getSnapshot().voice.muted, false);
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.media.calls.microphone, 1);
  assert.ok(!ctx.calls.some((call) => /\/(?:stop|messages)$/.test(call.url)));
});

test("a welcome tile clicked while connecting is immediate and included once in readiness", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const starting = ctx.client.startVoice();
  const sending = ctx.client.sendMessage(
    "Help me find no-drill blinds for my home.",
  );
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(optimistic.role, "user");
  assert.equal(ctx.client.getSnapshot().pending, true);
  await assert.rejects(
    ctx.client.sendMessage("duplicate"),
    /finished replying/,
  );
  await until(() => ctx.calls.length === 1, "No bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "No voice start");
  const voice = {
    id: ctx.calls[1].body.requestId,
    clientId: ctx.calls[1].body.clientId,
    status: "active",
  };
  ctx.respond(1, { voiceId: voice.id, sdp: "answer" });
  await until(() => !!ctx.media.peers[0].remoteDescription, "No SDP applied");
  ctx.media.connect();
  await starting;
  const input = ctx.readyCalls[0].body.input;
  assert.equal(input.requestId, optimistic.id);
  assert.equal(input.text, optimistic.parts[0].text);
  await until(() => ctx.calls.length >= 3, "No queued-input refresh");
  for (let i = 2; i < ctx.calls.length; i++)
    ctx.respond(i, acceptedVoiceText(input, voice));
  await sending;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[0].parts[0].text,
    input.text,
  );
  assert.equal(ctx.client.getSnapshot().voice.status, "active");
  assert.equal(ctx.media.tracks[0].stopped, false);
  assert.equal(ctx.readyCalls.length, 1);
  assert.ok(
    !ctx.calls.some((call) => /\/(?:answers|stop|messages)$/.test(call.url)),
  );
});

test("a typed reply arriving after readiness dispatch uses the active voice input path once", async (t) => {
  const ctx = setup(t, { mediaOptions: {}, holdReady: true });
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "No bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "No voice start");
  const voice = {
    id: ctx.calls[1].body.requestId,
    clientId: ctx.calls[1].body.clientId,
    status: "active",
  };
  ctx.respond(1, { voiceId: voice.id, sdp: "answer" });
  await until(() => !!ctx.media.peers[0].remoteDescription, "No SDP applied");
  ctx.media.connect();
  await until(() => ctx.readyCalls.length === 1, "No ready");
  assert.equal(ctx.readyCalls[0].body.input, undefined);
  const sending = ctx.client.sendMessage("I need blinds for my kitchen.");
  assert.equal(
    ctx.client.getSnapshot().optimisticMessage.parts[0].text,
    "I need blinds for my kitchen.",
  );
  ctx.respondReady(0, { ok: true });
  await starting;
  await until(
    () => ctx.calls.some((call) => call.url.endsWith("/answers")),
    "No voice input",
  );
  const inputIndex = ctx.calls.findIndex((call) =>
    call.url.endsWith("/answers"),
  );
  const snapshot = acceptedVoiceText(ctx.calls[inputIndex].body, voice);
  for (let i = 2; i < ctx.calls.length; i++) ctx.respond(i, snapshot);
  await sending;
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/answers")).length,
    1,
  );
  assert.equal(ctx.media.tracks[0].stopped, false);
});

test("stopping voice cancels queued welcome input without waiting for microphone permission", async (t) => {
  let permit;
  const ctx = setup(t, {
    mediaOptions: {
      getUserMedia: (stream) =>
        new Promise((resolve) => {
          permit = () => resolve(stream);
        }),
    },
  });
  const starting = ctx.client.startVoice();
  const sending = ctx.client.sendMessage("Help me measure.");
  const rejected = assert.rejects(sending, /Voice was stopped/);
  await ctx.client.stopVoice();
  await rejected;
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.calls.length, 0);
  permit();
  await starting;
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.media.tracks[0].stopped, true);
});

test("a lost readiness response reconciles its saved welcome input without asking the customer to resend it", async (t) => {
  const ctx = setup(t, { mediaOptions: {}, holdReady: true });
  const starting = ctx.client.startVoice().catch(() => undefined);
  let outcome;
  const sending = ctx.client.sendMessage("Help me measure my windows.").then(
    () => {
      outcome = { accepted: true };
    },
    (error) => {
      outcome = { accepted: false, error };
    },
  );
  await until(() => ctx.calls.length === 1, "No bootstrap");
  ctx.respond(0, { ...access, conversation: empty });
  await until(() => ctx.calls.length === 2, "No voice start");
  const voice = {
    id: ctx.calls[1].body.requestId,
    clientId: ctx.calls[1].body.clientId,
    status: "active",
  };
  ctx.respond(1, { voiceId: voice.id, sdp: "answer" });
  await until(() => !!ctx.media.peers[0].remoteDescription, "No SDP applied");
  ctx.media.connect();
  await until(() => ctx.readyCalls.length === 1, "No readiness input");
  const input = ctx.readyCalls[0].body.input;
  assert.equal(input.text, "Help me measure my windows.");
  const saved = {
    ...acceptedVoiceText(input, voice),
    revision: 3,
    voice: { ...voice, status: "failed", error: "Voice disconnected." },
  };
  // The server saved and accepted the message, but its HTTP response was lost.
  ctx.readyCalls[0].reject(new TypeError("Connection lost after acceptance"));
  let answered = 2;
  await until(() => {
    while (answered < ctx.calls.length) ctx.respond(answered++, saved);
    return !!outcome;
  }, "Saved readiness input did not reconcile");
  await sending;
  await starting;
  assert.equal(outcome.accepted, true, outcome.error?.message);
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(ctx.client.getSnapshot().conversation.messages.length, 1);
  assert.equal(
    ctx.client.getSnapshot().conversation.messages[0].id,
    input.requestId,
  );
  assert.equal(ctx.media.tracks[0].stopped, true);
  assert.equal(ctx.readyCalls.length, 1);
  assert.ok(
    !ctx.calls.some((call) => /\/(?:answers|messages)$/.test(call.url)),
  );
});

test("a text retry after stopping an in-flight voice bootstrap shares that same conversation", async (t) => {
  const ctx = setup(t, { mediaOptions: {} });
  const starting = ctx.client.startVoice();
  await until(() => ctx.calls.length === 1, "No voice bootstrap");
  await ctx.client.stopVoice();
  assert.equal(ctx.client.getSnapshot().voice.status, "idle");
  assert.equal(ctx.media.tracks[0].stopped, true);
  const sending = ctx.client.sendMessage("Help me find no-drill blinds.");
  assert.equal(
    ctx.calls.length,
    1,
    "Text started a second conversation bootstrap",
  );
  ctx.respond(0, { ...access, conversation: empty });
  await until(
    () => ctx.calls.length === 2,
    "Text did not use the completed bootstrap",
  );
  assert.equal(
    ctx.calls[1].url,
    `${access.apiBaseUrl}/${conversationId}/messages`,
  );
  assert.equal(ctx.calls[1].body.text, "Help me find no-drill blinds.");
  ctx.respond(1, {
    ...pending,
    messages: [
      {
        ...pending.messages[0],
        requestId: ctx.calls[1].body.requestId,
        parts: [{ type: "text", text: ctx.calls[1].body.text }],
      },
      pending.messages[1],
    ],
  });
  await sending;
  await starting;
  assert.equal(ctx.client.getSnapshot().conversation.id, conversationId);
  assert.equal(ctx.client.getSnapshot().pending, false);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(
    ctx.calls.filter((call) => call.url.includes("/apps/roman/bootstrap"))
      .length,
    1,
  );
  assert.ok(!ctx.calls.some((call) => /\/(?:voice|answers)$/.test(call.url)));
});

for (const [name, role, voiceInput, extra] of [
  [
    "assistant provenance",
    "assistant",
    { voiceId: "22222222-2222-4222-8222-222222222222" },
    {},
  ],
  ["invalid voice ID", "user", { voiceId: "invalid" }, {}],
  [
    "unexpected reference fields",
    "user",
    { voiceId: "22222222-2222-4222-8222-222222222222", confirmed: true },
    {},
  ],
  [
    "conflicting question provenance",
    "user",
    { voiceId: "22222222-2222-4222-8222-222222222222" },
    {
      questionAnswer: {
        voiceId: "22222222-2222-4222-8222-222222222222",
        questionId: "33333333-3333-4333-8333-333333333333",
      },
    },
  ],
]) {
  test(`typed voice input rejects ${name} without replacing valid history`, async (t) => {
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
          parts: [
            { type: "text", text: "Help me measure.", voiceInput, ...extra },
          ],
        },
      ],
    });
    await until(
      () => !!ctx.client.getSnapshot().error,
      "Invalid voice input was accepted",
    );
    assert.match(
      ctx.client.getSnapshot().error,
      /invalid conversation response/,
    );
    assert.equal(ctx.client.getSnapshot().conversation, before);
  });
}

const textProductChoice = {
  carouselId: "44444444-4444-4444-8444-444444444444",
  productId: "gid://shopify/Product/123",
  title: "Green roller blind",
  productPath: "/products/green-roller",
};
const textProductCarousel = {
  ...empty,
  messages: [
    {
      id: "text-product-carousel",
      role: "assistant",
      status: "complete",
      createdAt: "2026-09-18T10:00:00Z",
      parts: [
        {
          type: "products",
          version: 1,
          invocationId: textProductChoice.carouselId,
          productIds: [
            textProductChoice.productId,
            "gid://shopify/Product/456",
          ],
        },
      ],
    },
  ],
};
function acceptedTextProduct(optimistic) {
  return {
    ...textProductCarousel,
    revision: 1,
    messages: [
      ...textProductCarousel.messages,
      { ...optimistic, status: "complete" },
    ],
  };
}

test("stale, incomplete and removed carousel provenance fails before any text or voice request", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const source of ["pending", "failed", "removed"]) {
      await t.test(`${mode}: ${source}`, async (t) => {
        const ctx = setup(
          t,
          mode === "voice" ? { mediaOptions: {} } : { saved: access },
        );
        const carousel = {
          ...textProductCarousel,
          messages:
            source === "removed"
              ? []
              : textProductCarousel.messages.map((message) => ({
                  ...message,
                  status: source,
                })),
        };
        if (mode === "voice") await activeVoice(ctx, carousel);
        else await resume(ctx, carousel);
        const count = ctx.calls.length;
        await assert.rejects(
          ctx.client.sendMessage(
            "I'd like the Green roller blind.",
            textProductChoice,
          ),
          /completed carousel.*Remove an unavailable queued choice/,
        );
        assert.equal(ctx.calls.length, count);
        assert.equal(ctx.client.getSnapshot().optimisticMessage ?? null, null);
        if (mode === "voice") {
          assert.equal(ctx.client.getSnapshot().voice.status, "active");
          assert.equal(ctx.media.tracks[0].stopped, false);
        }
      });
    }
  }
});

test("text card choices publish friendly optimistic text with exact product metadata and preserve it on uncertain retry", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, textProductCarousel);
  const text = "I'd like the Green roller blind.";
  await assert.rejects(
    ctx.client.sendMessage("Add it now", textProductChoice),
    /does not match/,
  );
  assert.equal(ctx.calls.length, 2);
  const sending = ctx.client.sendMessage(text, textProductChoice);
  const rejected = assert.rejects(sending, /could not connect/);
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.equal(optimistic.parts[0].text, text);
  assert.doesNotMatch(optimistic.parts[0].text, /\/products\//);
  assert.deepEqual(
    JSON.parse(JSON.stringify(optimistic.parts[0].productChoice)),
    textProductChoice,
  );
  await until(() => ctx.calls.length === 3, "Choice POST did not start");
  const originalRequest = ctx.calls[2].body;
  assert.deepEqual(originalRequest, {
    requestId: optimistic.requestId,
    text,
    productChoice: textProductChoice,
  });
  ctx.calls[2].reject(new TypeError("Lost response"));
  await until(() => ctx.calls.length === 4, "Choice was not reconciled");
  ctx.respond(3, textProductCarousel);
  await rejected;
  const retry = ctx.client.sendMessage(text, textProductChoice);
  assert.equal(
    ctx.client.getSnapshot().optimisticMessage.requestId,
    optimistic.requestId,
  );
  await until(() => ctx.calls.length === 5, "Choice retry did not start");
  assert.deepEqual(ctx.calls[4].body, originalRequest);
  ctx.respond(4, acceptedTextProduct(optimistic));
  await retry;
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        ctx.client.getSnapshot().conversation.messages.at(-1).parts[0]
          .productChoice,
      ),
    ),
    textProductChoice,
  );
});

test("lost text product choice responses reconcile accepted structured selections without replay", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, textProductCarousel);
  const sending = ctx.client.sendMessage(
    "I'd like the Green roller blind.",
    textProductChoice,
  );
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  await until(() => ctx.calls.length === 3, "Choice POST did not start");
  ctx.calls[2].reject(new TypeError("Lost response"));
  await until(() => ctx.calls.length === 4, "Choice was not reconciled");
  ctx.respond(3, acceptedTextProduct(optimistic));
  await sending;
  assert.equal(ctx.client.getSnapshot().error, null);
  assert.equal(ctx.client.getSnapshot().optimisticMessage, null);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/messages")).length,
    1,
  );
});

test("a different selected product cannot reuse an uncertain request just because its title is identical", async (t) => {
  const ctx = setup(t, { saved: access });
  await resume(ctx, textProductCarousel);
  const text = "I'd like the Green roller blind.";
  const sending = ctx.client.sendMessage(text, textProductChoice);
  const rejected = assert.rejects(sending, /could not connect/);
  const firstRequest = ctx.client.getSnapshot().optimisticMessage.requestId;
  await until(() => ctx.calls.length === 3, "Choice POST did not start");
  ctx.calls[2].reject(new TypeError("Lost response"));
  await until(() => ctx.calls.length === 4, "Choice was not reconciled");
  ctx.respond(3, textProductCarousel);
  await rejected;
  const changed = {
    ...textProductChoice,
    productId: "gid://shopify/Product/456",
    productPath: "/products/another-green-roller",
  };
  const second = ctx.client.sendMessage(text, changed);
  const optimistic = ctx.client.getSnapshot().optimisticMessage;
  assert.notEqual(optimistic.requestId, firstRequest);
  await until(
    () => ctx.calls.length === 5,
    "Different choice POST did not start",
  );
  assert.deepEqual(ctx.calls[4].body.productChoice, changed);
  ctx.respond(4, acceptedTextProduct(optimistic));
  await second;
});
