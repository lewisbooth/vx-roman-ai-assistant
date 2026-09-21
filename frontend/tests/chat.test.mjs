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
  Object.assign(window, { Request, Response, Headers });
  // JSDOM has no native modal API. Browser QA verifies focus containment;
  // here we only model the open/close lifecycle for App integration.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  options.beforeImport?.(window);
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanChatTest = RomanChatTest;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const voiceDock = window.document.createElement("div");
  host.shadowRoot.append(voiceDock);
  const listeners = new Set();
  const calls = [];
  const endCalls = [];
  const startVoiceCalls = [];
  const stopVoiceCalls = [];
  const voiceAnswers = [];
  const voiceChoices = [];
  const muteCalls = [];
  const productCalls = [];
  const navigationCalls = [];
  let state = {
    conversation: null,
    pending: false,
    restoring: false,
    error: null,
    voice: { status: "idle", muted: false, error: null },
    selectedVoice: "marin",
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
    sendMessage: async (text, choice) => {
      if (choice && state.voice.status === "active") {
        voiceChoices.push(choice);
        await options.onVoiceChoice?.(choice);
        return;
      }
      calls.push(text);
      await options.onSend?.(text, window, choice);
    },
    sendVoiceAnswer: async (questionId, answer) => {
      voiceAnswers.push({ questionId, answer });
      await options.onVoiceAnswer?.(questionId, answer, window);
    },
    end: async () => {
      endCalls.push("end");
      await options.onEnd?.(window);
      update({ conversation: null, error: null });
    },
    getCachedProducts: (ids) => options.getCachedProducts?.(ids) ?? [],
    loadProducts: async (ids, signal) => {
      productCalls.push([...ids]);
      return (
        (await options.onLoadProducts?.(ids, window, signal)) ?? {
          products: [],
          messages: [],
        }
      );
    },
    dispose() {},
    startVoice: async () => {
      startVoiceCalls.push("start");
      await options.onStartVoice?.(window);
      update({ voice: { status: "active", muted: false, error: null } });
    },
    setVoice: (selectedVoice) => update({ selectedVoice }),
    stopVoice: async () => {
      stopVoiceCalls.push("stop");
      await options.onStopVoice?.(window);
      update({
        voice: { status: "idle", muted: false, error: null },
        ...(state.conversation?.voice
          ? {
              conversation: {
                ...state.conversation,
                voice: { ...state.conversation.voice, status: "closed" },
              },
            }
          : {}),
      });
    },
    setVoiceMuted: (muted) => {
      muteCalls.push(muted);
      update({ voice: { ...state.voice, muted } });
    },
    resolveToolApproval: (id, confirmed) => options.onApproval?.(id, confirmed),
  };
  let navigationState = {
    url: window.location.href,
    pending: false,
    error: null,
  };
  const navigationListeners = new Set();
  const updateNavigation = (changes) => {
    navigationState = { ...navigationState, ...changes };
    for (const listener of navigationListeners) listener();
  };
  let ready = false;
  const dispose = window.RomanChatTest.mount(container, {
    logoUrl:
      "https://cdn.shopify.com/extensions/version/assets/roman-logo.svg?v=1",
    navigation: {
      getSnapshot: () => navigationState,
      subscribe: (listener) => {
        navigationListeners.add(listener);
        return () => navigationListeners.delete(listener);
      },
      navigate: async (path) => {
        navigationCalls.push(path);
      },
    },
    tools: { execute: async () => ({}) },
    session,
    voiceDock,
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
    await until(() => {
      const send = container.querySelector(
        '.roman-composer button[type="submit"]',
      );
      return text.trim()
        ? send && !send.disabled
        : !send && input().value === text;
    }, "Composer did not accept typed text");
  }
  return {
    window,
    container,
    voiceDock,
    calls,
    update,
    updateNavigation,
    input,
    type,
    errors,
    endCalls,
    startVoiceCalls,
    stopVoiceCalls,
    voiceAnswers,
    voiceChoices,
    muteCalls,
    productCalls,
    navigationCalls,
  };
}

test("manual composer voice replaces the empty input in place and preserves the welcome", async (t) => {
  const ctx = await setup(t);
  const form = ctx.container.querySelector(".roman-composer form");
  const field = form.querySelector(".roman-composer-field");
  const start = [...form.querySelectorAll("button")].find(
    (button) => button.textContent === "Start voice",
  );
  const send = form.querySelector('button[type="submit"]');
  assert.ok(start, "Start voice should be in the composer form");
  assert.equal(start.type, "button");
  assert.equal(start.getAttribute("aria-label"), "Start voice");
  assert.equal(field.contains(start), true);
  assert.equal(field.contains(ctx.input()), true);
  assert.equal(send, null, "empty text offers voice rather than Send");
  assert.deepEqual(ctx.startVoiceCalls, []);
  start.focus();
  await ctx.type("Keep these measurements in my draft");
  assert.deepEqual(
    ctx.startVoiceCalls,
    [],
    "focusing or typing must not start microphone work",
  );
  assert.equal(ctx.container.querySelector('[aria-label="Start voice"]'), null);
  await ctx.type("");
  ctx.container.querySelector('[aria-label="Start voice"]').click();
  await until(
    () =>
      ctx.startVoiceCalls.length === 1 &&
      ctx.container.querySelector(".roman-voice-waveform"),
    "Voice did not start explicitly",
  );
  assert.deepEqual(ctx.calls, [], "the voice button must not submit the form");
  assert.equal(ctx.input(), null);
  assert.equal(form.hidden, false);
  assert.equal(form.closest(".roman-composer").hidden, false);
  assert.equal(form.querySelectorAll("button").length, 1);
  assert.equal(form.querySelector('button[type="submit"]'), null);
  assert.equal(ctx.container.querySelectorAll(".roman-welcome-tile").length, 4);
  const stop = ctx.container.querySelector('[aria-label="End voice"]');
  stop.click();
  await until(
    () => ctx.input() && !ctx.input().disabled,
    "Switching back did not restore text editing",
  );
  assert.equal(ctx.input().value, "");
  assert.equal(form.hidden, false);
  assert.equal(form.closest(".roman-composer").hidden, false);
  assert.deepEqual(ctx.stopVoiceCalls, ["stop"]);
  assert.equal(ctx.startVoiceCalls.length, 1);
});

test("the in-field Send submits the draft once and blocks voice while its local send is pending", async (t) => {
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const ctx = await setup(t, { onSend: () => accepted });
  await ctx.type("  Show me blackout blinds  ");
  const send = ctx.container.querySelector(
    '.roman-composer-field button[type="submit"]',
  );
  assert.equal(ctx.container.querySelector('[aria-label="Start voice"]'), null);
  send.click();
  await until(
    () =>
      ctx.calls.length === 1 &&
      ctx.container.querySelector('[aria-label="Start voice"]')?.disabled,
    "Pending send did not block both actions",
  );
  const voice = ctx.container.querySelector('[aria-label="Start voice"]');
  assert.deepEqual(ctx.calls, ["Show me blackout blinds"]);
  assert.equal(ctx.input().value, "");
  voice.click();
  send.click();
  assert.deepEqual(ctx.startVoiceCalls, []);
  assert.equal(ctx.calls.length, 1);
  accept();
  await until(
    () => ctx.input().value === "" && !voice.disabled,
    "Accepted text did not reset the composer",
  );
  assert.equal(ctx.container.querySelector('button[type="submit"]'), null);
  assert.deepEqual(ctx.startVoiceCalls, []);
});

test("composer Start voice remains disabled during restoration, accepted-request work and model work", async (t) => {
  for (const [name, state] of [
    ["restoring", { restoring: true }],
    ["request", { pending: true }],
    [
      "model",
      {
        conversation: {
          id: "chat",
          status: "active",
          busy: true,
          messages: [],
          tools: [],
        },
      },
    ],
  ])
    await t.test(name, async (t) => {
      const ctx = await setup(t, { state });
      const voice = [
        ...ctx.container.querySelectorAll(".roman-composer button"),
      ].find((button) => button.textContent === "Start voice");
      assert.ok(voice);
      assert.equal(voice.disabled, true);
      voice.click();
      assert.deepEqual(ctx.startVoiceCalls, []);
      assert.deepEqual(ctx.calls, []);
    });
});

