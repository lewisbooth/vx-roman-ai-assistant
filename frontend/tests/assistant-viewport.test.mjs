import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/assistant-viewport.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "AssistantViewport",
  platform: "browser",
});

function setup(t, { visual = true } = {}) {
  const dom = new JSDOM("<roman-ai-assistant></roman-ai-assistant>", {
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const host = window.document.querySelector("roman-ai-assistant");
  const viewport = Object.assign(new window.EventTarget(), {
    height: 844,
    offsetTop: 0,
    scale: 1,
  });
  if (visual)
    Object.defineProperty(window, "visualViewport", { value: viewport });
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.eval(`${bundle.outputFiles[0].text}\nwindow.AssistantViewport = AssistantViewport;`);
  const owner = window.AssistantViewport.createAssistantViewport(host);
  t.after(() => owner.dispose());
  return {
    window,
    viewport,
    owner,
    frames,
    value: (name) => host.style.getPropertyValue(`--roman-visible-${name}`),
    event(target, name) {
      target.dispatchEvent(new window.Event(name));
    },
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("keyboard resize and pan follow the visual viewport without shrinking the opaque shell", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  assert.equal(ctx.value("height"), "844px");
  assert.equal(ctx.value("top"), "0px");

  // Safari keeps the layout viewport while shrinking/panning its visible area.
  ctx.viewport.height = 390;
  ctx.viewport.offsetTop = 72;
  ctx.event(ctx.viewport, "resize");
  ctx.event(ctx.viewport, "scroll");
  assert.equal(
    ctx.frames.size,
    1,
    "A viewport transition batches layout writes",
  );
  ctx.flush();
  assert.equal(ctx.value("height"), "390px");
  assert.equal(ctx.value("top"), "72px");

  ctx.viewport.offsetTop = 100;
  ctx.event(ctx.viewport, "scroll");
  ctx.flush();
  assert.equal(
    ctx.value("top"),
    "100px",
    "Panning alone must move the contents",
  );

  ctx.viewport.height = 844;
  ctx.viewport.offsetTop = 0;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("height"), "844px");
  assert.equal(ctx.value("top"), "0px");
});

test("closing cancels pending viewport work and reopening reads current dimensions", (t) => {
  const ctx = setup(t);
  ctx.event(ctx.viewport, "resize");
  assert.equal(ctx.frames.size, 0);
  ctx.owner.setOpen(true);
  ctx.viewport.height = 370;
  ctx.event(ctx.viewport, "resize");
  assert.equal(ctx.frames.size, 1);
  ctx.owner.setOpen(false);
  assert.equal(ctx.frames.size, 0);
  assert.equal(ctx.value("height"), "");
  assert.equal(ctx.value("top"), "");
  ctx.event(ctx.viewport, "resize");
  ctx.event(ctx.viewport, "scroll");
  ctx.event(ctx.window, "resize");
  assert.equal(ctx.frames.size, 0);

  ctx.owner.setOpen(true);
  assert.equal(ctx.value("height"), "370px");
  ctx.event(ctx.viewport, "resize");
  ctx.owner.dispose();
  ctx.event(ctx.viewport, "scroll");
  ctx.event(ctx.window, "resize");
  assert.equal(ctx.frames.size, 0);
  assert.equal(ctx.value("height"), "");
});

test("pinch zoom keeps native magnification instead of reflowing into the zoomed viewport", (t) => {
  const ctx = setup(t);
  ctx.owner.setOpen(true);
  ctx.viewport.scale = 2;
  ctx.viewport.height = 422;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("height"), "");
  assert.equal(ctx.value("top"), "");
  ctx.viewport.scale = 1;
  ctx.viewport.height = 844;
  ctx.event(ctx.viewport, "resize");
  ctx.flush();
  assert.equal(ctx.value("height"), "844px");
});

test("browsers without VisualViewport still track window resizing", (t) => {
  const ctx = setup(t, { visual: false });
  ctx.owner.setOpen(true);
  assert.equal(ctx.value("height"), `${ctx.window.innerHeight}px`);
  ctx.window.innerHeight = 500;
  ctx.event(ctx.window, "resize");
  ctx.flush();
  assert.equal(ctx.value("height"), "500px");
});
