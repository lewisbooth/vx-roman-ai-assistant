import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { voiceMedia } from "./helpers/voice-media.mjs";
import { historySnapshot } from "./helpers/history-snapshot.mjs";

function wire(body) {
  if (body?.conversation) return { ...body, conversation: wire(body.conversation) };
  return Array.isArray(body?.messages)
    ? { ...historySnapshot(body), current: body.current ?? { activeProduct: null, pendingQuestion: null, hasCustomerReply: true } }
    : body;
}

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
  const panel = window.document.createElement("section");
  panel.className = "roman-panel";
  panel.dataset.romanPanel = "";
  const container = window.document.createElement("div");
  container.dataset.romanContent = "";
  panel.append(container);
  host.attachShadow({ mode: "open" }).append(panel);
  const runtimes = [];
  const themes = [];
  t.after(() => {
    for (const runtime of runtimes) runtime.dispose();
    window.close();
  });
  return {
    window,
    panel,
    container,
    themes,
    timers,
    mount(loadingStartedAt) {
      const runtime = window.RomanAssistant.mountAssistant(
        host,
        container,
        loadingStartedAt,
        (welcome) => {
          themes.push(welcome);
          panel.toggleAttribute("data-welcome-theme", welcome);
        },
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
    json: async () => wire(body),
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
    json: async () => wire(body),
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
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  assert.deepEqual(ctx.themes, [true], "fresh welcome appearance must be ready before the loader is revealed");
  await ctx.advance(799);
  assert.equal(mount.state, "pending");
  await ctx.advance(1);
  assert.equal(mount.state, "ready");
  assert.equal(ctx.timers.size, 0);
});

for (const hasCustomerReply of [false, true]) {
  test(`the loader waits for restored ${hasCustomerReply ? "customer history" : "voice greeting"} before publishing its final appearance`, async (t) => {
    const ctx = setup(t, 1500);
    const access = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      token: "a".repeat(43),
      expiresAt: "2099-10-02T10:00:00Z",
      apiBaseUrl: "https://roman.example/api/conversations",
    };
    const conversation = {
      id: access.conversationId,
      status: "active",
      busy: false,
      revision: 0,
      tools: [],
      current: { activeProduct: null, pendingQuestion: null, hasCustomerReply },
      messages: [{
        id: "opening-greeting",
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: "Hi! I'm Roman." }],
        createdAt: "2026-10-02T10:00:00Z",
      }],
    };
    ctx.window.sessionStorage.setItem("roman:conversation", JSON.stringify(access));
    // The hint is deliberately stale: restored application state must win.
    ctx.window.sessionStorage.setItem("roman:welcome-state", JSON.stringify({ conversationId: access.conversationId, welcome: hasCustomerReply }));
    let finishBootstrap;
    let finishRead;
    const response = (value) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => wire(value),
    });
    ctx.window.fetch = async (url) => {
      if (String(url).includes("/apps/roman/bootstrap"))
        return new Promise((resolve) => {
          finishBootstrap = () => resolve(response({ ...access, conversation }));
        });
      return new Promise((resolve) => {
        finishRead = () => resolve(response({ ...conversation, streamRevision: 0 }));
      });
    };
    const mounted = ctx.mount(0);
    await until(() => !!finishBootstrap && !!ctx.container.querySelector(".roman-chat"), "restoration did not begin");
    assert.equal(mounted.state, "pending", "elapsed minimum delay must not reveal an unresolved session");
    assert.deepEqual(ctx.themes, [], "restoration must not publish a guessed welcome state");
    finishBootstrap();
    await until(() => !!finishRead, "restoration did not read the current conversation");
    assert.equal(mounted.state, "pending");
    assert.deepEqual(ctx.themes, []);
    finishRead();
    await until(() => mounted.state === "ready", "restored runtime never became ready");
    assert.deepEqual(ctx.themes, [!hasCustomerReply]);
    assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), !hasCustomerReply);
    assert.deepEqual(JSON.parse(ctx.window.sessionStorage.getItem("roman:welcome-state")), {
      conversationId: access.conversationId,
      welcome: !hasCustomerReply,
    });
    assert.equal(!!ctx.container.querySelector(".roman-welcome"), !hasCustomerReply);
  });
}

test("a slow download adds no further loading delay after React commits", async (t) => {
  const ctx = setup(t, 1600);
  const mount = ctx.mount(0);
  await until(
    () => mount.state === "ready",
    "already elapsed loading time should not add another second",
  );
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  assert.equal(ctx.timers.size, 0);
});

for (const failure of ["connection loss", "suspended service"]) {
  test(`initial restoration ${failure} retains the saved loader appearance and rejects readiness`, async (t) => {
    const ctx = setup(t, 1500);
    const access = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      token: "a".repeat(43),
      expiresAt: "2099-10-02T10:00:00Z",
      apiBaseUrl: "https://roman.example/api/conversations",
    };
    const appearance = JSON.stringify({ conversationId: access.conversationId, welcome: false });
    ctx.window.sessionStorage.setItem("roman:conversation", JSON.stringify(access));
    ctx.window.sessionStorage.setItem("roman:welcome-state", appearance);
    let failBootstrap;
    ctx.window.fetch = async () => new Promise((resolve, reject) => {
      failBootstrap = () => {
        if (failure === "connection loss") reject(new TypeError("Connection lost"));
        else resolve({
          ok: false,
          status: 503,
          headers: { get: () => "application/json" },
          json: async () => ({ error: { code: "SERVICE_UNAVAILABLE", message: "Roman is currently unavailable" } }),
        });
      };
    });
    const mounted = ctx.mount(0);
    await until(() => !!failBootstrap && !!ctx.container.querySelector(".roman-chat"), "restoration did not begin");
    assert.equal(mounted.state, "pending");
    failBootstrap();
    await until(() => mounted.state === "rejected", "an unresolved saved session was incorrectly shown as a fresh chat");
    assert.match(String(mounted.error), failure === "connection loss" ? /could not connect/i : /could not restore/i);
    assert.deepEqual(ctx.themes, [], "failed restoration must not switch the loader to a guessed fresh palette");
    assert.equal(ctx.window.sessionStorage.getItem("roman:welcome-state"), appearance);
    assert.equal(JSON.parse(ctx.window.sessionStorage.getItem("roman:conversation")).conversationId, access.conversationId);
  });
}