test("saved guide records stay hidden without fetching products, navigating or stopping voice", async (t) => {
  const fetches = [];
  const guides = [
    {
      kind: "measuring",
      url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=1",
    },
    {
      kind: "fitting",
      url: "https://hd-dev-single.myshopify.com/cdn/shop/files/fitting.pdf?v=2",
    },
  ];
  const ctx = await setup(t, {
    beforeImport: (window) => {
      window.fetch = (...args) => {
        fetches.push(args);
        throw new Error("Hidden guides must not fetch PDF content");
      };
    },
    state: {
      voice: { status: "active", muted: false, error: null },
      conversation: {
        id: "chat",
        status: "active",
        busy: false,
        tools: [],
        messages: [
          message("guide-request", "user", "Help me measure."),
          {
            ...message("guide-message", "assistant", ""),
            parts: [
              {
                type: "guides",
                version: 1,
                invocationId: "11111111-1111-4111-8111-111111111111",
                productPath: "/products/example",
                guides,
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(ctx.container.querySelector(".roman-message-assistant"), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-timeline > li").length,
    1,
  );
  assert.equal(ctx.container.querySelector(".roman-timeline a"), null);
  assert.doesNotMatch(
    ctx.container.textContent,
    /Measuring guide|Fitting guide/,
  );
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.productCalls, []);
  assert.deepEqual(fetches, []);
  assert.equal(ctx.container.querySelector(".roman-composer textarea"), null);
  assert.match(ctx.voiceDock.textContent, /Voice is on.*Stop voice/);
});

test("malformed or foreign historical guide records create no customer warning or empty row", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: {
        id: "chat",
        status: "active",
        busy: false,
        tools: [],
        messages: [
          message("guide-request", "user", "Help me measure."),
          {
            ...message("unsafe-guide", "assistant", ""),
            parts: [
              {
                type: "guides",
                version: 1,
                invocationId: "11111111-1111-4111-8111-111111111111",
                productPath: "/products/example",
                guides: [
                  {
                    kind: "measuring",
                    url: "https://evil.example/measuring.pdf",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(ctx.container.querySelector(".roman-message-assistant"), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-timeline > li").length,
    1,
  );
  assert.doesNotMatch(ctx.container.textContent, /guides are unavailable/);
});

test("cart approvals share the question panel in both locations without changing shopper decisions", async (t) => {
  for (const title of [
    "Empty your cart?",
    "Remove this item?",
    "Change this quantity?",
  ])
    await t.test(title, async (t) => {
      const choices = [];
      const approval = {
        invocationId: "cart-one",
        title,
        details: ["Kitchen blind", "Current quantity 2."],
      };
      const ctx = await setup(t, {
        state: {
          approval,
          conversation: {
            id: "chat",
            status: "active",
            messages: [],
            busy: true,
            tools: [],
          },
          voice: { status: "active", muted: false, error: null },
        },
        onApproval: (...args) => choices.push(args),
      });
      const panel = ctx.container.querySelector(".roman-tool-approval");
      const dock = ctx.voiceDock.querySelector(".roman-tool-approval");
      for (const review of [panel, dock]) {
        assert.ok(review.classList.contains("roman-action-panel"));
        assert.equal(review.querySelector("h2").textContent, title);
        assert.equal(
          review.getAttribute("aria-labelledby"),
          review.querySelector("h2").id,
        );
        assert.match(review.textContent, /Kitchen blind.*quantity 2/);
        assert.equal(
          review
            .querySelector(".roman-approval-details")
            .getAttribute("aria-live"),
          "polite",
        );
        assert.deepEqual(
          [...review.querySelectorAll(".roman-action-buttons button")].map(
            (button) => [button.textContent, button.type, button.disabled],
          ),
          [
            ["Cancel", "button", false],
            ["Approve", "button", false],
          ],
        );
        assert.equal(review.getAttribute("role"), null);
      }
      assert.notEqual(
        panel.querySelector("h2").id,
        dock.querySelector("h2").id,
      );
      const approve = dock.querySelector("button:last-child");
      approve.focus();
      assert.equal(dock.getRootNode().activeElement, approve);
      approve.click();
      assert.deepEqual(choices, [["cart-one", true]]);
      ctx.update({
        approval: {
          ...approval,
          unavailable: "The cart changed. Ask Roman to prepare a new review.",
        },
      });
      await until(
        () =>
          [panel, dock].every(
            (review) => review.querySelector("button:last-child").disabled,
          ),
        "Unavailable action was still approvable",
      );
      for (const review of [panel, dock]) {
        assert.match(
          review.querySelector('[role="status"]').textContent,
          /cart changed/,
        );
        review.querySelector("button:last-child").click();
      }
      assert.equal(
        choices.length,
        1,
        "Unavailable approvals must not be submitted",
      );
      panel.querySelector("button").click();
      assert.deepEqual(choices.at(-1), ["cart-one", false]);
      ctx.update({ approval: null });
      await until(
        () =>
          !ctx.container.querySelector(".roman-tool-approval") &&
          !ctx.voiceDock.querySelector(".roman-tool-approval"),
        "Completed approval remained mounted",
      );
    });
});

test("welcome uses original asset paths, actionable tiles and one hidden developer tools panel", async (t) => {
  const { container } = await setup(t, { showTools: true });
  const tiles = [...container.querySelectorAll(".roman-welcome-tile")];
  assert.equal(tiles.length, 4);
  assert.ok(tiles.every((tile) => !tile.disabled && tile.type === "button"));
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
  const drawer = container.querySelector(".roman-tools");
  assert.equal(drawer.hidden, true);
  assert.equal(container.querySelectorAll(".roman-settings-trigger").length, 1);
  assert.equal(
    container
      .querySelector(".roman-settings-trigger")
      .getAttribute("aria-controls"),
    drawer.id,
  );
  assert.equal(container.querySelectorAll("details").length, 0);
  assert.ok(drawer.querySelector(".roman-voice-choice select"));
  assert.ok(drawer.querySelector("form"));
  assert.equal(container.querySelector('nav[aria-label="Browse store"]'), null);
});

test("typed and tile sends show their local row before a session exists without replacing the composer", async (t) => {
  for (const source of ["typed", "tile"])
    await t.test(source, async (t) => {
      let accept;
      const accepted = new Promise((resolve) => {
        accept = resolve;
      });
      const requestId = "22222222-2222-4222-8222-222222222222";
      const ctx = await setup(t, {
        onSend(text) {
          ctx.update({
            pending: true,
            optimisticMessage: {
              ...message(requestId, "user", text, "pending"),
              requestId,
            },
          });
          return accepted;
        },
      });
      await ctx.type("Keep my room description");
      const input = ctx.input();
      if (source === "tile")
        ctx.container.querySelector(".roman-welcome-tile").click();
      else
        ctx.container
          .querySelector(".roman-composer form")
          .dispatchEvent(
            new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
          );
      await until(
        () => !ctx.container.querySelector(".roman-welcome"),
        "Home stayed visible while the first send was pending",
      );
      assert.equal(
        ctx.container.querySelectorAll(".roman-message-user").length,
        1,
      );
      assert.equal(
        ctx.container.querySelector(".roman-message-user .roman-message-text")
          .textContent,
        ctx.calls[0],
      );
      assert.equal(ctx.container.querySelector(".roman-end-chat"), null);
      assert.match(
        ctx.container.querySelector(".roman-reply-activity").textContent,
        /thinking/,
      );
      assert.equal(ctx.input(), input);
      assert.equal(
        input.value,
        source === "tile" ? "Keep my room description" : "",
      );
      assert.equal(input.readOnly, false);
      assert.equal(input.disabled, false);
      ctx.update({
        pending: false,
        optimisticMessage: null,
        conversation: {
          id: "chat",
          status: "active",
          busy: false,
          tools: [],
          messages: [
            { ...message("server-row", "user", ctx.calls[0]), requestId },
          ],
        },
      });
      accept();
      await until(() => !input.readOnly, "The confirmed send did not settle");
      assert.equal(
        ctx.container.querySelectorAll(".roman-message-user").length,
        1,
      );
      assert.equal(ctx.input(), input);
      assert.equal(
        input.value,
        source === "tile" ? "Keep my room description" : "",
      );
    });
});

test("the mobile menu dismisses within Shadow DOM and Settings restores the current responsive trigger", async (t) => {
  const changes = new Set();
  const media = {
    matches: true,
    addEventListener: (_name, listener) => changes.add(listener),
    removeEventListener: (_name, listener) => changes.delete(listener),
  };
  const ctx = await setup(t, {
    showTools: true,
    state: { conversation: engagedConversation([]) },
    beforeImport: (window) => {
      window.matchMedia = () => media;
    },
  });
  const menu = () => ctx.container.querySelector(".roman-menu-toggle");
  const dropdown = ctx.container.querySelector(".roman-header-menu");
  async function openMenu() {
    menu().click();
    await until(() => !dropdown.hidden, "Mobile menu did not open");
  }
  await openMenu();
  const gallery = ctx.container.querySelector(
    '.roman-view-nav a[href="/gallery"]',
  );
  gallery.focus();
  await until(
    () => dropdown.hidden,
    "Focus inside the same Shadow DOM did not dismiss the menu",
  );
  assert.equal(ctx.container.getRootNode().activeElement, gallery);

  await openMenu();
  let escapedShell = 0;
  ctx.container.addEventListener("keydown", () => escapedShell++);
  dropdown.querySelector("button").dispatchEvent(
    new ctx.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await until(() => dropdown.hidden, "Escape did not dismiss the menu");
  assert.equal(escapedShell, 0);
  assert.equal(ctx.container.getRootNode().activeElement, menu());

  await openMenu();
  dropdown.querySelector(".roman-settings-trigger").click();
  const panel = ctx.container.querySelector(".roman-tools");
  await until(() => !panel.hidden, "Mobile Settings did not open");
  assert.equal(
    ctx.container.getRootNode().activeElement,
    panel.querySelector("h2"),
  );
  media.matches = false;
  changes.forEach((listener) => listener());
  await until(() => !menu(), "Desktop header did not replace mobile actions");
  panel.querySelector("h2").dispatchEvent(
    new ctx.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await until(() => panel.hidden, "Settings did not close");
  assert.equal(
    ctx.container.getRootNode().activeElement,
    ctx.container.querySelector(".roman-settings-trigger"),
  );
  assert.equal(escapedShell, 0);
});

test("an unconfirmed first message remains visibly retryable in the queue without blocking new typing", async (t) => {
  let reject;
  const submitted = new Promise((_, fail) => {
    reject = fail;
  });
  const ctx = await setup(t, {
    onSend(text) {
      ctx.update({
        pending: true,
        optimisticMessage: message("local", "user", text, "pending"),
      });
      return submitted;
    },
  });
  await ctx.type("My measurements");
  ctx.container
    .querySelector(".roman-composer form")
    .dispatchEvent(
      new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await until(
    () => !!ctx.container.querySelector(".roman-timeline"),
    "Local message did not appear",
  );
  ctx.update({
    pending: false,
    optimisticMessage: null,
    error: "Connection lost. Please retry.",
  });
  reject(new ctx.window.Error("Connection lost. Please retry."));
  await until(
    () =>
      !!ctx.container.querySelector(".roman-queued-message [role=alert]") &&
      !ctx.input().readOnly,
    "Failed send was not retained in the queue",
  );
  assert.equal(ctx.input().value, "");
  assert.match(
    ctx.container.querySelector(".roman-message-queue").textContent,
    /My measurements/,
  );
  assert.equal(ctx.container.querySelector(".roman-message-user"), null);
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /Connection lost/,
  );
});

test("each welcome tile starts a normal text conversation without clearing the composer's draft", async (t) => {
  const starters = [
    "Help me measure my windows for blinds.",
    "I'd like to visualize blinds in my room. Start by asking me to upload a room photo, then help me choose a blind. Image generation isn't available yet.",
    "Help me find blinds that suit my room and style.",
    "Help me find no-drill blinds for my home.",
  ];
  for (const [index, starter] of starters.entries())
    await t.test(String(index), async (t) => {
      let accept;
      const accepted = new Promise((resolve) => {
        accept = resolve;
      });
      const ctx = await setup(t, { onSend: () => accepted });
      await ctx.type("Keep my unsent room description");
      const input = ctx.input();
      const tiles = [...ctx.container.querySelectorAll(".roman-welcome-tile")];
      tiles[index].focus();
      assert.equal(tiles[index].getRootNode().activeElement, tiles[index]);
      assert.deepEqual(
        ctx.calls,
        [],
        "keyboard focus must not start a conversation",
      );
      tiles[index].click();
      tiles[index].click();
      tiles[(index + 1) % tiles.length].click();
      await until(
        () => ctx.calls.length === 1 && !input.readOnly,
        "Tile submission did not start while preserving text entry",
      );
      assert.deepEqual(ctx.calls, [starter]);
      assert.deepEqual(ctx.startVoiceCalls, []);
      assert.equal(input.value, "Keep my unsent room description");
      ctx.update({
        conversation: {
          id: "chat",
          status: "active",
          busy: false,
          tools: [],
          messages: [message("user-one", "user", starter)],
        },
      });
      accept();
      await until(
        () =>
          !ctx.container.querySelector(".roman-welcome") &&
          !ctx.input().readOnly,
        "Accepted tile did not become the normal conversation",
      );
      assert.equal(
        ctx.input(),
        input,
        "the existing composer should stay mounted",
      );
      assert.equal(input.value, "Keep my unsent room description");
      assert.equal(
        ctx.container.querySelector(".roman-message-user .roman-message-text")
          .textContent,
        starter,
      );
      assert.deepEqual(ctx.errors, []);
    });
});

test("distinct welcome and composer inputs queue in their original order", async (t) => {
  for (const first of ["tile", "composer"])
    await t.test(first, async (t) => {
      let accept;
      const accepted = new Promise((resolve) => {
        accept = resolve;
      });
      const ctx = await setup(t, { onSend: () => accepted });
      await ctx.type("My typed question");
      const tile = ctx.container.querySelector(".roman-welcome-tile");
      const form = ctx.container.querySelector(".roman-composer form");
      const submit = () =>
        form.dispatchEvent(
          new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      if (first === "tile") {
        tile.click();
        submit();
      } else {
        submit();
        tile.click();
      }
      await until(
        () => ctx.calls.length === 1 && ctx.input().value === "",
        "Queued drafts did not clear the composer",
      );
      const expected = [
        "Help me measure my windows for blinds.",
        "My typed question",
      ];
      if (first === "composer") expected.reverse();
      assert.deepEqual(ctx.calls, [expected[0]]);
      assert.deepEqual(
        [...ctx.container.querySelectorAll(".roman-queued-message p")].map(
          (row) => row.textContent,
        ),
        expected.slice(1),
      );
      assert.equal(ctx.input().readOnly, false);
      accept();
      await until(
        () =>
          ctx.calls.length === 2 &&
          !ctx.container.querySelector(".roman-message-queue"),
        "Queued submissions did not finish",
      );
      assert.deepEqual(ctx.calls, expected);
      assert.equal(ctx.input().value, "");
    });
});

test("welcome tiles queue during pending work or unavailable voice but restoration stays locked", async (t) => {
  for (const [name, state] of [
    ["restoring", { restoring: true }],
    ["pending", { pending: true }],
    [
      "model",
      {
        conversation: {
          id: "chat",
          status: "active",
          busy: true,
          messages: [],
          tools: [],
        },
      },
    ],
    [
      "voice stopping",
      { voice: { status: "stopping", muted: false, error: null } },
    ],
    [
      "remote voice",
      {
        conversation: {
          id: "chat",
          status: "active",
          busy: false,
          messages: [],
          tools: [],
          voice: { status: "active" },
        },
      },
    ],
  ])
    await t.test(name, async (t) => {
      const ctx = await setup(t, { state });
      const tiles = [...ctx.container.querySelectorAll(".roman-welcome-tile")];
      if (name === "restoring") assert.equal(tiles.length, 0);
      else {
        assert.equal(tiles.length, 4);
        assert.ok(tiles.every((tile) => !tile.disabled));
        tiles[0].click();
        await until(
          () => ctx.container.querySelector(".roman-queued-message"),
          "Starter was not queued",
        );
        assert.match(
          ctx.container.querySelector(".roman-queued-message").textContent,
          /Help me measure/,
        );
      }
      assert.deepEqual(ctx.calls, []);
      assert.deepEqual(ctx.startVoiceCalls, []);
    });
});

test("voice startup and greeting keep welcome tiles until a customer chooses a tile or speaks", async (t) => {
  for (const voiceStatus of ["starting", "active"])
    for (const response of ["tile", "spoken"])
      await t.test(`${voiceStatus}: ${response}`, async (t) => {
        const rows = [
          {
            ...message("voice-start", "context", ""),
            parts: [
              {
                type: "voice_event",
                version: 1,
                voiceId: "voice",
                event: "started",
              },
            ],
          },
          {
            ...message("greeting", "assistant", ""),
            parts: [
              {
                type: "voice",
                version: 1,
                voiceId: "voice",
                text: "Hi! I'm Roman. Where would you like to start?",
                startMs: 0,
                endMs: 1000,
              },
            ],
          },
        ];
        const conversation = {
          id: "voice-welcome",
          status: "active",
          revision: 1,
          busy: false,
          tools: [],
          messages: rows,
        };
        const ctx = await setup(t, {
          state: {
            conversation,
            voice: { status: voiceStatus, muted: false, error: null },
          },
          onSend(text) {
            ctx.update({
              optimisticMessage: message(
                "optimistic-input",
                "user",
                text,
                "pending",
              ),
            });
          },
        });
        const form = ctx.container.querySelector(".roman-composer form");
        const bar = ctx.container.querySelector(".roman-voice-bar");
        const tiles = [
          ...ctx.container.querySelectorAll(".roman-welcome-tile"),
        ];
        assert.equal(tiles.length, 4);
        assert.ok(tiles.every((tile) => !tile.disabled));
        assert.equal(ctx.input(), null);
        assert.equal(form.querySelectorAll("button").length, 1);
        assert.ok(form.querySelector('[aria-label="End voice"]'));
        assert.equal(ctx.container.querySelector(".roman-timeline"), null);
        if (response === "spoken") {
          ctx.update({
            conversation: {
              ...conversation,
              messages: [
                ...rows,
                {
                  ...message("customer-voice", "user", ""),
                  parts: [
                    {
                      type: "voice",
                      version: 1,
                      voiceId: "voice",
                      text: "I need blackout blinds.",
                      startMs: 1100,
                      endMs: 2000,
                    },
                  ],
                },
              ],
            },
          });
        } else tiles[0].click();
        await until(
          () => !ctx.container.querySelector(".roman-welcome"),
          "The first customer response did not open the transcript",
        );
        assert.equal(
          ctx.container.querySelectorAll(".roman-message-user").length,
          1,
        );
        assert.equal(ctx.container.querySelector(".roman-voice-bar"), bar);
        assert.equal(ctx.input(), null);
        assert.equal(ctx.container.querySelector(".roman-composer form"), form);
        assert.deepEqual(ctx.stopVoiceCalls, []);
        assert.deepEqual(ctx.startVoiceCalls, []);
        assert.equal(ctx.calls.length, response === "spoken" ? 0 : 1);
      });
});

test("failed welcome submissions show one retryable error and retain the same starter and draft", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    onSend: (_text, window) => {
      if (++attempts === 1)
        throw new window.Error("Connection lost. Please retry.");
    },
  });
  await ctx.type("Keep my dimensions");
  const tile = ctx.container.querySelector(".roman-welcome-tile");
  tile.click();
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "Tile error was not displayed",
  );
  assert.equal(ctx.container.querySelectorAll('[role="alert"]').length, 1);
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /Connection lost/,
  );
  assert.equal(ctx.input().value, "Keep my dimensions");
  ctx.container.querySelector(".roman-queued-message button").click();
  await until(
    () =>
      ctx.calls.length === 2 &&
      !ctx.container.querySelector(".roman-message-queue"),
    "Tile retry did not complete",
  );
  assert.deepEqual(ctx.calls, [
    "Help me measure my windows for blinds.",
    "Help me measure my windows for blinds.",
  ]);
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
  assert.equal(ctx.input().value, "Keep my dimensions");
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
    () => calls.length === 1 && input().value === "",
    "Enqueue did not clear the draft immediately",
  );
  assert.deepEqual(calls, ["I need a roman blind"]);
  assert.equal(container.querySelector(".roman-queued-message"), null);
  assert.equal(input().value, "");
  accept();
  await until(
    () => !container.querySelector(".roman-message-queue"),
    "Accepted send did not release the composer",
  );
  assert.equal(input().value, "");
});

test("failed delivery preserves the message in the retryable queue and leaves the composer clear", async (t) => {
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
  assert.equal(input().value, "");
  assert.match(
    container.querySelector(".roman-message-queue").textContent,
    /Keep these measurements/,
  );
  assert.equal(input().disabled, false);
  assert.equal(input().getRootNode().activeElement, input());
  assert.deepEqual(calls, ["Keep these measurements"]);
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /Connection lost/,
  );
});

test("Enter and Send retain composer focus through submission and the model reply", async (t) => {
  for (const action of ["Enter", "Send"])
    await t.test(action, async (t) => {
      let accept;
      const accepted = new Promise((resolve) => {
        accept = resolve;
      });
      const ctx = await setup(t, { onSend: () => accepted });
      await ctx.type("400 by 500 mm");
      const input = ctx.input();
      const root = input.getRootNode();
      input.focus();
      if (action === "Enter") {
        input.dispatchEvent(
          new ctx.window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        const send = ctx.container.querySelector('button[type="submit"]');
        send.focus();
        send.click();
      }
      await until(
        () => ctx.calls.length === 1 && input.value === "",
        "Send was not queued",
      );
      assert.equal(root.activeElement, input);
      assert.equal(input.disabled, false);
      assert.equal(input.value, "");
      ctx.update({
        conversation: { ...engagedConversation([]), busy: true },
      });
      accept();
      await until(() => input.value === "", "Accepted draft was not cleared");
      assert.equal(input.readOnly, false);
      assert.equal(root.activeElement, input);
      ctx.update({ conversation: engagedConversation([]) });
      await until(() => !input.readOnly, "Reply did not release text entry");
      assert.equal(root.activeElement, input);
      await ctx.type("That's correct");
      assert.equal(root.activeElement, input);
      assert.deepEqual(ctx.calls, ["400 by 500 mm"]);
    });
});

test("a late send completion never takes focus back after the customer moves away", async (t) => {
  for (const destination of ["storefront", "voice"])
    await t.test(destination, async (t) => {
      let accept;
      const accepted = new Promise((resolve) => {
        accept = resolve;
      });
      const ctx = await setup(t, { onSend: () => accepted });
      await ctx.type("Help me measure");
      ctx.container.querySelector('button[type="submit"]').click();
      await until(
        () => ctx.calls.length === 1 && ctx.input().value === "",
        "Send was not queued",
      );
      let target;
      if (destination === "voice") {
        ctx.update({
          conversation: engagedConversation([
            message("sent", "user", "Help me measure"),
          ]),
          voice: { status: "active", muted: false, error: null },
        });
        await until(
          () => !!ctx.container.querySelector('[aria-label="End voice"]'),
          "Voice controls did not appear",
        );
        target = ctx.container.querySelector('[aria-label="End voice"]');
      } else {
        target = ctx.window.document.createElement("button");
        ctx.window.document.body.append(target);
      }
      target.focus();
      accept();
      await until(
        () => !ctx.container.querySelector(".roman-queued-message"),
        "Send did not complete",
      );
      assert.equal(target.getRootNode().activeElement, target);
      if (destination === "voice") assert.equal(ctx.input(), null);
      else assert.equal(ctx.input().disabled, false);
    });
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

test("recovering a connection retains a failed queued message until an explicit retry", async (t) => {
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
    () => !ctx.container.querySelector(".roman-chat-retry"),
    "Connection error did not clear",
  );
  assert.deepEqual(ctx.calls, ["Keep this draft"]);
  assert.equal(ctx.input().value, "");
  assert.match(
    ctx.container.querySelector(".roman-queued-message").textContent,
    /Keep this draft/,
  );
  assert.ok(ctx.container.querySelector(".roman-queued-message [role=alert]"));
});

test("restoration disables the composer and backend work allows queuing without inventing a new session", async (t) => {
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
      tools: [],
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
  assert.equal(input().disabled, false);
  assert.equal(input().readOnly, false);
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
        tools: [],
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
  let messages = [
    message("first-customer", "user", "Help me choose blinds."),
    message("first", "assistant", "Initial reply"),
  ];
  const { window, container, update } = await setup(t, {
    state: {
      conversation: { id: "existing", busy: false, tools: [], messages },
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
    update({
      conversation: { id: "existing", busy: false, tools: [], messages },
    });
  }
  append("Second reply");
  await until(
    () => viewport.scrollTop === 1000,
    "Initial new content did not follow the conversation",
  );
  viewport.scrollTop = 100;
  viewport.dispatchEvent(
    new window.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
  );
  viewport.dispatchEvent(new window.Event("scroll"));
  height = 1300;
  append("Third reply");
  await until(
    () => container.textContent.includes("Third reply"),
    "Third reply did not render",
  );
  assert.equal(viewport.scrollTop, 100);
  const resume = container.querySelector(".roman-return-current");
  assert.ok(resume, "A reader can return to the active turn explicitly");
  resume.click();
  await until(
    () => viewport.scrollTop === 1300,
    "Return to conversation did not scroll",
  );
  assert.equal(container.querySelector(".roman-return-current"), null);
  viewport.scrollTop = 1100;
  viewport.dispatchEvent(new window.Event("scroll"));
  height = 1500;
  append("Fourth reply");
  await until(
    () => viewport.scrollTop === 1500,
    "Following did not resume at the bottom",
  );
});

function engagedConversation(messages) {
  return {
    id: "existing",
    status: "active",
    revision: 1,
    tools: [],
    busy: false,
    // Engaged fixtures represent a real customer request before Roman's
    // results. Assistant greetings and lifecycle events alone stay at home.
    messages: messages.some((row) => row.role === "user")
      ? messages
      : [
          message("initial-customer", "user", "Help me choose blinds."),
          ...messages,
        ],
  };
}

function productsMessage() {
  return {
    ...message("products", "assistant", "Some options for your room"),
    parts: [
      { type: "text", text: "Some options for your room" },
      {
        type: "products",
        version: 1,
        invocationId: "f186c886-e2ae-4c34-9bad-904ab4b3cf01",
        productIds: ["gid://shopify/Product/123"],
      },
    ],
  };
}

test("restored carousels hydrate only near the viewport and cancel obsolete display reads", async (t) => {
  const observers = [];
  const signals = [];
  const messages = Array.from({ length: 20 }, (_, index) => {
    const row = productsMessage();
    row.id = `cards-${index}`;
    row.parts[1].invocationId = `catalog-${index}`;
    return row;
  });
  const ctx = await setup(t, {
    state: { conversation: engagedConversation(messages) },
    beforeImport: (window) => {
      window.IntersectionObserver = class {
        constructor(callback, options) {
          this.callback = callback;
          this.options = options;
          observers.push(this);
        }
        observe(target) {
          this.target = target;
        }
        disconnect() {
          this.disconnected = true;
        }
      };
    },
    onLoadProducts: (_ids, _window, signal) => {
      signals.push(signal);
      if (signals.length === 1)
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      return catalog;
    },
  });
  await until(
    () => observers.length === 20,
    "Historical card observers were not mounted",
  );
  assert.equal(ctx.productCalls.length, 0);
  assert.equal(
    observers[19].options.root,
    ctx.container.querySelector(".roman-chat-scroll"),
  );
  observers[19].callback([{ isIntersecting: true }]);
  await until(
    () => signals.length === 1,
    "Visible products did not start loading",
  );
  observers[19].callback([{ isIntersecting: false }]);
  await until(() => signals[0].aborted, "Offscreen lookup was not cancelled");
  observers[19].callback([{ isIntersecting: true }]);
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Visible products did not resume loading",
  );
  assert.equal(ctx.productCalls.length, 2);
  assert.equal(ctx.container.querySelectorAll(".roman-choose-blind").length, 1);
  ctx.update({ conversation: null });
  await until(
    () => observers.every((observer) => observer.disconnected),
    "Card observers were not disposed",
  );
});

const catalog = {
  products: [
    {
      id: "gid://shopify/Product/123",
      title: "Lottie Roman blind",
      description: "Public product description",
      url: "https://hd-dev-single.myshopify.com/products/lottie",
      imageUrl: "https://cdn.shopify.com/lottie.jpg",
      priceLabel: "From £30.00",
    },
  ],
  messages: [],
};

test("pending recommendations reserve one noninteractive card per selected product", async (t) => {
  for (const count of [1, 4, 10]) {
    await t.test(`${count} products`, async (t) => {
      const row = productsMessage();
      const products = Array.from({ length: count }, (_, index) => ({
        ...catalog.products[0],
        id: `gid://shopify/Product/${index + 1}`,
        title: `Selected blind ${index + 1}`,
      }));
      row.parts[1].productIds = products.map((product) => product.id);
      let resolve;
      const ctx = await setup(t, {
        state: { conversation: engagedConversation([row]) },
        onLoadProducts: () => new Promise((done) => (resolve = done)),
      });
      await until(() => resolve, "Product loading did not start");
      const placeholders = ctx.container.querySelectorAll(
        ".roman-product-skeleton",
      );
      assert.equal(placeholders.length, count);
      assert.ok(
        [...placeholders].every(
          (card) =>
            card.querySelectorAll(".roman-product-title > span").length === 2,
        ),
        "Unknown titles reserve two lines until the actual title is known",
      );
      assert.ok(
        [...placeholders].every(
          (card) =>
            card.closest('[aria-hidden="true"]') &&
            !card.querySelector("button,a,[tabindex]"),
        ),
      );
      const status = ctx.container.querySelector(
        '.roman-products [role="status"]',
      );
      assert.match(status.textContent, /Loading products/);
      assert.ok(status.classList.contains("sr-only"));
      resolve({ products, messages: [] });
      await until(
        () =>
          ctx.container.querySelectorAll(".roman-choose-blind").length ===
          count,
        "The recommendations did not replace their placeholders",
      );
      assert.equal(
        ctx.container.querySelector(".roman-product-skeleton"),
        null,
      );
      assert.equal(
        ctx.container.querySelector('.roman-products [role="status"]'),
        null,
      );
      assert.equal(ctx.productCalls.length, 1);
    });
  }
});

test("known requested titles render during partial hydration without making the placeholders interactive", async (t) => {
  const known = {
    ...catalog.products[0],
    title:
      "A complete long product title <with literal text> that must never be truncated",
  };
  const unknown = {
    ...known,
    id: "gid://shopify/Product/456",
    title: "New blind",
  };
  const row = productsMessage();
  row.parts[1].productIds = [unknown.id, known.id];
  let resolve;
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([row]) },
    getCachedProducts: () => [known],
    onLoadProducts: () => new Promise((done) => (resolve = done)),
  });
  await until(() => resolve, "Product hydration did not start");
  const titles = ctx.container.querySelectorAll(".roman-product-title");
  assert.equal(
    titles[0].children.length,
    2,
    "Only the unknown title has placeholder lines",
  );
  assert.equal(titles[1].textContent, known.title);
  assert.equal(titles[1].children.length, 0, "The cached title is plain text");
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
  assert.deepEqual(ctx.productCalls, [row.parts[1].productIds]);
  resolve({ products: [known, unknown], messages: [] });
  await until(
    () => ctx.container.querySelectorAll(".roman-choose-blind").length === 2,
    "Hydrated products did not replace placeholders",
  );
  assert.deepEqual(
    [...ctx.container.querySelectorAll(".roman-product-title")].map(
      (title) => title.textContent,
    ),
    [unknown.title, known.title],
  );
});

test("replacing recommendation IDs cancels the old lookup and ignores its late completion", async (t) => {
  const requests = [];
  const first = productsMessage();
  const second = productsMessage();
  second.parts[1].productIds = ["gid://shopify/Product/456"];
  const replacement = {
    ...catalog.products[0],
    id: second.parts[1].productIds[0],
    title: "Replacement blind",
  };
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([first]) },
    onLoadProducts: (ids, _window, signal) =>
      new Promise((resolve) => requests.push({ ids, signal, resolve })),
  });
  await until(() => requests.length === 1, "The first lookup did not start");
  ctx.update({ conversation: engagedConversation([second]) });
  await until(
    () => requests.length === 2,
    "The replacement lookup did not start",
  );
  assert.ok(requests[0].signal.aborted);
  assert.equal(
    ctx.container.querySelectorAll(".roman-product-skeleton").length,
    1,
  );
  requests[0].resolve(catalog);
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
  requests[1].resolve({ products: [replacement], messages: [] });
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "The replacement did not render",
  );
  assert.match(
    ctx.container.querySelector(".roman-choose-blind").textContent,
    /Replacement blind/,
  );
  assert.doesNotMatch(ctx.container.textContent, /Lottie Roman blind/);
});

test("product references hydrate once and the whole card submits intent without navigating directly", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => pending,
  });
  await until(
    () => ctx.productCalls.length === 1,
    "Product references were not hydrated",
  );
  assert.match(ctx.container.textContent, /Loading products/);
  ctx.update({ conversation: engagedConversation([productsMessage()]) });
  await delay(0);
  assert.equal(
    ctx.productCalls.length,
    1,
    "Unchanged product IDs must not refetch on every poll",
  );
  resolve(catalog);
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Product card did not render",
  );
  const card = ctx.container.querySelector(".roman-choose-blind");
  ctx.update({
    conversation: engagedConversation([
      productsMessage(),
      message("later", "assistant", "A later streamed response"),
    ]),
  });
  await until(
    () => ctx.container.textContent.includes("A later streamed response"),
    "The next snapshot did not render",
  );
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), card);
  assert.equal(
    ctx.productCalls.length,
    1,
    "New part and ID-array identities must not remount loaded cards",
  );
  assert.doesNotMatch(ctx.container.textContent, /Loading products/);
  assert.equal(card.querySelector("a"), null);
  assert.equal(card.querySelector("img").src, catalog.products[0].imageUrl);
  assert.equal(card.querySelector("img").getAttribute("loading"), "lazy");
  const choice = card.querySelector("img").closest("button");
  assert.equal(choice.getAttribute("aria-label"), "Choose Lottie Roman blind");
  assert.equal(choice.type, "button");
  assert.equal(choice, card, "One native button owns the entire card");
  assert.equal(
    card.querySelector(".roman-product-title").closest("button"),
    choice,
  );
  assert.equal(
    card.querySelector(".roman-product-price").closest("button"),
    choice,
  );
  assert.equal(card.querySelector("button"), null, "No nested actions");
  assert.match(card.textContent, /Lottie Roman blind/);
  assert.match(card.textContent, /From £30.00/);
  assert.doesNotMatch(
    ctx.container.textContent,
    /Final price depends on options and measurements/,
  );
  const click = new ctx.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  card.querySelector(".roman-product-title").dispatchEvent(click);
  await until(() => ctx.calls.length === 1, "Choice should be sent to Roman");
  assert.deepEqual(ctx.calls, ["I'd like the Lottie Roman blind."]);
  assert.deepEqual(ctx.navigationCalls, []);
});

