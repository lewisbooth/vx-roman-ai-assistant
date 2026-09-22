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
    stopVoice: async () => calls.push(["stop"]),
  });
  t.after(() => {
    view.dispose();
    dom.window.close();
  });
  return { ...view, container, calls };
}

test("active voice fills the bar with decorative activity and only End voice", (t) => {
  const { render, container, calls } = setup(t);
  render({ voice: { status: "active", muted: false, error: null } });
  const waveform = container.querySelector(".roman-voice-waveform");
  assert.equal(waveform.getAttribute("aria-hidden"), "true");
  assert.equal(waveform.children.length, 39);
  assert.equal(container.querySelector('[role="status"]'), null);
  assert.equal(container.querySelectorAll("button").length, 1);
  const end = container.querySelector('[aria-label="End voice"]');
  assert.equal(end.type, "button");
  end.click();
  assert.deepEqual(calls, [["stop"]]);
  assert.equal(container.querySelector("textarea, input"), null);
  render({ voice: { status: "active", muted: true, error: null } });
  assert.ok(container.querySelector(".roman-voice-waveform[data-muted]"));
  assert.equal(container.querySelectorAll("button").length, 1);
});

test("connecting, stopping, restored and uncertain voice expose only safe cancellation", (t) => {
  const { render, container, calls } = setup(t);
  for (const props of [
    { voice: { status: "starting", muted: false, error: null } },
    { voice: { status: "stopping", muted: true, error: null } },
    { voice: { status: "idle", muted: false, error: null }, waiting: true },
    { voice: { status: "error", muted: true, error: "End voice to retry." } },
  ]) {
    render(props);
    const end = container.querySelector('[aria-label="End voice"]');
    assert.equal(container.querySelectorAll("button").length, 1);
    assert.equal(container.querySelector(".roman-voice-waveform"), null);
    assert.ok(
      container.querySelector(
        ".roman-voice-bar > .roman-voice-notice[role='status']",
      ),
    );
    assert.equal(end.disabled, props.voice.status === "stopping");
    const before = calls.length;
    end.click();
    assert.equal(
      calls.length,
      before + (props.voice.status === "stopping" ? 0 : 1),
    );
  }
  assert.ok(calls.every(([name]) => name === "stop"));
});

test("stopped or denied voice does not create an empty second bar or inline permission prompt", (t) => {
  const { render, container } = setup(t);
  for (const voice of [
    {
      status: "error",
      muted: false,
      error: "Permission was denied.",
      errorCode: "microphone_denied",
    },
    { status: "idle", muted: false, error: null },
  ]) {
    render({ voice });
    assert.equal(container.textContent, "");
    assert.equal(container.querySelector("button, .roman-voice-bar"), null);
  }
});
