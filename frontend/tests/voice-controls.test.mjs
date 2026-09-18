import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { VoiceControls } from './frontend/src/chat/VoiceControls';
      export function mount(container, session) {
        const root = createRoot(container);
        return {
          render(props) { flushSync(() => root.render(<VoiceControls session={session} {...props} />)); },
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
  globalName: "VoiceControlsTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

function setup(t) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    runScripts: "outside-only",
  });
  dom.window.eval(
    `${bundle.outputFiles[0].text}\nwindow.api = VoiceControlsTest;`,
  );
  const container = dom.window.document.querySelector("#root");
  const calls = [];
  const view = dom.window.api.mount(container, {
    setVoiceMuted: (muted) => calls.push(["mute", muted]),
    stopVoice: async () => {
      calls.push(["stop"]);
    },
  });
  t.after(() => {
    view.dispose();
    dom.window.close();
  });
  return { ...view, container, calls };
}

test("active voice presents decorative activity and labelled mute/end actions", (t) => {
  const { render, container, calls } = setup(t);
  render({ voice: { status: "active", muted: false, error: null } });
  const waveform = container.querySelector(".roman-voice-waveform");
  assert.equal(waveform.getAttribute("aria-hidden"), "true");
  assert.equal(waveform.children.length, 7);
  assert.equal(
    container.querySelector('[role="status"]').textContent,
    "Voice is on",
  );
  assert.ok(
    container
      .querySelector(".roman-voice-status")
      .classList.contains("sr-only"),
  );
  const mute = container.querySelector('[aria-label="Mute microphone"]');
  assert.equal(mute.getAttribute("aria-pressed"), "false");
  assert.equal(mute.title, "Mute microphone");
  mute.click();
  render({ voice: { status: "active", muted: true, error: null } });
  const unmute = container.querySelector('[aria-label="Unmute microphone"]');
  assert.equal(unmute.getAttribute("aria-pressed"), "true");
  assert.equal(!!container.querySelector(".roman-voice-waveform"), false);
  assert.equal(
    container.querySelector('[role="status"]').textContent,
    "Microphone muted",
  );
  assert.ok(container.querySelector(".roman-voice-bar > .roman-voice-notice"));
  unmute.click();
  container.querySelector('[aria-label="End voice"]').click();
  assert.deepEqual(calls, [["mute", true], ["mute", false], ["stop"]]);
  assert.equal(container.querySelector("textarea, input"), null);
});

test("connecting, stopping, restored and uncertain voice remain stoppable with inactive mute", (t) => {
  const { render, container, calls } = setup(t);
  for (const props of [
    { voice: { status: "starting", muted: false, error: null } },
    { voice: { status: "stopping", muted: true, error: null } },
    { voice: { status: "idle", muted: false, error: null }, waiting: true },
    {
      voice: {
        status: "error",
        muted: true,
        error: "Voice could not finish. End voice to retry.",
      },
    },
  ]) {
    render(props);
    const mute = container.querySelector('[aria-label$="microphone"]');
    const end = container.querySelector('[aria-label="End voice"]');
    assert.equal(mute.disabled, true);
    mute.click();
    assert.equal(!!container.querySelector(".roman-voice-waveform"), false);
    assert.ok(container.querySelector(".roman-voice-bar > .roman-voice-notice"));
    assert.equal(end.disabled, props.voice.status === "stopping");
    const before = calls.length;
    end.click();
    assert.equal(
      calls.length,
      before + (props.voice.status === "stopping" ? 0 : 1),
    );
    if (props.voice.error)
      assert.equal(
        container.querySelector('[role="alert"]').textContent,
        props.voice.error,
      );
  }
  assert.ok(calls.every(([name]) => name === "stop"));
});

test("collapsed dock keeps compact text actions and terminal errors remain visible without a fake call", (t) => {
  const { render, container } = setup(t);
  render({
    dock: true,
    voice: { status: "active", muted: false, error: null },
  });
  assert.ok(container.querySelector(".roman-voice-dock"));
  assert.equal(container.querySelector(".roman-voice-waveform"), null);
  assert.deepEqual(
    [...container.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
    ["Mute microphone", "Stop voice"],
  );
  render({
    voice: {
      status: "error",
      muted: false,
      error: "Microphone permission was denied.",
    },
  });
  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    "Microphone permission was denied.",
  );
  assert.equal(container.querySelector(".roman-voice-bar, button"), null);
  render({ voice: { status: "idle", muted: false, error: null } });
  assert.equal(container.textContent, "");
});