test("product cards show only the selected IDs in their recommendation order", async (t) => {
  const selected = productsMessage();
  selected.parts[1].productIds = [
    "gid://shopify/Product/456",
    "gid://shopify/Product/123",
    "gid://shopify/Product/789",
  ];
  const second = {
    ...catalog.products[0],
    id: "gid://shopify/Product/456",
    title: "Selected blackout blind",
    url: "https://hd-dev-single.myshopify.com/products/selected-blackout",
  };
  const unrelated = {
    ...catalog.products[0],
    id: "gid://shopify/Product/999",
    title: "An unrelated catalog match",
    url: "https://hd-dev-single.myshopify.com/products/unrelated",
  };
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([selected]) },
    onLoadProducts: () => ({
      products: [unrelated, catalog.products[0], second],
      messages: [{ type: "info", text: "One selected item is unavailable." }],
    }),
  });
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Selected product cards did not render",
  );
  assert.deepEqual(ctx.productCalls, [selected.parts[1].productIds]);
  assert.deepEqual(
    [...ctx.container.querySelectorAll(".roman-choose-blind")].map(
      (card) => card.querySelector(".roman-product-title").textContent,
    ),
    [second.title, catalog.products[0].title],
  );
  assert.doesNotMatch(ctx.container.textContent, /An unrelated catalog match/);
  assert.match(ctx.container.textContent, /One selected item is unavailable/);
});

