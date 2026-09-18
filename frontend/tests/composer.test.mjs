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
      import { Composer } from './frontend/src/chat/Composer';
      import { VoiceControls } from './frontend/src/chat/VoiceControls';
      export function mount(container, session) {
        const root = createRoot(container);
        return {
          render({voice, queued, ...props}) {
            flushSync(() => root.render(<Composer {...props}
              voiceControls={voice && <VoiceControls session={session} voice={voice} />}
              queuedMessages={queued && <section aria-label="Queued messages">{queued}</section>}
            />));
          },
          dispose() { root.unmount(); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ComposerTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("Composer did not settle");
}

function setup(t, initial = {}) {
  const dom = new JSDOM(
    "<!doctype html><div id='root'></div><button id='other'>Another control</button>",
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  window.eval(`${bundle.outputFiles[0].text}\nwindow.api = ComposerTest;`);
  const container = window.document.querySelector("#root");
  const calls = [];
  const voiceCalls = [];
  const view = window.api.mount(container, {
    setVoiceMuted: (muted) => voiceCalls.push(["mute", muted]),
    stopVoice: async () => voiceCalls.push(["stop"]),
  });
  let props = {
    busy: false,
    error: null,
    onClearError() {},
    onSend: async (text) => {
      calls.push(text);
    },
    ...initial,
  };
  const render = (changes) => {
    props = { ...props, ...changes };
    view.render(props);
  };
  render({});
  t.after(() => {
    view.dispose();
    window.close();
  });
  return {
    window,
    container,
    calls,
    voiceCalls,
    render,
    input: () => container.querySelector("textarea"),
    send: () => container.querySelector('[type="submit"]'),
    async type(value) {
      const input = container.querySelector("textarea");
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await delay(0);
    },
  };
}

test("working Roman keeps text editable and accepts a queued message with focus intact", async (t) => {
  const ctx = setup(t, { busy: true, queued: "A previous queued message" });
  await ctx.type("  Can we also see green?  ");
  assert.equal(ctx.input().readOnly, false);
  assert.equal(ctx.input().disabled, false);
  assert.equal(ctx.send().disabled, false);
  assert.equal(ctx.send().getAttribute("aria-label"), "Queue message");
  const queue = ctx.container.querySelector('[aria-label="Queued messages"]');
  assert.equal(queue.closest("form"), null);
  assert.ok(
    queue.compareDocumentPosition(ctx.input()) &
      ctx.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  ctx.send().click();
  await until(() => ctx.input().value === "");
  assert.deepEqual(ctx.calls, ["Can we also see green?"]);
  assert.equal(ctx.input().value, "");
  assert.equal(ctx.window.document.activeElement, ctx.input());
});

test("an idle voice slot does not hide Start voice and queued work blocks only microphone startup", async (t) => {
  let starts = 0;
  const ctx = setup(t, {
    voice: { status: "idle", muted: false, error: null },
    onStartVoice: async () => {
      starts++;
    },
  });
  const start = () => ctx.container.querySelector('[aria-label="Start voice"]');
  assert.ok(start());
  assert.equal(ctx.container.querySelector(".roman-voice-composer"), null);
  start().click();
  assert.equal(starts, 1);
  ctx.render({ busy: true });
  await ctx.type("Queue this while Roman works");
  assert.equal(start().disabled, true);
  assert.equal(ctx.send().disabled, false);
  assert.equal(ctx.input().readOnly, false);
  start().click();
  assert.equal(starts, 1);
});

test("an enqueue acknowledgement cannot erase newer typing or steal focus", async (t) => {
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const calls = [];
  const ctx = setup(t, {
    onSend: async (text) => {
      calls.push(text);
      await accepted;
    },
  });
  await ctx.type("First message");
  ctx.send().click();
  ctx.send().click();
  await delay(0);
  assert.equal(ctx.input().readOnly, false);
  assert.equal(ctx.input().disabled, false);
  await ctx.type("My next thought");
  ctx.window.document.querySelector("#other").focus();
  accept();
  await until(() => !ctx.send().disabled);
  assert.deepEqual(calls, ["First message"]);
  assert.equal(ctx.input().value, "My next thought");
  assert.equal(ctx.window.document.activeElement.id, "other");
  assert.equal(ctx.send().disabled, false);
});

test("rejected enqueue retains the editable draft for a deliberate retry", async (t) => {
  let attempts = 0;
  const ctx = setup(t, {
    busy: true,
    onSend: async () => {
      if (++attempts === 1)
        throw new ctx.window.Error("The message queue is full.");
    },
  });
  await ctx.type("Keep this message");
  ctx.send().click();
  await until(() => ctx.container.querySelector('[role="alert"]'));
  assert.equal(ctx.input().value, "Keep this message");
  assert.equal(ctx.input().readOnly, false);
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /queue is full/,
  );
  ctx.send().click();
  await until(() => ctx.input().value === "");
  assert.equal(attempts, 2);
  assert.equal(ctx.input().value, "");
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
});

test("lifecycle locks alone disable entry and Enter respects composition and multiline input", async (t) => {
  const ctx = setup(t);
  await ctx.type("A message");
  ctx.render({ disabled: true, busy: true });
  assert.equal(ctx.input().disabled, true);
  ctx.input().dispatchEvent(
    new ctx.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.deepEqual(ctx.calls, []);
  ctx.render({ disabled: false });
  for (const extra of [{ shiftKey: true }, { isComposing: true }]) {
    const event = new ctx.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    ctx.input().dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(ctx.calls, []);
  ctx.input().dispatchEvent(
    new ctx.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await delay(0);
  assert.deepEqual(ctx.calls, ["A message"]);
});

test("one combined bar retains text through voice states and voice buttons never submit text", async (t) => {
  const ctx = setup(t);
  await ctx.type("A voice follow-up I am typing");
  const input = ctx.input();
  for (const status of ["starting", "active", "stopping"]) {
    ctx.render({ voice: { status, muted: false, error: null }, busy: true });
    assert.equal(ctx.input(), input);
    assert.equal(input.value, "A voice follow-up I am typing");
    assert.equal(input.disabled, false);
    assert.equal(input.readOnly, false);
    assert.equal(input.closest("form").hidden, false);
    const embedded = ctx.container.querySelector(".roman-voice-composer");
    assert.equal(embedded.closest("form"), input.closest("form"));
    assert.equal(ctx.container.querySelectorAll("form").length, 1);
    if (status === "active") {
      assert.equal(
        embedded.querySelectorAll(".roman-voice-waveform span").length,
        7,
      );
      embedded.querySelector('[aria-label="Mute microphone"]').click();
      embedded.querySelector('[aria-label="End voice"]').click();
    } else assert.equal(embedded.querySelector(".roman-voice-waveform"), null);
  }
  assert.deepEqual(ctx.voiceCalls, [["mute", true], ["stop"]]);
  assert.deepEqual(ctx.calls, []);
  ctx.render({ voice: { status: "active", muted: false, error: null } });
  ctx.send().click();
  await delay(0);
  assert.deepEqual(ctx.calls, ["A voice follow-up I am typing"]);
  assert.ok(ctx.container.querySelector('[aria-label="End voice"]'));
});
