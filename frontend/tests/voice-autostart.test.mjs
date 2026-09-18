import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export { createVoiceAutostart } from "./frontend/src/session/voice-autostart";
    export { readVoiceAutostartPreference, setVoiceAutostartPreference } from "./frontend/src/session/voice-preference";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
function setup(initial = {}, start, storage = new Map()) {
  const module = { exports: {} };
  const window = {
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  new Function("window", "module", "exports", bundle.outputFiles[0].text)(
    window,
    module,
    module.exports,
  );
  const {
    createVoiceAutostart,
    setVoiceAutostartPreference,
    readVoiceAutostartPreference,
  } = module.exports;
  let state = {
    conversation: null,
    pending: false,
    restoring: false,
    error: null,
    approval: null,
    voice: { status: "idle", muted: false, error: null },
    ...initial,
  };
  let starts = 0;
  const listeners = new Set();
  const update = (change) => {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  };
  const controller = createVoiceAutostart({
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async startVoice() {
      starts++;
      update({ voice: { status: "starting", muted: false, error: null } });
      await start?.(update);
    },
  });
  return {
    controller,
    update,
    starts: () => starts,
    listeners,
    window,
    storage,
    setVoiceAutostartPreference,
    readVoiceAutostartPreference,
  };
}

test("an explicit text preference survives a native page reload until a manual voice start clears it", () => {
  const first = setup();
  first.setVoiceAutostartPreference(false);
  first.controller.setOpen(true);
  assert.equal(first.starts(), 0);
  first.controller.dispose();
  const next = setup({}, undefined, first.storage);
  next.controller.setOpen(true);
  assert.equal(next.starts(), 0);
  next.setVoiceAutostartPreference(true);
  assert.equal(next.readVoiceAutostartPreference(), true);
  next.controller.setOpen(true);
  assert.equal(next.starts(), 1);
  next.controller.dispose();
});

test("unreadable saved voice preference requires a deliberate start and local opt-out survives denied writes", () => {
  const ctx = setup();
  ctx.window.sessionStorage.setItem = () => {
    throw new Error("Storage blocked");
  };
  ctx.setVoiceAutostartPreference(false);
  assert.equal(ctx.readVoiceAutostartPreference(), false);
  ctx.setVoiceAutostartPreference(true);
  ctx.window.sessionStorage.getItem = () => {
    throw new Error("Storage blocked");
  };
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 0);
  ctx.controller.dispose();
});

test("quiet runtime restoration never activates a microphone until Roman opens", () => {
  const ctx = setup({ restoring: true });
  ctx.update({ restoring: false });
  ctx.controller.setOpen(false);
  assert.equal(ctx.starts(), 0);
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 1);
  ctx.controller.dispose();
});

test("opening waits for restoration and pending text/tool work to settle", () => {
  const ctx = setup({ restoring: true });
  ctx.controller.setOpen(true);
  ctx.update({ restoring: false, pending: true });
  ctx.update({ pending: false, conversation: { busy: true, tools: [] } });
  ctx.update({ conversation: { busy: false, tools: [{}] } });
  ctx.update({ conversation: { busy: false, tools: [] }, approval: {} });
  assert.equal(ctx.starts(), 0);
  ctx.update({ approval: null });
  assert.equal(ctx.starts(), 1);
  ctx.controller.dispose();
});

test("closing during restoration prevents a delayed microphone start", () => {
  const ctx = setup({ restoring: true });
  ctx.controller.setOpen(true);
  ctx.controller.setOpen(false);
  ctx.update({ restoring: false });
  assert.equal(ctx.starts(), 0);
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 1);
  ctx.controller.dispose();
});

test("manual stop and End chat remain text mode across close and reopen", () => {
  const ctx = setup();
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 1);
  ctx.update({ voice: { status: "active" } });
  ctx.update({ voice: { status: "idle" } });
  ctx.controller.setOpen(false);
  ctx.controller.setOpen(true);
  ctx.update({ conversation: null });
  assert.equal(ctx.starts(), 1);
  ctx.controller.dispose();
});

test("permission failure is not retried and leaves the session's error and text state intact", async () => {
  const ctx = setup({}, async (update) => {
    update({
      voice: { status: "error", muted: false, error: "Microphone denied" },
    });
    throw new Error("Microphone denied");
  });
  ctx.controller.setOpen(true);
  await Promise.resolve();
  await Promise.resolve();
  ctx.update({ voice: { status: "idle" } });
  ctx.controller.setOpen(false);
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 1);
  ctx.controller.dispose();
});

test("existing manual or remote voice prevents a second automatic connection", () => {
  for (const initial of [
    { voice: { status: "starting" } },
    { voice: { status: "active" } },
    { voice: { status: "stopping" } },
    { voice: { status: "error" } },
    { conversation: { voice: { status: "active" } } },
  ]) {
    const ctx = setup(initial);
    ctx.controller.setOpen(true);
    ctx.update({ voice: { status: "idle" }, conversation: null });
    assert.equal(ctx.starts(), 0);
    ctx.controller.dispose();
  }
});

test("disposal removes subscription and prevents a delayed attempt", () => {
  const ctx = setup({ restoring: true });
  ctx.controller.setOpen(true);
  ctx.controller.dispose();
  assert.equal(ctx.listeners.size, 0);
  ctx.update({ restoring: false });
  ctx.controller.setOpen(true);
  assert.equal(ctx.starts(), 0);
});