test("choosing a blind in voice sends one selection without stopping voice or navigating", async (t) => {
  let release;
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([productsMessage()]),
      voice: { status: "active", muted: false, error: null },
    },
    onLoadProducts: () => catalog,
    onVoiceChoice: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Choice is loaded",
  );
  const button = ctx.container.querySelector(".roman-choose-blind");
  button.click();
  button.click();
  await until(() => ctx.voiceChoices.length, "Voice accepts choice");
  assert.equal(ctx.voiceChoices.length, 1);
  assert.equal(ctx.voiceChoices[0].productId, catalog.products[0].id);
  assert.deepEqual(ctx.stopVoiceCalls, []);
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.calls, []);
  assert.ok(ctx.container.querySelector(".roman-voice-bar"));
  release();
});

test("a failed product selection stays retryable with an actionable error", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => catalog,
    onSend: (_text, window) => {
      if (++attempts === 1)
        throw new window.Error("Please reconnect and retry.");
    },
  });
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Choice is loaded",
  );
  ctx.container.querySelector(".roman-choose-blind").click();
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "Selection error appears",
  );
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /Please reconnect/,
  );
  ctx.container.querySelector(".roman-queued-message button").click();
  await until(() => attempts === 2, "Selection is retryable");
  assert.deepEqual(ctx.navigationCalls, []);
});

test("historical and current-turn carousel choices stay enabled while Roman works and queue with provenance", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const sourceStatus of ["complete", "pending"]) {
      await t.test(`${mode}: ${sourceStatus} carousel`, async (t) => {
        const source = { ...productsMessage(), status: sourceStatus };
        const conversation = {
          ...engagedConversation([source]),
          busy: true,
        };
        const choices = [];
        const ctx = await setup(t, {
          state: {
            conversation,
            pending: true,
            voice: {
              status: mode === "voice" ? "active" : "idle",
              muted: false,
              error: null,
            },
          },
          onLoadProducts: () => catalog,
          onSend: (_text, _window, choice) => choices.push(choice),
        });
        await until(
          () => ctx.container.querySelector(".roman-choose-blind"),
          "Choice is loaded",
        );
        const card = ctx.container.querySelector(".roman-choose-blind");
        assert.equal(card.disabled, false, "Busy work must not disable hover");
        card.click();
        card.click();
        await until(
          () => ctx.container.querySelector(".roman-queued-message"),
          "Choice waits in the shared queue",
        );
        assert.equal(
          ctx.container.querySelectorAll(".roman-queued-message").length,
          1,
        );
        assert.deepEqual(ctx.calls, []);
        assert.deepEqual(ctx.voiceChoices, []);
        assert.deepEqual(ctx.navigationCalls, []);
        assert.equal(
          card.disabled,
          false,
          "Enqueued choice leaves cards available",
        );
        ctx.update({ pending: false });
        await delay(20);
        assert.deepEqual(ctx.calls, []);
        assert.deepEqual(ctx.voiceChoices, []);
        ctx.update({ conversation: engagedConversation([productsMessage()]) });
        await until(
          () => (mode === "voice" ? ctx.voiceChoices.length : choices.length),
          "Completed work releases the queued selection",
        );
        const choice = mode === "voice" ? ctx.voiceChoices[0] : choices[0];
        assert.deepEqual(JSON.parse(JSON.stringify(choice)), {
          carouselId: source.parts[1].invocationId,
          productId: catalog.products[0].id,
          title: catalog.products[0].title,
          productPath: new URL(catalog.products[0].url).pathname,
        });
        assert.deepEqual(ctx.stopVoiceCalls, []);
        assert.deepEqual(ctx.navigationCalls, []);
        if (mode === "voice")
          assert.ok(ctx.container.querySelector(".roman-voice-bar"));
      });
    }
  }
});

test("carousel selections respect failed results, restoration and end-chat review", async (t) => {
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => catalog,
  });
  const card = () => ctx.container.querySelector(".roman-choose-blind");
  await until(card, "Choice is loaded");
  ctx.update({
    conversation: engagedConversation([
      { ...productsMessage(), status: "failed" },
    ]),
  });
  await until(
    () => card()?.disabled,
    "Failed results do not accept new choices",
  );
  ctx.update({ restoring: true });
  await until(() => !card(), "Restoration does not expose selections");
  ctx.update({
    restoring: false,
    conversation: engagedConversation([productsMessage()]),
  });
  await until(
    () => card() && !card().disabled,
    "Ready results become selectable",
  );
  ctx.container.querySelector(".roman-end-chat").click();
  await until(() => card().disabled, "End-chat review locks carousel choices");
  card().click();
  assert.deepEqual(ctx.calls, []);
  ctx.container.querySelector(".roman-dialog button").click();
  await until(() => !card().disabled, "Cancelling End restores selections");
});

test("a foreign-store carousel URL is rejected before it can enter the queue", async (t) => {
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => ({
      ...catalog,
      products: [
        {
          ...catalog.products[0],
          url: "https://foreign.test/products/green-roller",
        },
      ],
    }),
  });
  await until(
    () => ctx.container.querySelector(".roman-choose-blind"),
    "Choice is loaded",
  );
  ctx.container.querySelector(".roman-choose-blind").click();
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "Foreign choice error appears",
  );
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /this storefront/,
  );
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.container.querySelector(".roman-queued-message"), null);
});

test("unrelated lookup matches cannot replace an unavailable selected product", async (t) => {
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => ({
      products: [{ ...catalog.products[0], id: "gid://shopify/Product/999" }],
      messages: [],
    }),
  });
  await until(
    () =>
      ctx.container.textContent.includes(
        "These products are no longer available",
      ),
    "The unavailable selected product was replaced with an unrelated match",
  );
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
  assert.doesNotMatch(ctx.container.textContent, /Final price depends/);
});

test("product errors have an explicit retry, and missing products remain honest", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: (_ids, window) => {
      if (++attempts === 1)
        throw new window.Error("Shopify is unavailable. Please retry.");
      return {
        products: [],
        messages: [{ type: "info", text: "This item is no longer sold." }],
      };
    },
  });
  await until(
    () => ctx.container.querySelector(".roman-products-status button"),
    "Product retry was not offered",
  );
  assert.match(ctx.container.textContent, /Shopify is unavailable/);
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
  ctx.container.querySelector(".roman-products-status button").click();
  await until(
    () =>
      ctx.container.textContent.includes(
        "These products are no longer available",
      ),
    "Empty lookup did not display the unavailable state",
  );
  assert.match(ctx.container.textContent, /This item is no longer sold/);
  assert.equal(attempts, 2);
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
});

test("background page visits and Roman navigation remain out of the customer transcript", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        {
          ...message("manual", "context", ""),
          parts: [
            {
              type: "page_view",
              version: 1,
              title: "Manual browsing page",
              path: "/collections/all",
              occurredAt: "2026-09-15T10:00:00.000Z",
            },
          ],
        },
        {
          ...message("page", "context", ""),
          parts: [
            {
              type: "navigation",
              version: 1,
              invocationId: "11111111-1111-4111-8111-111111111111",
              title: "Lottie <img src=x>",
              path: "/products/lottie",
            },
          ],
        },
        {
          ...message("unsafe", "context", ""),
          parts: [
            {
              type: "navigation",
              version: 1,
              invocationId: "22222222-2222-4222-8222-222222222222",
              title: "Unsafe link",
              path: "javascript:alert(1)",
            },
          ],
        },
      ]),
    },
  });
  assert.equal(ctx.container.querySelector(".roman-navigation"), null);
  assert.equal(
    ctx.container.querySelectorAll(".roman-timeline > li").length,
    1,
    "Hidden navigation cannot leave empty transcript rows",
  );
  assert.doesNotMatch(
    ctx.container.querySelector(".roman-timeline").textContent,
    /Manual browsing page|Roman navigated|Lottie|Unsafe link|Viewed/,
  );
  assert.deepEqual(ctx.navigationCalls, []);
});

test("saved cart additions render product and submitted dimensions with a working cart link", async (t) => {
  const products = [
    {
      productPath: "/products/lottie",
      title: "Lottie <img src=x>",
      measurements: { width: 900, height: 1200, unit: "mm" },
    },
    {
      productPath: "/products/lottie",
      title: "Lottie",
      measurements: { width: 35.5, height: 48.25, unit: "in" },
    },
    { productPath: "/products/sample", title: "Sample" },
  ];
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation(
        products.map((product, index) => ({
          ...message(`cart-${index}`, "context", ""),
          parts: [
            {
              type: "cart_added",
              version: 1,
              invocationId: `cart-${index}`,
              product,
            },
          ],
        })),
      ),
    },
  });
  const entries = ctx.container.querySelectorAll(".roman-cart-added");
  assert.equal(entries.length, 3);
  assert.ok(
    [...entries].every((entry) =>
      entry.classList.contains("roman-inline-event"),
    ),
  );
  assert.equal(
    entries[0].textContent,
    "Roman added Lottie <img src=x> to your cart at 900 x 1200mm View Cart",
  );
  assert.equal(
    entries[1].textContent,
    "Roman added Lottie to your cart at 35.5 x 48.25in View Cart",
  );
  assert.equal(
    entries[2].textContent,
    "Roman added Sample to your cart View Cart",
  );
  assert.equal(entries[0].querySelector("img"), null);
  entries[0].querySelector("a").click();
  await until(
    () =>
      ctx.container.querySelector(".roman-view-nav a[aria-current]")
        ?.textContent === "Cart",
    "Cart opens inside Roman",
  );
  assert.deepEqual(ctx.navigationCalls, []);
  assert.deepEqual(ctx.productCalls, []);
  assert.equal(ctx.container.querySelector(".roman-tool-approval"), null);
});

