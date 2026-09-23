import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { voiceMedia } from "./helpers/voice-media.mjs";

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
  window.scrollTo = () => {};
  Object.assign(window, {
    Request,
    Response,
    Headers,
    AbortController,
    AbortSignal,
  });
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
    mount(loadingStartedAt) {
      const runtime = window.RomanAssistant.mountAssistant(
        host,
        container,
        loadingStartedAt,
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

test("closing text-only Roman preserves its saved conversation and pending storefront work", async (t) => {
  const ctx = setup(t, 1000);
  const access = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    token: "a".repeat(43),
    expiresAt: "2099-09-15T10:00:00Z",
    apiBaseUrl: "https://roman.example/api/conversations",
  };
  const conversation = {
    id: access.conversationId,
    messages: [
      {
        id: "saved-request",
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Help me choose a blind." }],
        createdAt: "2026-09-22T09:59:00Z",
      },
      {
        id: "saved-reply",
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "Your saved conversation." }],
        createdAt: "2026-09-22T10:00:00Z",
      },
    ],
    status: "active",
    busy: true,
    revision: 0,
    tools: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "get_cart",
        arguments: {},
        status: "pending",
      },
    ],
  };
  ctx.window.sessionStorage.setItem(
    "roman:conversation",
    JSON.stringify(access),
  );
  let resolveCart;
  let cartSignal;
  let resultReceived = false;
  const calls = [];
  const response = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  });
  ctx.window.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/apps/roman/availability"))
      return response({ status: "available" });
    if (String(url).includes("/apps/roman/bootstrap"))
      return response({ ...access, conversation });
    if (String(url).endsWith("/claim")) return response({ claimed: true });
    if (String(url).endsWith("/cart.js")) {
      cartSignal = init.signal;
      return new Promise((resolve) => {
        resolveCart = resolve;
      });
    }
    if (String(url).endsWith("/result")) {
      resultReceived = true;
      return response({ ...conversation, revision: 1, tools: [], busy: false });
    }
    return response({ ...conversation, streamRevision: 0 });
  };
  const mounted = ctx.mount(0);
  mounted.runtime.setOpen(true);
  await until(() => !!resolveCart, "restored tool did not start");
  await until(
    () => ctx.container.textContent.includes("Your saved conversation."),
    "history was not restored",
  );
  mounted.runtime.setOpen(false);
  assert.equal(cartSignal.aborted, false, "text tool was cancelled by closing");
  resolveCart(
    response({ items: [], item_count: 0, total_price: 0, currency: "GBP" }),
  );
  await until(
    () => resultReceived,
    "the hidden text tool did not return its result",
  );
  assert.equal(
    calls.some((url) => /\/(?:end|stop)$/.test(url)),
    false,
  );
  assert.equal(
    JSON.parse(ctx.window.sessionStorage.getItem("roman:conversation"))
      .conversationId,
    access.conversationId,
  );
  mounted.runtime.setOpen(true);
  assert.match(ctx.container.textContent, /Your saved conversation/);
});

test("opening requests microphone once and permission denial leaves text usable without creating a session", async (t) => {
  const ctx = setup(t, 1000);
  let permissionRequests = 0;
  let requests = 0;
  Object.defineProperty(ctx.window.navigator, "mediaDevices", {
    value: {
      async getUserMedia() {
        permissionRequests++;
        throw new ctx.window.DOMException(
          "Permission denied",
          "NotAllowedError",
        );
      },
    },
    configurable: true,
  });
  ctx.window.RTCPeerConnection = class {};
  ctx.window.fetch = async (url) => {
    if (String(url).endsWith("/apps/roman/availability"))
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ status: "available" }),
      };
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
  await delay(0);
  await until(
    () =>
      permissionRequests === 1 &&
      ctx.container.querySelector(".roman-composer textarea") &&
      ctx.container.querySelector('[aria-label="Start voice"]'),
    "permission denial did not restore text mode",
  );
  assert.equal(ctx.container.querySelector(".roman-dialog"), null);
  assert.doesNotMatch(ctx.container.textContent, /Allow microphone access/);
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

