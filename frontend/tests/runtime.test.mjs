import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/main.tsx"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanAssistant",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "dataurl", ".css": "text", ".woff2": "dataurl" },
});

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function setup(t, initialTime = 0) {
  const dom = new JSDOM(
    `<!doctype html><html data-roman-preview="true"><head><title>Store</title></head>
    <body><app-provider><main id="main">Store content</main></app-provider>
    <roman-ai-assistant data-shop="hd-dev-multi.myshopify.com" data-logo-url="/roman-logo.svg"></roman-ai-assistant></body></html>`,
    {
      url: "https://hd-dev-multi.myshopify.com/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  Object.assign(window, { Request, Response, Headers });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  let now = initialTime;
  let nextTimer = 900000;
  const timers = new Map();
  const setTimeout = window.setTimeout.bind(window);
  const clearTimeout = window.clearTimeout.bind(window);
  window.performance.now = () => now;
  window.setTimeout = (callback, milliseconds, ...args) => {
    // Leave React's immediate scheduling real while controlling loading delays.
    if (!(milliseconds > 0 && milliseconds <= 1000))
      return setTimeout(callback, milliseconds, ...args);
    const id = nextTimer++;
    timers.set(id, {
      at: now + milliseconds,
      callback: () => callback(...args),
    });
    return id;
  };
  window.clearTimeout = (id) => {
    if (!timers.delete(id)) clearTimeout(id);
  };
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanAssistant = RomanAssistant;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const runtimes = [];
  t.after(() => {
    for (const runtime of runtimes) runtime.dispose();
    window.close();
  });
  return {
    window,
    container,
    timers,
    mount(loadingStartedAt, onSessionChange) {
      const runtime = window.RomanAssistant.mountAssistant(
        host,
        container,
        loadingStartedAt,
        onSessionChange,
      );
      const result = { runtime, state: "pending", error: undefined };
      runtime.ready.then(
        () => {
          result.state = "ready";
        },
        (error) => {
          result.state = "rejected";
          result.error = error;
        },
      );
      runtimes.push(runtime);
      return result;
    },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await delay(0);
    },
  };
}

test("runtime reports confirmed conversation activity, not an open panel or saved credential hint", async (t) => {
  const ctx = setup(t, 1000);
  const access = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    token: "a".repeat(43),
    expiresAt: "2099-09-15T10:00:00Z",
    apiBaseUrl: "https://roman.example/api/conversations",
  };
  const conversation = {
    id: access.conversationId,
    messages: [],
    status: "active",
    busy: false,
    revision: 0,
    tools: [],
  };
  ctx.window.sessionStorage.setItem(
    "roman:conversation",
    JSON.stringify(access),
  );
  let resolveBootstrap;
  let resolveEnd;
  const response = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  });
  ctx.window.fetch = async (url) => {
    if (String(url).includes("/apps/roman/bootstrap"))
      return new Promise((resolve) => {
        resolveBootstrap = resolve;
      });
    if (String(url).endsWith("/end"))
      return new Promise((resolve) => {
        resolveEnd = resolve;
      });
    return response(conversation);
  };
  const activity = [];
  const mounted = ctx.mount(0, (active) => activity.push(active));
  mounted.runtime.setOpen(true);
  assert.ok(activity.length > 0);
  assert.ok(activity.every((active) => active === false));
  resolveBootstrap(response({ ...access, conversation }));
  await until(
    () => activity.at(-1) === true,
    "restored conversation did not activate launcher state",
  );
  await until(
    () =>
      [...ctx.container.querySelectorAll("button")].some(
        (button) => button.textContent === "End chat" && !button.disabled,
      ),
    "restoration did not finish",
  );
  mounted.runtime.setOpen(false);
  assert.equal(
    activity.at(-1),
    true,
    "closing the sidebar must not end its conversation",
  );
  [...ctx.container.querySelectorAll("button")]
    .find((button) => button.textContent === "End chat")
    .click();
  await until(() => ctx.container.querySelector(".roman-end-confirm"), "Confirmation missing");
  assert.equal(resolveEnd, undefined, "Opening confirmation must not send End");
  ctx.container.querySelector(".roman-end-confirm").click();
  await until(() => !!resolveEnd, "End request was not sent");
  assert.equal(
    activity.at(-1),
    true,
    "the pending End request must retain confirmed session state",
  );
  resolveEnd(response({ ...conversation, status: "ended", revision: 1 }));
  await until(
    () => activity.at(-1) === false,
    "confirmed End did not deactivate launcher state",
  );
  mounted.runtime.dispose();
  assert.equal(activity.at(-1), false);
});

