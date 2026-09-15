/* global globalThis */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

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
  { saved, url = "https://hd-dev-single.myshopify.com/", catalog } = {},
) {
  const dom = new JSDOM("<!doctype html>", { url, runScripts: "outside-only" });
  const { window } = dom;
  // Use the browser-standard AbortSignal.any/timeout behavior available in Node;
  // JSDOM's subset need not implement these transport primitives itself.
  window.AbortController = globalThis.AbortController;
  window.AbortSignal = globalThis.AbortSignal;
  if (saved)
    window.sessionStorage.setItem("roman:conversation", JSON.stringify(saved));
  const calls = [];
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
      calls.push({
        url: String(url),
        init,
        body: init.body ? JSON.parse(init.body) : undefined,
        resolve,
        reject,
      });
    });
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanSession = RomanSession;`,
  );
  const client = window.RomanSession.createConversationClient(catalog);
  let notifications = 0;
  client.subscribe(() => {
    notifications++;
  });
  t.after(() => {
    client.dispose();
    window.close();
  });
  function respond(index, body, status = 200) {
    calls[index].resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
    });
  }
  function tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
  }
  return {
    client,
    window,
    calls,
    timers,
    respond,
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
    "https://hd-dev-single.myshopify.com/apps/roman/bootstrap",
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
    "https://hd-dev-single.myshopify.com/apps/roman/bootstrap",
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
    catalog: {
      execute: async (...args) => {
        executions.push(["first", ...args]);
        return catalogResult;
      },
    },
  });
  const second = setup(t, {
    saved: access,
    catalog: {
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
  let executions = 0;
  const ctx = setup(t, {
    saved: access,
    catalog: {
      execute: async () => {
        executions++;
        return catalogResult;
      },
    },
  });
  await resume(ctx, needsTool);
  await until(() => ctx.calls.length === 3, "Tool claim did not start");
  ctx.respond(2, { claimed: true });
  await until(() => ctx.calls.length === 4, "Tool result did not start");
  const original = ctx.calls[3].body;
  ctx.calls[3].reject(new TypeError("Lost result response"));
  await until(
    () => !!ctx.client.getSnapshot().error,
    "Lost result was not surfaced",
  );
  assert.equal(executions, 1);
  ctx.tick();
  await until(() => ctx.calls.length === 5, "Pending tool was not polled");
  ctx.respond(4, {
    ...needsTool,
    revision: 2,
    tools: [{ ...needsTool.tools[0], status: "running" }],
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

test("End prevents a late browser catalog result from being posted into the closed chat", async (t) => {
  let resolveLookup;
  const ctx = setup(t, {
    saved: access,
    catalog: {
      execute: () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    },
  });
  await resume(ctx, needsTool);
  await until(() => ctx.calls.length === 3, "Tool claim did not start");
  ctx.respond(2, { claimed: true });
  await until(() => !!resolveLookup, "Catalog execution did not start");
  const ending = ctx.client.end();
  assert.match(ctx.calls[3].url, /\/end$/);
  ctx.respond(3, { ...complete, status: "ended", revision: 3 });
  await ending;
  resolveLookup(catalogResult);
  await delay(0);
  assert.equal(
    ctx.calls.filter((call) => call.url.endsWith("/result")).length,
    0,
  );
  assert.equal(ctx.client.getSnapshot().conversation, null);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
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