function voiceBackend(ctx) {
  const access = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    token: "a".repeat(43),
    expiresAt: "2099-09-15T10:00:00Z",
    apiBaseUrl: "https://roman.example/api/conversations",
  };
  const conversation = {
    id: access.conversationId,
    messages: [
      {
        id: "saved-request",
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "Help me choose a blind." }],
        createdAt: "2026-09-22T09:59:00Z",
      },
      {
        id: "saved-reply",
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "Your saved conversation." }],
        createdAt: "2026-09-22T10:00:00Z",
      },
    ],
    status: "active",
    busy: false,
    revision: 0,
    tools: [],
  };
  let voice;
  const stops = [];
  const calls = [];
  const response = (body, status = 200) => ({
    ok: status === 200,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  });
  ctx.window.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith("/apps/roman/availability"))
      return response({ status: "available" });
    calls.push(url);
    if (url.includes("/apps/roman/bootstrap"))
      return response({ ...access, conversation });
    if (url.endsWith("/voice")) {
      const input = JSON.parse(init.body);
      voice = {
        id: input.requestId,
        clientId: input.clientId,
        status: "starting",
      };
      return response({ voiceId: voice.id, sdp: "v=0\r\no=roman-answer" });
    }
    if (url.endsWith("/ready")) {
      voice.status = "active";
      return response({ ok: true });
    }
    if (url.endsWith("/stop"))
      return new Promise((resolve) => {
        stops.push((failed = false) => {
          if (!failed) voice.status = "closed";
          resolve(
            response(
              { ...conversation, voice, revision: ++conversation.revision },
              failed ? 500 : 200,
            ),
          );
        });
      });
    return response({ ...conversation, voice, streamRevision: 0 });
  };
  return { access, stops, calls };
}

for (const stopFails of [false, true]) {
  test(`closing active voice stops media immediately and preserves chat${stopFails ? " even when finalization fails" : ""}`, async (t) => {
    const ctx = setup(t, 1000);
    const media = voiceMedia(ctx.window);
    const backend = voiceBackend(ctx);
    const mounted = ctx.mount(0);
    mounted.runtime.setOpen(false);
    assert.equal(
      ctx.window.sessionStorage.getItem("roman:voice-autostart"),
      null,
    );
    mounted.runtime.setOpen(true);
    await until(
      () => !!media.peers[0]?.remoteDescription,
      "voice offer was not accepted",
    );
    media.connect();
    await until(
      () => !!ctx.container.querySelector(".roman-voice-waveform"),
      "voice did not connect",
    );
    const savedAccess = ctx.window.sessionStorage.getItem("roman:conversation");
    mounted.runtime.setOpen(false);
    assert.equal(media.tracks[0].stopped, true);
    assert.equal(media.peers[0].closed, true);
    assert.equal(media.peers[0].channel.closed, true);
    assert.ok(media.calls.pause > 0);
    assert.equal(backend.stops.length, 1);
    assert.equal(
      ctx.container.getRootNode().children.length,
      1,
      "closed UI created a separate dock",
    );
    mounted.runtime.setOpen(false);
    mounted.runtime.setOpen(true);
    assert.equal(backend.stops.length, 1);
    assert.equal(media.calls.microphone, 1, "reopening restarted voice");
    backend.stops[0](stopFails);
    if (stopFails) {
      await until(
        () =>
          ctx.container.textContent.includes("could not confirm voice ended"),
        "stop error was not retained",
      );
      const end = ctx.container.querySelector('[aria-label="End voice"]');
      assert.ok(end && !end.disabled);
      end.click();
      await until(() => backend.stops.length === 2, "stop retry missing");
      backend.stops[1]();
    }
    await until(
      () => !!ctx.container.querySelector('[aria-label="Start voice"]'),
      "stopped voice did not restore text mode",
    );
    assert.equal(media.calls.microphone, 1);
    assert.equal(
      ctx.window.sessionStorage.getItem("roman:conversation"),
      savedAccess,
    );
    assert.match(ctx.container.textContent, /Your saved conversation/);
    assert.equal(
      backend.calls.some((url) => url.endsWith("/end")),
      false,
    );
  });
}

test("closing during microphone permission prevents a late grant from starting voice", async (t) => {
  const ctx = setup(t, 1000);
  let grant;
  const media = voiceMedia(ctx.window, {
    getUserMedia: (stream) =>
      new Promise((resolve) => {
        grant = () => resolve(stream);
      }),
  });
  const backend = voiceBackend(ctx);
  const mounted = ctx.mount(0);
  mounted.runtime.setOpen(true);
  await until(
    () => media.calls.microphone === 1,
    "voice did not begin after availability was confirmed",
  );
  mounted.runtime.setOpen(false);
  grant();
  await until(
    () => media.tracks[0].stopped,
    "late microphone track was not stopped",
  );
  mounted.runtime.setOpen(true);
  await delay(0);
  assert.equal(media.calls.microphone, 1);
  assert.equal(media.peers.length, 0);
  assert.deepEqual(backend.calls, []);
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