test("opening requests microphone once and permission denial leaves text usable without creating a session", async (t) => {
  const ctx = setup(t, 1000);
  let permissionRequests = 0;
  let requests = 0;
  Object.defineProperty(ctx.window.navigator, "mediaDevices", {
    value: {
      async getUserMedia() {
        permissionRequests++;
        throw new Error("Permission denied");
      },
    },
    configurable: true,
  });
  ctx.window.RTCPeerConnection = class {};
  ctx.window.fetch = async () => {
    requests++;
    throw new Error("Permission must precede conversation bootstrap");
  };
  const mounted = ctx.mount(0);
  await until(() => mounted.state === "ready", "runtime did not mount");
  assert.equal(
    permissionRequests,
    0,
    "closed restoration must not request microphone",
  );
  mounted.runtime.setOpen(true);
  await until(
    () => ctx.container.textContent.includes("Allow microphone access"),
    "permission failure was not explained",
  );
  const textarea = ctx.container.querySelector(".roman-composer textarea");
  assert.ok(textarea);
  assert.equal(textarea.disabled, false);
  assert.equal(textarea.readOnly, false);
  assert.equal(requests, 0);
  mounted.runtime.setOpen(false);
  mounted.runtime.setOpen(true);
  await delay(0);
  assert.equal(permissionRequests, 1);
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
});

test("a fast cached runtime waits until one second from loading start and React commit", async (t) => {
  const ctx = setup(t, 1200);
  const mount = ctx.mount(1000);
  assert.equal(mount.state, "pending");
  await until(
    () => ctx.timers.size === 1,
    "committed React content did not schedule the remaining loading time",
  );
  assert.ok(ctx.container.querySelector(".roman-tools"));
  await ctx.advance(799);
  assert.equal(mount.state, "pending");
  await ctx.advance(1);
  assert.equal(mount.state, "ready");
  assert.equal(ctx.timers.size, 0);
});

test("a slow download adds no further loading delay after React commits", async (t) => {
  const ctx = setup(t, 1600);
  const mount = ctx.mount(0);
  await until(
    () => mount.state === "ready",
    "already elapsed loading time should not add another second",
  );
  assert.ok(ctx.container.querySelector(".roman-tools"));
  assert.equal(ctx.timers.size, 0);
});

test("closing, reopening and remounting on the same document do not restart loading time", async (t) => {
  const ctx = setup(t);
  const first = ctx.mount(0);
  await until(() => ctx.timers.size === 1, "loading delay was not scheduled");
  const content = ctx.container.querySelector("h1");
  await ctx.advance(400);
  first.runtime.setOpen(false);
  first.runtime.setOpen(true);
  assert.equal(ctx.timers.size, 1);
  await ctx.advance(599);
  assert.equal(first.state, "pending");
  await ctx.advance(1);
  assert.equal(first.state, "ready");
  assert.equal(ctx.container.querySelector("h1"), content);
  first.runtime.dispose();
  const second = ctx.mount(1000);
  await until(
    () => second.state === "ready",
    "a later mount restarted the loading delay",
  );
  assert.equal(ctx.timers.size, 0);
});

test("disposal clears the loading timer and a retry uses only the original remaining time", async (t) => {
  const ctx = setup(t);
  const first = ctx.mount(0);
  await until(() => ctx.timers.size === 1, "loading delay was not scheduled");
  const queuedCallback = ctx.timers.values().next().value.callback;
  await ctx.advance(400);
  first.runtime.dispose();
  await delay(0);
  assert.equal(first.state, "rejected");
  assert.equal(first.error.name, "AbortError");
  assert.equal(ctx.timers.size, 0);
  assert.equal(ctx.container.childElementCount, 0);
  queuedCallback();
  await delay(0);
  assert.equal(
    first.state,
    "rejected",
    "an already queued timer must not make a disposed runtime ready",
  );
  const second = ctx.mount(400);
  await until(
    () => ctx.timers.size === 1,
    "retry did not retain the remaining delay",
  );
  await ctx.advance(599);
  assert.equal(second.state, "pending");
  await ctx.advance(1);
  assert.equal(second.state, "ready");
});

test("a fresh document gets its own minimum loading period", async (t) => {
  const firstPage = setup(t);
  const first = firstPage.mount(0);
  await until(
    () => firstPage.timers.size === 1,
    "first document did not schedule loading",
  );
  await firstPage.advance(1000);
  assert.equal(first.state, "ready");
  const refreshedPage = setup(t);
  const refreshed = refreshedPage.mount(0);
  await until(
    () => refreshedPage.timers.size === 1,
    "fresh document did not reset the loading period",
  );
  await refreshedPage.advance(999);
  assert.equal(refreshed.state, "pending");
  await refreshedPage.advance(1);
  assert.equal(refreshed.state, "ready");
});