test("Cart and Gallery stay light while the empty Chat retains its welcome palette", async (t) => {
  const ctx = setup(t, 1500);
  ctx.window.sessionStorage.setItem("roman:voice-autostart", "off");
  const canvas = ctx.window.document.documentElement;
  canvas.style.backgroundColor = "navy";
  ctx.window.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ items: [], item_count: 0, total_price: 0, currency: "GBP" }),
  });
  const mounted = ctx.mount(0);
  await until(() => mounted.state === "ready", "empty Chat did not become ready");
  assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), true);
  mounted.runtime.setOpen(true);
  assert.equal(canvas.style.backgroundColor, "rgb(78, 14, 14)");
  for (const path of ["/cart", "/gallery"]) {
    ctx.container.querySelector(`.roman-view-nav a[href="${path}"]`).click();
    await until(
      () => !!ctx.container.querySelector(`.roman-view-nav a[href="${path}"][aria-current="page"]`),
      `${path} did not open`,
    );
    assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), false);
    assert.equal(canvas.style.backgroundColor, "rgb(247, 245, 239)", "The page canvas must match the active light view");
    mounted.runtime.setOpen(false);
    assert.equal(canvas.style.backgroundColor, "navy", "Closing restores the storefront canvas");
    assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), false, "closing must not reset the active view appearance");
    mounted.runtime.setOpen(true);
    assert.equal(canvas.style.backgroundColor, "rgb(247, 245, 239)");
  }
  ctx.container.querySelector('.roman-view-nav a[href="/"]').click();
  await until(() => ctx.panel.hasAttribute("data-welcome-theme"), "empty Chat did not recover its welcome palette");
  assert.equal(canvas.style.backgroundColor, "rgb(78, 14, 14)");
  mounted.runtime.dispose();
  assert.equal(canvas.style.backgroundColor, "navy");
});

test("End chat restores the welcome canvas only after the server confirms clearing, and close restores the theme", async (t) => {
  const ctx = setup(t, 1500);
  const canvas = ctx.window.document.documentElement;
  canvas.style.setProperty("background-color", "navy", "important");
  canvas.style.backgroundImage = 'url("/original-theme.png")';
  const originalBackground = canvas.style.cssText;
  ctx.window.sessionStorage.setItem("roman:voice-autostart", "off");
  const access = {
    conversationId: "11111111-1111-4111-8111-111111111111",
    token: "a".repeat(43),
    expiresAt: "2099-10-02T10:00:00Z",
    apiBaseUrl: "https://roman.example/api/conversations",
  };
  const conversation = {
    id: access.conversationId,
    status: "active", busy: false, revision: 0, tools: [],
    current: { activeProduct: null, pendingQuestion: null, hasCustomerReply: true },
    messages: [{
      id: "customer-request", role: "user", status: "complete",
      parts: [{ type: "text", text: "Help me find a kitchen blind." }],
      createdAt: "2026-10-02T10:00:00Z",
    }],
  };
  ctx.window.sessionStorage.setItem("roman:conversation", JSON.stringify(access));
  const response = (value) => ({
    ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => wire(value),
  });
  let confirmEnd;
  ctx.window.fetch = async (url) => {
    const path = new URL(String(url), ctx.window.location.href).pathname;
    if (path === "/apps/roman/availability") return response({ status: "available" });
    if (path === "/apps/roman/bootstrap") return response({ ...access, conversation });
    if (path.endsWith("/end")) return new Promise((resolve) => { confirmEnd = () => resolve(response({ ...conversation, status: "ended", revision: 1 })); });
    if (path === `/api/conversations/${access.conversationId}`)
      return response({ ...conversation, streamRevision: 0 });
    if (path === "/cart.js") return response({ currency: "GBP", items: [], item_count: 0, total_price: 0 });
    throw new Error("Unexpected runtime fixture request: " + path);
  };
  const mounted = ctx.mount(0);
  await until(() => mounted.state === "ready", "saved conversation did not restore");
  mounted.runtime.setOpen(true);
  assert.equal(canvas.style.backgroundColor, "rgb(247, 245, 239)");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(() => !!confirmEnd, "End chat was not requested");
  assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), false);
  assert.equal(canvas.style.backgroundColor, "rgb(247, 245, 239)", "Pending clearing must keep the existing conversation appearance");
  confirmEnd();
  await until(() => !!ctx.container.querySelector(".roman-welcome"), "confirmed clearing did not restore the welcome");
  assert.equal(ctx.panel.hasAttribute("data-welcome-theme"), true);
  assert.equal(canvas.style.backgroundColor, "rgb(78, 14, 14)", "End chat updates the shell and exposed page canvas together");
  assert.equal(ctx.window.sessionStorage.getItem("roman:conversation"), null);
  mounted.runtime.setOpen(false);
  assert.equal(canvas.style.cssText, originalBackground);
  mounted.runtime.setOpen(true);
  assert.equal(canvas.style.backgroundColor, "rgb(78, 14, 14)");
  mounted.runtime.dispose();
  assert.equal(canvas.style.cssText, originalBackground);
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