test("saved sample additions render as samples rather than full products", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        {
          ...message("sample-add", "context", ""),
          parts: [
            {
              type: "cart_sample_added",
              version: 1,
              invocationId: "22222222-2222-4222-8222-222222222222",
              sample: {
                productPath: "/products/sample?variant=123",
                title: "Sample <img src=x>",
              },
            },
          ],
        },
      ]),
    },
  });
  const entry = ctx.container.querySelector(".roman-cart-added");
  assert.equal(
    entry?.textContent,
    "Roman added a sample of Sample <img src=x> to your cart View Cart",
  );
  assert.equal(entry?.querySelector("img"), null);
  entry?.querySelector("a")?.click();
  await until(
    () =>
      ctx.container.querySelector(".roman-view-nav a[aria-current]")
        ?.textContent === "Cart",
    "Cart opens inside Roman",
  );
  assert.deepEqual(ctx.navigationCalls, []);
});

test("voice lifecycle events remain chronological context and do not retire a pending follow-up", async (t) => {
  const question = questionMessage();
  const event = (id, event) => ({
    ...message(id, "context", ""),
    parts: [
      {
        type: "voice_event",
        version: 1,
        voiceId: "22222222-2222-4222-8222-222222222222",
        event,
      },
    ],
  });
  const rows = [
    event("voice-start", "started"),
    message("voice-reply", "assistant", "What matters most?"),
    question,
    event("voice-end", "ended"),
    event("voice-restart", "started"),
    event("voice-disconnected", "disconnected"),
  ];
  const ctx = await setup(t, {
    state: { conversation: engagedConversation(rows) },
  });
  const entries = () => [
    ...ctx.container.querySelectorAll(".roman-voice-event"),
  ];
  assert.deepEqual(
    entries().map((e) => e.textContent),
    [
      "Voice chat started",
      "Voice chat ended",
      "Voice chat started",
      "Voice chat disconnected",
    ],
  );
  assert.ok(entries().every((e) => e.classList.contains("roman-inline-event")));
  assert.ok(
    entries().every((e) =>
      e.closest("li").classList.contains("roman-message-context"),
    ),
  );
  assert.equal(ctx.container.querySelectorAll(".roman-question").length, 1);
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    question.parts[0].answers.length,
  );
  ctx.update({
    conversation: engagedConversation(rows.map((row) => ({ ...row }))),
  });
  await delay(0);
  assert.equal(entries().length, 4);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.startVoiceCalls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
});

test("ending a chat retains its transcript and draft until acknowledged, then starts clean", async (t) => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        message("reply", "assistant", "Your saved conversation"),
      ]),
    },
    onEnd: () => pending,
  });
  await ctx.type("Unsent draft");
  const end = ctx.container.querySelector(".roman-end-chat");
  end.click();
  end.click();
  await until(
    () => ctx.container.querySelector(".roman-dialog[open]"),
    "End confirmation did not open",
  );
  assert.deepEqual(ctx.endCalls, []);
  assert.equal(ctx.input().value, "Unsent draft");
  const confirm = ctx.container.querySelector(".roman-dialog-primary");
  confirm.click();
  confirm.click();
  await until(() => ctx.input().disabled, "Ending did not lock the composer");
  assert.deepEqual(ctx.endCalls, ["end"]);
  const dialog = ctx.container.querySelector(".roman-dialog");
  dialog.dispatchEvent(new ctx.window.Event("cancel", { cancelable: true }));
  assert.ok(
    dialog.open,
    "Pending End must not dismiss its acknowledgement state",
  );
  assert.ok(
    [...dialog.querySelectorAll("button")].every((button) => button.disabled),
  );
  assert.match(ctx.container.textContent, /Your saved conversation/);
  assert.equal(ctx.input().value, "Unsent draft");
  finish();
  // The external-store update can render Welcome before endChat's promise
  // continuation resets the composer and releases its local pending state.
  await until(
    () =>
      ctx.container.querySelector(".roman-welcome") && !ctx.input().disabled,
    "End did not return to a ready empty chat",
  );
  assert.equal(ctx.input().value, "");
  assert.equal(ctx.input().disabled, false);
  assert.equal(ctx.container.querySelector(".roman-end-chat"), null);
  await ctx.type("A new conversation");
  ctx.container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => ctx.calls.length === 1,
    "The empty screen could not start a new chat",
  );
  assert.deepEqual(ctx.calls, ["A new conversation"]);
});

test("an unsuccessful End keeps its confirmation, conversation and draft available for retry", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        message("reply", "assistant", "Keep this conversation"),
      ]),
    },
    onEnd: (window) => {
      if (++attempts === 1)
        throw new window.Error("Could not end the chat. Please retry.");
    },
  });
  await ctx.type("Keep this draft");
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "Confirmation missing",
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () => ctx.container.querySelector('[role="alert"]'),
    "End failure was hidden",
  );
  assert.match(ctx.container.textContent, /Could not end the chat/);
  assert.match(ctx.container.textContent, /Keep this conversation/);
  assert.equal(ctx.input().value, "Keep this draft");
  assert.equal(
    ctx.input().disabled,
    true,
    "Open confirmation keeps background entry locked",
  );
  assert.equal(ctx.container.querySelector(".roman-welcome"), null);
  assert.ok(ctx.container.querySelector(".roman-dialog[open]"));
  assert.equal(
    ctx.container.querySelector(".roman-dialog-primary").disabled,
    false,
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () => ctx.container.querySelector(".roman-welcome"),
    "Retry did not finish End",
  );
  assert.deepEqual(ctx.endCalls, ["end", "end"]);
  assert.equal(ctx.container.querySelector(".roman-dialog"), null);
});

test("cancelling End preserves chat and lets the native dialog own Escape and Tab", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        message("reply", "assistant", "Keep chatting here"),
      ]),
    },
  });
  await ctx.type("Keep my unsent draft");
  let escapedPanel = false;
  ctx.container.getRootNode().addEventListener("keydown", () => {
    escapedPanel = true;
  });
  for (const method of ["button", "escape"]) {
    ctx.container.querySelector(".roman-end-chat").click();
    await until(
      () => ctx.container.querySelector(".roman-dialog[open]"),
      "Confirmation missing",
    );
    const dialog = ctx.container.querySelector(".roman-dialog");
    const cancel = dialog.querySelector("button");
    assert.equal(ctx.container.getRootNode().activeElement, cancel);
    assert.match(
      dialog.textContent,
      /Items in your Cart and Gallery will remain/,
    );
    if (method === "button") cancel.click();
    else {
      for (const key of ["Tab", "Escape"]) {
        const event = new ctx.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        cancel.dispatchEvent(event);
        assert.equal(
          event.defaultPrevented,
          false,
          "Native dialog keyboard behaviour must remain enabled",
        );
      }
      assert.equal(
        escapedPanel,
        false,
        "Dialog keys escaped into the assistant panel",
      );
      dialog.dispatchEvent(
        new ctx.window.Event("cancel", { cancelable: true }),
      );
    }
    await until(
      () => !ctx.container.querySelector(".roman-dialog"),
      "Cancel did not dismiss confirmation",
    );
    assert.deepEqual(ctx.endCalls, []);
    assert.deepEqual(ctx.stopVoiceCalls, []);
    assert.match(ctx.container.textContent, /Keep chatting here/);
    assert.equal(ctx.input().value, "Keep my unsent draft");
  }
});

test("late product loading follows the transcript only while the reader stays at its end", async (t) => {
  for (const following of [false, true]) {
    await t.test(
      following ? "following" : "reading earlier messages",
      async (t) => {
        let resolve;
        const pending = new Promise((done) => {
          resolve = done;
        });
        const ctx = await setup(t, {
          state: { conversation: engagedConversation([productsMessage()]) },
          onLoadProducts: () => pending,
        });
        const viewport = ctx.container.querySelector(".roman-chat-scroll");
        Object.defineProperties(viewport, {
          scrollHeight: { value: 1300 },
          clientHeight: { value: 200 },
        });
        if (!following) {
          viewport.scrollTop = 100;
          viewport.dispatchEvent(
            new ctx.window.WheelEvent("wheel", { deltaY: -100, bubbles: true }),
          );
          viewport.dispatchEvent(new ctx.window.Event("scroll"));
        }
        resolve(catalog);
        await until(
          () => ctx.container.querySelector(".roman-choose-blind"),
          "Products did not arrive",
        );
        assert.equal(viewport.scrollTop, following ? 1300 : 100);
      },
    );
  }
});

test("a late card lookup cannot repopulate a cleared conversation", async (t) => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([productsMessage()]) },
    onLoadProducts: () => pending,
  });
  await until(() => ctx.productCalls.length === 1, "Lookup did not start");
  ctx.update({ conversation: null });
  await until(
    () => ctx.container.querySelector(".roman-welcome"),
    "The conversation did not clear",
  );
  resolve(catalog);
  await delay(0);
  assert.equal(ctx.container.querySelector(".roman-choose-blind"), null);
  assert.deepEqual(ctx.errors, []);
});

test("voice captions render as labelled plain text alongside the existing transcript", async (t) => {
  const caption = {
    ...message("voice-message", "assistant", ""),
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: "22222222-2222-4222-8222-222222222222",
        text: "**Hello** <img src=x onerror=alert(1)>",
        startMs: 0,
        endMs: 500,
      },
    ],
  };
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        message("text-message", "user", "My kitchen"),
        caption,
      ]),
    },
  });
  const rendered = ctx.container.querySelector(".roman-voice-caption");
  assert.equal(
    rendered.querySelector(".roman-voice-label").textContent,
    "Voice",
  );
  assert.equal(rendered.querySelector("p").textContent, caption.parts[0].text);
  assert.equal(rendered.querySelector("strong, img, script"), null);
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /My kitchen/,
  );
});

test("voice captions hide speech cues and orphaned punctuation for both speakers without changing stored text", async (t) => {
  const caption = (id, role, text) => ({
    ...message(id, role, ""),
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: "22222222-2222-4222-8222-222222222222",
        text,
        startMs: 0,
        endMs: 500,
      },
    ],
  });
  const rows = [
    caption(
      "user-caption",
      "user",
      " [chuckle] Black blinds, please. [breath] ",
    ),
    caption("roman-caption", "assistant", " . Yeah. [breath] Let me check."),
    caption("incoming-caption", "assistant", " [breath] . "),
    message("literal-customer", "user", "What does [breath] mean?"),
  ];
  const original = structuredClone(rows);
  const ctx = await setup(t, {
    state: { conversation: engagedConversation(rows) },
  });
  const captions = () => [
    ...ctx.container.querySelectorAll(".roman-voice-caption p"),
  ];
  assert.deepEqual(
    captions().map((p) => p.textContent),
    ["Black blinds, please.", "Yeah. Let me check."],
  );
  assert.equal(
    ctx.container.querySelectorAll(".roman-timeline > li").length,
    3,
  );
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /What does \[breath\] mean\?/,
  );
  assert.deepEqual(rows, original);
  const firstCaption = captions()[0];
  ctx.update({
    conversation: engagedConversation([
      ...rows.slice(0, 2),
      caption("incoming-caption", "assistant", " [breath] . Found one."),
      rows[3],
    ]),
  });
  await until(
    () => captions().length === 3,
    "Caption text did not appear after its cue-only fragment",
  );
  assert.equal(captions()[0], firstCaption);
  assert.equal(captions()[2].textContent, "Found one.");
  assert.deepEqual(rows, original);
  assert.deepEqual(ctx.errors, []);
});

test("the voice bar reflects dock mute state and restores the saved text draft after stopping", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([
        message("user-message", "user", "My kitchen"),
      ]),
    },
  });
  const button = (label, parent = ctx.container) =>
    [...parent.querySelectorAll("button")].find(
      (item) =>
        item.getAttribute("aria-label") === label || item.textContent === label,
    );
  assert.equal(ctx.input().disabled, false);
  await ctx.type("Save my kitchen dimensions");
  const input = ctx.input();
  const form = input.closest("form");
  ctx.update({ voice: { status: "active", muted: false, error: null } });
  await until(
    () => !!button("End voice"),
    "Voice controls did not become active",
  );
  assert.equal(ctx.input(), null);
  assert.equal(form.hidden, false);
  assert.equal(form.closest(".roman-composer").hidden, false);
  const bar = ctx.container.querySelector(".roman-voice-bar");
  const waveform = bar.querySelector(".roman-voice-waveform");
  assert.equal(waveform.getAttribute("aria-hidden"), "true");
  assert.ok(waveform.children.length > 7, "waveform spans the full bar");
  assert.equal(button("Mute microphone"), undefined);
  assert.equal(bar.querySelectorAll("button").length, 1);
  assert.equal(button("End voice").type, "button");
  assert.ok(button("Stop voice", ctx.voiceDock));
  assert.equal(ctx.container.contains(ctx.voiceDock), false);
  button("Mute microphone", ctx.voiceDock).click();
  await until(
    () => waveform.dataset.muted === "true",
    "Mute did not synchronize with sidebar",
  );
  assert.equal(
    button("Unmute microphone", ctx.voiceDock).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(bar.querySelector(".roman-voice-waveform"), waveform);
  assert.equal(bar.querySelector(".roman-voice-notice"), null);
  assert.deepEqual(ctx.muteCalls, [true]);
  button("Unmute microphone", ctx.voiceDock).click();
  await until(
    () => !waveform.dataset.muted,
    "Unmute did not restore the decorative waveform",
  );
  assert.equal(!!bar.querySelector(".roman-voice-notice"), false);
  assert.deepEqual(ctx.muteCalls, [true, false]);
  assert.ok(button("Mute microphone", ctx.voiceDock));
  button("Stop voice", ctx.voiceDock).click();
  await until(() => ctx.input(), "Stop did not return to text");
  assert.equal(ctx.input().disabled, false);
  assert.notEqual(ctx.input(), input);
  assert.equal(ctx.input().value, "Save my kitchen dimensions");
  assert.ok(button("Send"), "restored non-empty draft offers Send");
  assert.equal(form.hidden, false);
  assert.equal(form.closest(".roman-composer").hidden, false);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), null);
  assert.equal(ctx.voiceDock.childElementCount, 0);
  assert.deepEqual(ctx.stopVoiceCalls, ["stop"]);
  assert.deepEqual(ctx.startVoiceCalls, []);
  assert.deepEqual(ctx.calls, []);
  assert.match(
    ctx.container.querySelector(".roman-timeline").textContent,
    /My kitchen/,
  );
});

test("restored remote voice can be ended explicitly without activating the microphone", async (t) => {
  const ctx = await setup(t, {
    state: {
      conversation: {
        ...engagedConversation([]),
        voice: { id: "voice", clientId: "previous-owner", status: "active" },
      },
    },
  });
  assert.match(
    ctx.container.querySelector(".roman-voice-notice").textContent,
    /Voice is active in another page/,
  );
  const end = ctx.container.querySelector('[aria-label="End voice"]');
  assert.ok(end);
  const mute = ctx.container.querySelector('[aria-label="Mute microphone"]');
  assert.equal(mute, null);
  assert.deepEqual(ctx.muteCalls, []);
  assert.equal(!!ctx.container.querySelector(".roman-voice-waveform"), false);
  assert.ok(
    ctx.container.querySelector(".roman-voice-bar > .roman-voice-notice"),
  );
  assert.equal(ctx.input(), null);
  assert.equal(
    ctx.container.querySelector(".roman-composer form").hidden,
    false,
  );
  assert.equal(ctx.voiceDock.childElementCount, 0);
  assert.deepEqual(ctx.startVoiceCalls, []);
  end.click();
  await until(
    () =>
      !ctx.container.querySelector(".roman-voice-bar") &&
      ctx.input() &&
      !ctx.input().disabled,
    "Ending remote voice did not restore the text composer",
  );
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), null);
  assert.deepEqual(ctx.stopVoiceCalls, ["stop"]);
  assert.deepEqual(ctx.startVoiceCalls, []);
});

test("voice selector offers all Live voices, defaults to Marin and changes only a stopped connection", async (t) => {
  const ctx = await setup(t, { showTools: true });
  const selector = ctx.container.querySelector(".roman-voice-choice select");
  assert.ok(selector.closest(".roman-tools"));
  assert.equal(
    ctx.container.querySelectorAll(".roman-settings-trigger").length,
    1,
  );
  assert.equal(ctx.container.querySelectorAll("details").length, 0);
  assert.equal(
    ctx.container.querySelector(".roman-voice-controls select"),
    null,
  );
  assert.equal(selector.value, "marin");
  assert.equal(selector.options.length, 22);
  assert.ok([...selector.options].some((option) => option.value === "gleam"));
  assert.equal(
    ctx.container.querySelector(`label[for="${selector.id}"]`).textContent,
    "Voice",
  );
  selector.value = "gleam";
  selector.dispatchEvent(new ctx.window.Event("change", { bubbles: true }));
  await until(
    () => selector.value === "gleam",
    "Voice selection did not update",
  );
  const button = (text) =>
    [...ctx.container.querySelectorAll("button")].find(
      (node) =>
        node.getAttribute("aria-label") === text || node.textContent === text,
    );
  button("Start voice").click();
  await until(() => selector.disabled, "Active voice selector stayed enabled");
  assert.match(
    ctx.container.querySelector(".roman-voice-choice-hint").textContent,
    /End voice/,
  );
  assert.equal(ctx.voiceDock.querySelectorAll("select").length, 0);
  button("End voice").click();
  await until(
    () => !selector.disabled,
    "Stopped voice selector stayed disabled",
  );
  assert.equal(selector.value, "gleam");
});

test("starting, stopping and restored remote voice disable changing the voice", async (t) => {
  for (const state of [
    { voice: { status: "starting", muted: false, error: null } },
    { voice: { status: "stopping", muted: true, error: null } },
    {
      conversation: {
        id: "restored",
        messages: [],
        tools: [],
        voice: { id: "voice", clientId: "old", status: "active" },
      },
    },
  ]) {
    const ctx = await setup(t, { state, showTools: true });
    assert.equal(
      ctx.container.querySelector(".roman-voice-choice select").disabled,
      true,
    );
    assert.match(
      ctx.container.querySelector(".roman-voice-choice-hint").textContent,
      /End voice/,
    );
  }
});

test("voice selection stays out of the customer controls when developer tools are hidden", async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.container.querySelector(".roman-voice-choice"), null);
  assert.ok(
    [...ctx.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Start voice",
    ),
  );
});

test("connecting and stopping voice retain the hidden draft and prevent repeated shutdown", async (t) => {
  let stopped;
  const accepted = new Promise((resolve) => {
    stopped = resolve;
  });
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([]) },
    onStopVoice: () => {
      ctx.update({ voice: { status: "stopping", muted: true, error: null } });
      return accepted;
    },
  });
  await ctx.type("My saved draft before connecting");
  const input = ctx.input();
  const form = input.closest("form");
  ctx.update({ voice: { status: "starting", muted: false, error: null } });
  await until(
    () => ctx.container.querySelector('[aria-label="End voice"]'),
    "Connecting voice did not expose cancellation",
  );
  assert.equal(!!ctx.container.querySelector(".roman-voice-waveform"), false);
  assert.ok(
    ctx.container.querySelector(".roman-voice-bar > .roman-voice-notice"),
  );
  assert.match(
    ctx.container.querySelector(".roman-voice-notice").textContent,
    /Connecting voice/,
  );
  assert.equal(form.hidden, false);
  assert.equal(ctx.input(), null);
  const mute = ctx.container.querySelector('[aria-label="Mute microphone"]');
  assert.equal(mute, null);
  assert.deepEqual(ctx.muteCalls, []);
  assert.deepEqual(
    ctx.startVoiceCalls,
    [],
    "Rendering connection state must not request another microphone session",
  );
  ctx.container.querySelector('[aria-label="End voice"]').click();
  await until(
    () => ctx.container.querySelector('[aria-label="End voice"]')?.disabled,
    "Shutdown did not disable End voice",
  );
  assert.match(
    ctx.container.querySelector(".roman-voice-notice").textContent,
    /Ending voice/,
  );
  assert.equal(!!ctx.container.querySelector(".roman-voice-waveform"), false);
  ctx.container.querySelector('[aria-label="End voice"]').click();
  assert.deepEqual(ctx.stopVoiceCalls, ["stop"]);
  assert.equal(input.value, "My saved draft before connecting");
  stopped();
  await until(
    () =>
      !ctx.container.querySelector(".roman-voice-bar") &&
      ctx.input() &&
      !ctx.input().disabled,
    "Completed shutdown did not restore editing",
  );
  assert.notEqual(ctx.input(), input);
  assert.equal(ctx.input().value, "My saved draft before connecting");
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), null);
  assert.deepEqual(ctx.calls, []);
});

test("an unavailable microphone leaves text usable and retries only after another explicit click", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    onStartVoice: (window) => {
      if (++attempts === 1) {
        ctx.update({
          voice: {
            status: "error",
            muted: false,
            error:
              "No microphone was found. Connect a microphone and try voice again.",
          },
        });
        throw new window.Error("Microphone unavailable");
      }
    },
  });
  const input = ctx.input();
  ctx.container.querySelector('[aria-label="Start voice"]').click();
  await until(
    () => ctx.container.textContent.includes("No microphone was found."),
    "Voice startup error was hidden",
  );
  assert.equal(input.closest("form").hidden, false);
  assert.equal(input.closest(".roman-composer").hidden, false);
  assert.equal(input.disabled, false);
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), null);
  assert.equal(ctx.container.querySelector("dialog"), null);
  await ctx.type("Keep this text after a failed microphone request");
  assert.equal(input.value, "Keep this text after a failed microphone request");
  assert.deepEqual(ctx.startVoiceCalls, ["start"]);
  ctx.update({ selectedVoice: "gleam" });
  await delay(0);
  assert.deepEqual(
    ctx.startVoiceCalls,
    ["start"],
    "An unrelated state update retried voice",
  );
  await ctx.type("");
  ctx.container.querySelector('[aria-label="Start voice"]').click();
  await until(
    () => ctx.container.querySelector(".roman-voice-waveform"),
    "Explicit voice retry did not connect",
  );
  assert.equal(ctx.input(), null);
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  assert.deepEqual(ctx.startVoiceCalls, ["start", "start"]);
  assert.deepEqual(ctx.calls, []);
});

test("an explicit denied-microphone attempt opens the branded dialog and only a new click retries", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    onStartVoice: async (window) => {
      if (++attempts === 1) {
        ctx.update({
          voice: { status: "starting", muted: false, error: null },
        });
        await until(() => !ctx.input(), "Connection did not replace the input");
        ctx.update({
          voice: {
            status: "error",
            muted: false,
            error: "Allow microphone access in your browser to talk to Roman.",
            errorCode: "microphone_denied",
          },
        });
        throw new window.Error("Microphone permission was denied");
      }
    },
  });
  const originalTrigger = ctx.container.querySelector(
    '[aria-label="Start voice"]',
  );
  originalTrigger.focus();
  originalTrigger.click();
  await until(
    () => ctx.container.querySelector("dialog[open]"),
    "An explicit denied voice attempt did not explain the permission issue",
  );
  const dialog = ctx.container.querySelector("dialog");
  assert.ok(dialog.classList.contains("roman-dialog"));
  assert.equal(
    dialog.querySelector("h2").textContent,
    "Microphone access is off",
  );
  assert.equal(dialog.querySelector("img"), null);
  assert.match(dialog.textContent, /browser.*site settings/);
  assert.match(dialog.textContent, /keep chatting by text/);
  assert.equal(
    ctx.container.querySelector(".roman-composer [role=alert]"),
    null,
  );
  assert.equal(ctx.input().disabled, false);
  dialog.querySelector("button").click();
  await until(
    () => !ctx.container.querySelector("dialog"),
    "Permission dialog did not close",
  );
  const currentTrigger = ctx.container.querySelector(
    '[aria-label="Start voice"]',
  );
  assert.notEqual(currentTrigger, originalTrigger);
  assert.equal(ctx.container.getRootNode().activeElement, currentTrigger);
  await ctx.type("I can still use text");
  ctx.update({ selectedVoice: "gleam" });
  await delay(0);
  assert.deepEqual(ctx.startVoiceCalls, ["start"]);
  assert.equal(ctx.container.querySelector("dialog"), null);
  await ctx.type("");
  ctx.container.querySelector('[aria-label="Start voice"]').click();
  await until(
    () => ctx.container.querySelector(".roman-voice-waveform"),
    "Explicit voice retry did not connect",
  );
  assert.equal(ctx.container.querySelector("dialog"), null);
  assert.deepEqual(ctx.startVoiceCalls, ["start", "start"]);
  assert.deepEqual(ctx.calls, []);
});

test("a denied microphone snapshot from autostart quietly restores text without opening a popup", async (t) => {
  const ctx = await setup(t, {
    state: { voice: { status: "starting", muted: false, error: null } },
  });
  assert.equal(ctx.input(), null);
  ctx.update({
    voice: {
      status: "error",
      muted: false,
      error: "Allow microphone access in your browser to talk to Roman.",
      errorCode: "microphone_denied",
    },
  });
  await until(() => ctx.input(), "Autostart denial did not restore text");
  assert.equal(ctx.container.querySelector("dialog"), null);
  assert.equal(
    ctx.container.querySelector(".roman-composer [role=alert]"),
    null,
  );
  assert.equal(ctx.container.querySelector(".roman-voice-notice"), null);
  assert.ok(ctx.container.querySelector('[aria-label="Start voice"]'));
  assert.ok(ctx.container.querySelector(".roman-welcome"));
  await ctx.type("Help me measure");
  ctx.container.querySelector('button[type="submit"]').click();
  await until(
    () => ctx.calls.length === 1,
    "Text did not work after denied autostart",
  );
  assert.deepEqual(ctx.calls, ["Help me measure"]);
  assert.deepEqual(ctx.startVoiceCalls, []);
});

test("a failed voice shutdown retains an explicit retry and preserves the hidden draft", async (t) => {
  let attempts = 0;
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([]) },
    onStopVoice: (window) => {
      if (++attempts === 1) throw new window.Error("Stop remains unconfirmed");
    },
  });
  await ctx.type("Do not discard my unsent measurements");
  const input = ctx.input();
  const composer = input.closest(".roman-composer");
  ctx.update({
    voice: {
      status: "error",
      muted: true,
      error: "Voice stopped locally. End voice to finish saving.",
    },
    error: "Connection needs attention.",
  });
  await until(
    () => ctx.container.querySelector('[aria-label="End voice"]'),
    "Unconfirmed stop did not expose recovery",
  );
  assert.equal(ctx.input(), null);
  assert.equal(composer.hidden, false);
  assert.match(composer.textContent, /Connection needs attention/);
  assert.equal(!!ctx.container.querySelector(".roman-voice-waveform"), false);
  assert.ok(
    ctx.container.querySelector(".roman-voice-bar > .roman-voice-notice"),
  );
  const mute = ctx.container.querySelector('[aria-label="Unmute microphone"]');
  assert.equal(mute, null);
  assert.deepEqual(ctx.muteCalls, []);
  ctx.container.querySelector('[aria-label="End voice"]').click();
  await until(
    () => ctx.stopVoiceCalls.length === 1,
    "Stop retry was not attempted",
  );
  await delay(0);
  assert.equal(ctx.input(), null);
  assert.equal(input.value, "Do not discard my unsent measurements");
  ctx.container.querySelector('[aria-label="End voice"]').click();
  await until(
    () =>
      !ctx.container.querySelector(".roman-voice-bar") &&
      ctx.input() &&
      !ctx.input().disabled,
    "Acknowledged stop did not restore text",
  );
  assert.notEqual(ctx.input(), input);
  assert.equal(ctx.input().value, "Do not discard my unsent measurements");
  assert.deepEqual(ctx.stopVoiceCalls, ["stop", "stop"]);
  assert.deepEqual(ctx.startVoiceCalls, []);
  assert.deepEqual(ctx.calls, []);
});

function questionMessage(id = "question-one", question = "What matters most?") {
  return {
    ...message(id, "assistant", ""),
    parts: [
      {
        type: "question",
        version: 1,
        invocationId: id,
        question,
        answers: ["Full blackout", "Daytime privacy"],
      },
    ],
  };
}

test("easy answers have one labelled panel below cards and the canonical question stays visible in the transcript", async (t) => {
  const row = questionMessage("question-one", "What matters most? <img src=x>");
  row.parts.push(
    { type: "text", text: "Here are a few useful options." },
    productsMessage().parts[1],
    {
      type: "guides",
      version: 1,
      invocationId: "33333333-3333-4333-8333-333333333333",
      productPath: "/products/example",
      guides: [
        {
          kind: "measuring",
          url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=1",
        },
      ],
    },
  );
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([row]) },
  });
  const parts = ctx.container.querySelector(".roman-message-parts");
  const widget = ctx.container.querySelector(".roman-question");
  assert.ok(widget, "Question widget must be visible");
  assert.ok(widget.classList.contains("roman-action-panel"));
  assert.equal(widget.getAttribute("aria-live"), "polite");
  assert.equal(
    widget.querySelectorAll(".roman-action-buttons button").length,
    row.parts[0].answers.length,
  );
  assert.ok(
    ctx.container
      .querySelector(".roman-timeline > li:last-child")
      .contains(widget),
    "Question must follow all cards",
  );
  assert.equal(parts.querySelector('a[href*=".pdf"]'), null);
  assert.equal(widget.querySelector("p").textContent, row.parts[0].question);
  assert.equal(
    widget.getAttribute("aria-labelledby"),
    widget.querySelector("p").id,
  );
  assert.deepEqual(
    [...widget.querySelectorAll("button")].map((button) => button.textContent),
    row.parts[0].answers,
  );
  assert.equal(widget.querySelector("img, a"), null);
  assert.match(widget.textContent, /Or reply in your own words/);
  const history = [
    ...ctx.container.querySelectorAll(".roman-timeline .roman-message-text"),
  ].filter((node) => node.textContent === row.parts[0].question);
  assert.equal(history.length, 1, "The transcript owns exactly one copy");
  assert.equal(history[0].closest("li").hidden, false);
  assert.equal(history[0], widget.querySelector("p"));
  const ids = [...ctx.container.querySelectorAll("[id]")].map(
    (node) => node.id,
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    "Question labels must have unique IDs",
  );
});

test("clicking an easy answer submits ordinary customer text once and retires choices after acceptance", async (t) => {
  const row = questionMessage();
  let release;
  const accepted = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([row]) },
    onSend: () => accepted,
  });
  const button = ctx.container.querySelector(".roman-question button");
  button.click();
  button.click();
  await until(
    () => button.disabled,
    "Question was not locked during submission",
  );
  assert.deepEqual(ctx.calls, ["Full blackout"]);
  assert.equal(
    ctx.container.querySelector(".roman-question").getAttribute("aria-busy"),
    "true",
  );
  ctx.update({
    conversation: engagedConversation([
      row,
      message("reply", "user", "Full blackout"),
    ]),
  });
  release();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Accepted answer retained choices",
  );
  const first = ctx.container.querySelector(".roman-message-parts");
  assert.equal(first.textContent, row.parts[0].question);
  assert.equal(first.querySelectorAll("button").length, 0);
  assert.ok(
    ctx.container.getRootNode().activeElement === first.querySelector("p"),
    "Focus should stay on the retired question",
  );
  assert.match(
    ctx.container.querySelector(".roman-message-user").textContent,
    /Full blackout/,
  );
});

test("journey activity leaves choices available but text and voice customer replies retire them", async (t) => {
  for (const spoken of [false, true]) {
    const row = questionMessage();
    const journey = {
      ...message("visit", "context", ""),
      parts: [
        {
          type: "page_view",
          version: 1,
          path: "/products/example",
          title: "Example",
          occurredAt: row.createdAt,
        },
      ],
    };
    const ctx = await setup(t, {
      state: { conversation: engagedConversation([row, journey]) },
    });
    assert.ok(ctx.container.querySelector(".roman-question button"));
    assert.ok(
      ctx.container
        .querySelector(".roman-timeline > li:last-child")
        .querySelector(".roman-question"),
      "The active question must remain beneath journey activity",
    );
    const reply = message("reply", "user", "I prefer privacy");
    if (spoken)
      reply.parts = [
        {
          type: "voice",
          version: 1,
          voiceId: "22222222-2222-4222-8222-222222222222",
          text: "I prefer privacy",
          startMs: 10,
          endMs: 20,
        },
      ];
    ctx.update({ conversation: engagedConversation([row, journey, reply]) });
    await until(
      () => !ctx.container.querySelector(".roman-question"),
      "Customer reply retained choices",
    );
    assert.equal(
      ctx.container.querySelector(".roman-message-parts").textContent,
      row.parts[0].question,
    );
    assert.deepEqual(ctx.calls, []);
  }
});

test("voice restart retains saved choices and a re-asked question replaces them without a second active widget", async (t) => {
  const row = questionMessage();
  row.role = "context";
  row.parts[0].voiceReply = {
    voiceId: "22222222-2222-4222-8222-222222222222",
    afterSequence: 2,
  };
  const ctx = await setup(t, {
    state: {
      conversation: engagedConversation([row]),
      voice: { status: "active", muted: false, error: null },
    },
  });
  const original = ctx.container.querySelector(".roman-question");
  ctx.container.querySelector('[aria-label="End voice"]').click();
  await until(
    () => ctx.container.querySelector('[aria-label="Start voice"]'),
    "Voice did not stop",
  );
  assert.equal(ctx.container.querySelector(".roman-question"), original);
  ctx.container.querySelector('[aria-label="Start voice"]').click();
  await until(
    () => ctx.container.querySelector('[aria-label="End voice"]'),
    "Voice did not restart",
  );
  const greeting = {
    ...message("resumed-greeting", "assistant", ""),
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: "33333333-3333-4333-8333-333333333333",
        text: "Hi, it's Roman again. What matters most?",
        startMs: 0,
        endMs: 1000,
      },
    ],
  };
  ctx.update({ conversation: engagedConversation([row, greeting]) });
  await until(
    () => ctx.container.querySelector(".roman-voice-caption"),
    "Resumed greeting did not render",
  );
  assert.equal(ctx.container.querySelector(".roman-question"), original);
  const repeated = questionMessage("resumed-question");
  ctx.update({ conversation: engagedConversation([row, greeting, repeated]) });
  await until(
    () => ctx.container.querySelector(".roman-question") !== original,
    "Re-asked question did not replace the old choices",
  );
  assert.equal(ctx.container.querySelectorAll(".roman-question").length, 1);
  assert.equal(original.isConnected, false);
  const answer = {
    ...message("spoken-answer", "user", ""),
    parts: [
      {
        type: "voice",
        version: 1,
        voiceId: "33333333-3333-4333-8333-333333333333",
        text: "Full blackout",
        startMs: 2000,
        endMs: 3000,
      },
    ],
  };
  ctx.update({
    conversation: engagedConversation([row, greeting, repeated, answer]),
  });
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Spoken answer retained the re-asked choices",
  );
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.stopVoiceCalls, ["stop"]);
  assert.deepEqual(ctx.startVoiceCalls, ["start"]);
});

test("typing a free-text answer uses the normal composer and retires choices only when accepted", async (t) => {
  const row = questionMessage();
  let ctx;
  ctx = await setup(t, {
    state: { conversation: engagedConversation([row]) },
    onSend: (text) =>
      ctx.update({
        conversation: engagedConversation([
          row,
          message("reply", "user", text),
        ]),
      }),
  });
  await ctx.type("A little of both, please");
  assert.ok(ctx.container.querySelector(".roman-question"));
  ctx.container.querySelector('.roman-composer button[type="submit"]').click();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Typed answer retained choices",
  );
  assert.deepEqual(ctx.calls, ["A little of both, please"]);
  assert.equal(
    ctx.container.querySelector(".roman-message-assistant .roman-message-parts")
      .textContent,
    row.parts[0].question,
  );
});

test("only the newest question has choices and ended sessions retain plain questions", async (t) => {
  const first = questionMessage();
  const next = questionMessage("question-two", "Which room is this for?");
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([first, next]) },
  });
  assert.equal(ctx.container.querySelectorAll(".roman-question").length, 1);
  assert.match(
    ctx.container.querySelector(".roman-question").textContent,
    /Which room is this for/,
  );
  assert.equal(
    ctx.container.querySelector(".roman-message-assistant .roman-message-parts")
      .textContent,
    first.parts[0].question,
  );
  ctx.update({
    conversation: { ...engagedConversation([first, next]), status: "ended" },
  });
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Ended session retained clickable choices",
  );
  assert.ok(ctx.container.textContent.includes(first.parts[0].question));
  assert.ok(ctx.container.textContent.includes(next.parts[0].question));
});

test("a failed easy answer stays retryable without automatically resending", async (t) => {
  const row = questionMessage();
  let attempts = 0;
  let ctx;
  ctx = await setup(t, {
    state: { conversation: engagedConversation([row]) },
    onSend: (text, window) => {
      if (++attempts === 1)
        throw new window.Error("Connection lost. Please retry.");
      ctx.update({
        conversation: engagedConversation([
          row,
          message("reply", "user", text),
        ]),
      });
    },
  });
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => ctx.container.querySelector('.roman-question [role="alert"]'),
    "Question failure was not displayed",
  );
  assert.match(
    ctx.container.querySelector('.roman-question [role="alert"]').textContent,
    /Connection lost/,
  );
  assert.deepEqual(ctx.calls, ["Full blackout"]);
  assert.equal(
    ctx.container.querySelector(".roman-question button").disabled,
    false,
  );
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Retried answer was not accepted",
  );
  assert.deepEqual(ctx.calls, ["Full blackout", "Full blackout"]);
});

test("guided numeric input submits through the active chat mode and retires on product navigation", async (t) => {
  for (const voice of [false, true]) {
    await t.test(voice ? "live voice" : "text", async (t) => {
      const row = questionMessage();
      Object.assign(row.parts[0], {
        question: "What is the width?",
        answers: [],
        measurement: {
          productPath: "/products/example",
          label: "Width",
          unit: "mm",
          instructions: "Measure the top of the recess without deductions.",
        },
      });
      const ctx = await setup(t, {
        state: {
          conversation: engagedConversation([row]),
          ...(voice
            ? { voice: { status: "active", muted: false, error: null } }
            : {}),
        },
      });
      const input = ctx.container.querySelector(".roman-question input");
      assert.ok(input);
      Object.getOwnPropertyDescriptor(
        ctx.window.HTMLInputElement.prototype,
        "value",
      ).set.call(input, "500.5");
      input.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
      await delay(0);
      ctx.container
        .querySelector(".roman-question form")
        .dispatchEvent(
          new ctx.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await until(
        () => (voice ? ctx.voiceAnswers : ctx.calls).length === 1,
        "Numeric answer did not reach the active mode",
      );
      assert.deepEqual(ctx.calls, voice ? [] : ["Width: 500.5"]);
      assert.deepEqual(
        ctx.voiceAnswers,
        voice
          ? [
              {
                questionId: row.parts[0].invocationId,
                answer: "Width: 500.5",
              },
            ]
          : [],
      );
      assert.deepEqual(ctx.stopVoiceCalls, []);
      ctx.updateNavigation({ pending: true });
      await until(
        () => ctx.container.querySelector(".roman-question input").disabled,
        "Input stayed enabled during navigation",
      );
      ctx.updateNavigation({
        pending: false,
        url: "https://hd-dev-single.myshopify.com/products/other",
      });
      await until(
        () => !ctx.container.querySelector(".roman-question input"),
        "Old product retained an active numeric input",
      );
      assert.equal(
        ctx.container.textContent.includes(
          row.parts[0].measurement.instructions,
        ),
        false,
      );
    });
  }
});

test("a voice answer keeps the live bar and mic state, submits once, and retires accepted choices", async (t) => {
  const row = questionMessage();
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  let ctx;
  ctx = await setup(t, {
    state: {
      conversation: engagedConversation([row]),
      voice: { status: "active", muted: true, error: null },
    },
    onVoiceAnswer: async (_questionId, answer) => {
      ctx.update({
        pending: true,
        optimisticMessage: message("local-reply", "user", answer, "pending"),
      });
      await accepted;
      ctx.update({
        pending: false,
        optimisticMessage: null,
        conversation: engagedConversation([
          row,
          message("reply", "user", answer),
        ]),
      });
    },
  });
  assert.equal(
    ctx.container.querySelector(".roman-question-hint").textContent,
    "Reply aloud or choose an answer.",
  );
  const bar = ctx.container.querySelector(".roman-voice-bar");
  const button = ctx.container.querySelector(".roman-question button");
  button.click();
  button.click();
  await until(
    () => ctx.voiceAnswers.length === 1,
    "Answer was not submitted to voice",
  );
  assert.deepEqual(ctx.voiceAnswers, [
    { questionId: row.parts[0].invocationId, answer: "Full blackout" },
  ]);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Locally selected voice answer kept waiting for the server",
  );
  assert.equal(
    [
      ...ctx.container.querySelectorAll(
        ".roman-message-user .roman-message-text",
      ),
    ].at(-1).textContent,
    "Full blackout",
  );
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), bar);
  accept();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Accepted answer retained choices",
  );
  assert.equal(ctx.container.querySelector(".roman-voice-bar"), bar);
  assert.equal(
    bar.querySelector(".roman-voice-waveform").dataset.muted,
    "true",
  );
  assert.ok(ctx.voiceDock.querySelector('[aria-label="Unmute microphone"]'));
  assert.deepEqual(ctx.muteCalls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
});

test("failed voice answer stays retryable without stopping voice or generating text", async (t) => {
  const row = questionMessage();
  let attempts = 0;
  let ctx;
  ctx = await setup(t, {
    state: {
      conversation: engagedConversation([row]),
      voice: { status: "active", muted: false, error: null },
    },
    onVoiceAnswer: (_questionId, answer, window) => {
      if (++attempts === 1)
        throw new window.Error("Connection lost. Please retry.");
      ctx.update({
        conversation: engagedConversation([
          row,
          message("reply", "user", answer),
        ]),
      });
    },
  });
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => ctx.container.querySelector('.roman-question [role="alert"]'),
    "Voice answer failure not shown",
  );
  assert.equal(
    ctx.container.querySelector(".roman-question button").disabled,
    false,
  );
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
  assert.equal(ctx.voiceAnswers.length, 1);
  ctx.container.querySelector(".roman-question button").click();
  await until(
    () => !ctx.container.querySelector(".roman-question"),
    "Retried answer not accepted",
  );
  assert.equal(ctx.voiceAnswers.length, 2);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
});

test("a question waiting for voice in another page cannot end that connection or send text", async (t) => {
  const row = questionMessage();
  const ctx = await setup(t, {
    state: {
      conversation: {
        ...engagedConversation([row]),
        voice: { id: "remote", clientId: "previous", status: "active" },
      },
    },
  });
  const button = ctx.container.querySelector(".roman-question button");
  assert.equal(button.disabled, true);
  button.click();
  assert.deepEqual(ctx.voiceAnswers, []);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.stopVoiceCalls, []);
});

test("reply activity covers submission and the real empty text part, survives chunks, and clears on completion", async (t) => {
  const user = message("request", "user", "Help me choose a blind");
  const ctx = await setup(t, {
    state: { pending: true, optimisticMessage: { ...user, status: "pending" } },
  });
  const activity = () => ctx.container.querySelector(".roman-reply-activity");
  assert.equal(activity().textContent, "Roman is thinking…");
  assert.equal(activity().getAttribute("role"), "status");
  assert.equal(activity().getAttribute("aria-atomic"), "true");
  assert.equal(
    ctx.container.querySelector(".roman-chat-scroll").contains(activity()),
    true,
  );
  const pendingReply = {
    ...message("reply", "assistant", "", "pending"),
    parts: [{ type: "text", text: "" }],
  };
  ctx.update({
    pending: false,
    optimisticMessage: null,
    conversation: { ...engagedConversation([user, pendingReply]), busy: true },
  });
  await until(
    () => ctx.container.querySelector('[role="log"]'),
    "Accepted reply did not render",
  );
  assert.equal(activity().textContent, "Roman is thinking…");
  assert.equal(
    ctx.container.querySelectorAll(".roman-reply-activity").length,
    1,
  );
  const node = activity();
  for (const text of [
    "Here are",
    "Here are some suitable",
    "Here are some suitable blinds.",
  ]) {
    ctx.update({
      conversation: {
        ...engagedConversation([
          user,
          message("reply", "assistant", text, "pending"),
        ]),
        busy: true,
      },
    });
    await until(
      () => activity()?.textContent === "Roman is replying…",
      "A streamed chunk lost reply feedback",
    );
    assert.equal(
      activity(),
      node,
      "A label update must retain its status region",
    );
  }
  ctx.update({
    conversation: engagedConversation([
      user,
      message("reply", "assistant", "Here are some suitable blinds."),
    ]),
  });
  await until(
    () => !activity(),
    "Completed reply retained its working indicator",
  );
  assert.match(
    ctx.container.querySelector('[role="log"]').textContent,
    /Here are some suitable blinds/,
  );
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.startVoiceCalls, []);
});

test("tool progress names the running work and progress-only updates preserve the focused draft", async (t) => {
  const ctx = await setup(t, {
    state: { conversation: engagedConversation([]) },
  });
  await ctx.type("Keep my bedroom measurements");
  const input = ctx.input();
  input.focus();
  input.setSelectionRange(5, 15, "forward");
  const activity = () => ctx.container.querySelector(".roman-reply-activity");
  const queued = {
    id: "queued",
    name: "get_cart",
    status: "pending",
    arguments: {},
  };
  // Tool state is independently projected: repainting it must not replace or
  // focus the input. The conversation owner separately controls input disabling.
  for (const [name, expected] of [
    ["search_products", "Finding suitable products…"],
    ["lookup_catalog", "Checking product details…"],
    ["get_product_guides", "Finding measuring and fitting guides…"],
    ["navigate", "Opening the page…"],
    ["add_to_cart", "Adding to your cart…"],
    ["set_cart_quantity", "Updating your cart…"],
    ["apply_measurements", "Entering your measurements…"],
  ]) {
    ctx.update({
      conversation: {
        ...engagedConversation([]),
        tools: [
          queued,
          { id: "active", name, status: "running", arguments: {} },
        ],
      },
    });
    await until(
      () => activity()?.textContent === expected,
      `Missing customer progress for ${name}`,
    );
    assert.equal(ctx.input(), input);
    assert.equal(input.getRootNode().activeElement, input);
    assert.equal(input.value, "Keep my bedroom measurements");
    assert.deepEqual(
      [input.selectionStart, input.selectionEnd, input.selectionDirection],
      [5, 15, "forward"],
    );
  }
  ctx.update({ conversation: { ...engagedConversation([]), tools: [queued] } });
  await until(
    () => activity()?.textContent === "Checking your cart…",
    "Pending work was not represented",
  );
  ctx.update({ conversation: engagedConversation([]) });
  await until(() => !activity(), "Retired tool progress remained visible");
  assert.equal(input.getRootNode().activeElement, input);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.startVoiceCalls, []);
});

for (const voice of [false, true]) {
  test(`${voice ? "voice" : "text"} progress names only the guides currently being read and yields to browser actions`, async (t) => {
    const ctx = await setup(t, {
      state: {
        voice: { status: voice ? "active" : "idle", muted: false, error: null },
        conversation: { ...engagedConversation([]), busy: true },
      },
    });
    const activity = () => ctx.container.querySelector(".roman-reply-activity");
    for (const [readingGuides, label] of [
      [["measuring"], "Roman is reading the measuring guide…"],
      [["fitting"], "Roman is reading the fitting guide…"],
      [
        ["fitting", "measuring"],
        "Roman is reading the measuring and fitting guides…",
      ],
    ]) {
      ctx.update({
        conversation: { ...engagedConversation([]), busy: true, readingGuides },
      });
      await until(
        () => activity()?.textContent === label,
        "Guide reading label did not update",
      );
      assert.equal(activity().getAttribute("role"), "status");
    }
    ctx.update({
      conversation: {
        ...engagedConversation([]),
        busy: true,
        readingGuides: ["measuring"],
        tools: [
          { id: "current", name: "navigate", status: "running", arguments: {} },
        ],
      },
    });
    await until(
      () => activity()?.textContent === "Opening the page…",
      "Browser action did not take precedence",
    );
    ctx.update({ conversation: { ...engagedConversation([]), busy: true } });
    await until(
      () => activity()?.textContent === "Roman is thinking…",
      "Completed reading stayed visible",
    );
    ctx.update({
      conversation: {
        ...engagedConversation([]),
        readingGuides: ["measuring"],
      },
    });
    await until(
      () => !activity(),
      "Idle work displayed an obsolete reading marker",
    );
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.startVoiceCalls, []);
  });
}

test("idle voice is quiet while delegated model and browser work show progress", async (t) => {
  const ctx = await setup(t, {
    state: {
      voice: { status: "active", muted: false, error: null },
      conversation: engagedConversation([]),
    },
  });
  const activity = () => ctx.container.querySelector(".roman-reply-activity");
  assert.equal(activity(), null);
  // The backend intentionally omits the empty voice-delegation context row.
  ctx.update({ conversation: { ...engagedConversation([]), busy: true } });
  await until(
    () => activity()?.textContent === "Roman is thinking…",
    "Voice delegation had no progress",
  );
  ctx.update({
    conversation: {
      ...engagedConversation([]),
      busy: true,
      tools: [
        {
          id: "voice-search",
          name: "search_products",
          status: "running",
          arguments: {},
        },
      ],
    },
  });
  await until(
    () => activity()?.textContent === "Finding suitable products…",
    "Voice tool did not replace generic progress",
  );
  ctx.update({ conversation: engagedConversation([]) });
  await until(
    () => !activity(),
    "Finished delegation made idle voice appear busy",
  );
  assert.deepEqual(ctx.startVoiceCalls, []);
});

test("restoration, request errors, voice transitions and ended sessions suppress stale activity", async (t) => {
  const working = {
    ...engagedConversation([]),
    busy: true,
    tools: [
      {
        id: "search",
        name: "search_products",
        status: "running",
        arguments: {},
      },
    ],
  };
  const ctx = await setup(t, { state: { conversation: working } });
  const activity = () => ctx.container.querySelector(".roman-reply-activity");
  for (const [name, changes] of [
    ["restoration", { restoring: true }],
    ["request error", { error: "Could not refresh. Please retry." }],
    [
      "voice startup",
      { voice: { status: "starting", muted: false, error: null } },
    ],
    [
      "voice shutdown",
      { voice: { status: "stopping", muted: true, error: null } },
    ],
    ["ended session", { conversation: { ...working, status: "ended" } }],
  ]) {
    ctx.update({
      conversation: working,
      restoring: false,
      error: null,
      voice: { status: "idle", muted: false, error: null },
    });
    await until(
      () => activity(),
      `Working baseline did not return before ${name}`,
    );
    ctx.update(changes);
    await until(() => !activity(), `${name} retained stale progress`);
  }
  const failed = {
    ...message("reply", "assistant", "", "failed"),
    error: "The reply was cancelled.",
  };
  ctx.update({
    conversation: engagedConversation([failed]),
    restoring: false,
    error: null,
    voice: { status: "idle", muted: false, error: null },
  });
  await until(
    () => ctx.container.textContent.includes("The reply was cancelled."),
    "Failed reply was not shown",
  );
  assert.equal(activity(), null);
});

test("an outstanding cart approval does not claim the action is already executing", async (t) => {
  const tool = {
    id: "remove",
    name: "remove_from_cart",
    status: "pending",
    arguments: { lineKey: "line-one" },
  };
  const ctx = await setup(t, {
    state: {
      conversation: { ...engagedConversation([]), busy: true, tools: [tool] },
      approval: {
        invocationId: tool.id,
        title: "Remove this blind?",
        details: ["Bedroom blind"],
      },
    },
  });
  assert.ok(ctx.container.querySelector(".roman-tool-approval"));
  assert.equal(ctx.container.querySelector(".roman-reply-activity"), null);
  assert.doesNotMatch(ctx.container.textContent, /Updating your cart/);
  ctx.update({
    approval: null,
    conversation: {
      ...engagedConversation([]),
      busy: true,
      tools: [{ ...tool, status: "running" }],
    },
  });
  await until(
    () =>
      ctx.container.querySelector(".roman-reply-activity")?.textContent ===
      "Updating your cart…",
    "Confirmed running action had no feedback",
  );
  ctx.update({ conversation: engagedConversation([]) });
  await until(
    () => !ctx.container.querySelector(".roman-reply-activity"),
    "Completed cart work retained activity",
  );
});

test("End removes progress before acknowledgement and does not restore it after cleanup", async (t) => {
  let finish;
  const accepted = new Promise((resolve) => {
    finish = resolve;
  });
  const ctx = await setup(t, {
    state: {
      conversation: {
        ...engagedConversation([
          message("reply", "assistant", "Still replying", "pending"),
        ]),
        busy: true,
      },
    },
    onEnd: () => accepted,
  });
  assert.equal(
    ctx.container.querySelector(".roman-reply-activity").textContent,
    "Roman is replying…",
  );
  ctx.container.querySelector(".roman-end-chat").click();
  await until(
    () => ctx.container.querySelector(".roman-dialog-primary"),
    "Confirmation missing",
  );
  assert.ok(
    ctx.container.querySelector(".roman-reply-activity"),
    "Merely opening confirmation must not interrupt the reply",
  );
  ctx.container.querySelector(".roman-dialog-primary").click();
  await until(
    () =>
      ctx.container.querySelector(".roman-end-chat")?.textContent === "Ending…",
    "End did not start",
  );
  assert.equal(ctx.container.querySelector(".roman-reply-activity"), null);
  assert.deepEqual(ctx.endCalls, ["end"]);
  finish();
  await until(
    () => ctx.container.querySelector(".roman-welcome"),
    "End acknowledgement did not reset chat",
  );
  assert.equal(ctx.container.querySelector(".roman-reply-activity"), null);
});
