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
      import { ProductGallery } from './frontend/src/chat/ProductGallery';
      export function mount(container) {
        const root = createRoot(container);
        return {
          flush: flushSync,
          render(items, extra = {}) { flushSync(() => root.render(<ProductGallery key={extra.productPath || 'blind'} title="Linen blind" items={items} {...extra} />)); },
          dispose() { flushSync(() => root.unmount()); }
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "GalleryTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const image = (id, kind = "product") => ({
  id,
  kind,
  alt: `${id} view`,
  src: `https://cdn.shopify.com/s/files/${id}.jpg?width=1200`,
  thumbnailSrc: `https://cdn.shopify.com/s/files/${id}.jpg?width=90`,
  zoomSrc: `https://cdn.shopify.com/s/files/${id}.jpg?width=1600`,
  width: 1200,
  height: 1500,
});
const items = [image("room"), image("detail"), image("back")];

function setup(t) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://shop.example",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const failures = [],
    dialogs = [],
    captured = new Set();
  window.console.error = (...args) => failures.push(args);
  window.HTMLElement.prototype.setPointerCapture = (id) => captured.add(id);
  window.HTMLElement.prototype.hasPointerCapture = (id) => captured.has(id);
  window.HTMLElement.prototype.releasePointerCapture = (id) =>
    captured.delete(id);
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    dialogs.push(this);
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  window.eval(`${bundle.outputFiles[0].text};window.GalleryTest=GalleryTest;`);
  const view = window.GalleryTest.mount(shadow);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      view.dispose();
    }
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  const click = (selector, detail = 0) =>
    view.flush(() =>
      shadow
        .querySelector(selector)
        .dispatchEvent(
          new window.MouseEvent("click", {
            bubbles: true,
            composed: true,
            detail,
          }),
        ),
    );
  const key = (selector, key) =>
    view.flush(() =>
      shadow
        .querySelector(selector)
        .dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
  const pointer = (type, x, y = 20, pointerType = "mouse") =>
    view.flush(() => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: pointerType },
      });
      shadow.querySelector(".roman-gallery-open").dispatchEvent(event);
    });
  return {
    window,
    shadow,
    view,
    dialogs,
    captured,
    click,
    key,
    pointer,
    dispose,
    current: () => shadow.querySelector(".roman-gallery-open img")?.src,
  };
}

test("gallery mounts only one full-size image and never high-resolution images before zoom", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  assert.equal(ctx.current(), items[0].src);
  assert.equal(ctx.shadow.querySelectorAll('img[src*="width=1200"]').length, 1);
  assert.equal(ctx.shadow.querySelectorAll('img[src*="width=1600"]').length, 0);
  assert.equal(ctx.shadow.querySelectorAll('img[loading="lazy"]').length, 3);
  ctx.click('[aria-label="Next product image"]');
  assert.equal(ctx.current(), items[1].src);
  ctx.click('[aria-label="Show image 3: back view"]');
  assert.equal(ctx.current(), items[2].src);
  ctx.click('[aria-label="Next product image"]');
  assert.equal(ctx.current(), items[0].src);
  ctx.key(".roman-gallery-open", "End");
  assert.equal(ctx.current(), items[2].src);
  ctx.key(".roman-gallery-open", "Home");
  ctx.key(".roman-gallery-open", "ArrowLeft");
  assert.equal(ctx.current(), items[2].src);
});

test("horizontal mouse drag and touch swipe change slides without opening zoom; vertical gestures stay native", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.pointer("pointerdown", 140);
  ctx.pointer("pointermove", 60);
  ctx.pointer("pointerup", 60);
  ctx.click(".roman-gallery-open", 1);
  assert.equal(ctx.current(), items[1].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  assert.equal(ctx.captured.size, 0);
  ctx.pointer("pointerdown", 60, 20, "touch");
  ctx.pointer("pointermove", 140, 22, "touch");
  ctx.pointer("pointerup", 140, 22, "touch");
  ctx.click(".roman-gallery-open", 1);
  assert.equal(ctx.current(), items[0].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 95, 90);
  ctx.pointer("pointerup", 90, 110);
  assert.equal(ctx.current(), items[0].src);
  ctx.pointer("pointerdown", 100);
  ctx.pointer("pointermove", 40);
  ctx.pointer("pointercancel", 40);
  assert.equal(ctx.captured.size, 0);
  assert.equal(ctx.current(), items[0].src);
  ctx.click(".roman-gallery-open");
  assert.ok(ctx.shadow.querySelector("dialog[open]"));
});

test("zoom lazily mounts high-resolution images, supports navigation, and closes before removal", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.click(".roman-gallery-open");
  const dialog = ctx.dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(
    ctx.shadow.activeElement.getAttribute("aria-label"),
    "Close enlarged image",
  );
  assert.equal(dialog.querySelector("img").src, items[0].zoomSrc);
  ctx.key("dialog", "ArrowRight");
  assert.equal(dialog.querySelector("img").src, items[1].zoomSrc);
  assert.equal(ctx.current(), items[1].src);
  ctx.view.flush(() =>
    dialog.querySelector("img").dispatchEvent(new ctx.window.Event("error")),
  );
  assert.equal(
    dialog.querySelector("img").src,
    items[1].src,
    "Failed zoom falls back to regular image once",
  );
  ctx.view.flush(() =>
    dialog.dispatchEvent(new ctx.window.Event("cancel", { cancelable: true })),
  );
  assert.equal(dialog.open, false);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.click(".roman-gallery-open");
  ctx.dispose();
  assert.equal(ctx.dialogs[1].open, false);
});

test("updated feature media takes focus once while unchanged snapshots preserve customer selection", (t) => {
  const ctx = setup(t);
  ctx.view.render(items);
  ctx.click('[aria-label="Next product image"]');
  ctx.view.render(structuredClone(items));
  assert.equal(ctx.current(), items[1].src);
  const upgraded = [...items, image("motor", "feature")];
  ctx.view.render(upgraded);
  assert.equal(ctx.current(), upgraded[3].src);
  ctx.click('[aria-label="Show image 1: room view"]');
  ctx.view.render(structuredClone(upgraded));
  assert.equal(ctx.current(), items[0].src);
  const changed = [...items, image("remote", "feature")];
  ctx.view.render(changed);
  assert.equal(ctx.current(), changed[3].src);
  ctx.view.render(items);
  assert.equal(
    ctx.current(),
    items[0].src,
    "Removed feature cannot leave a stale image",
  );
});

test("empty, hidden and changed selections never retain stale image resources or zoom dialogs", (t) => {
  const ctx = setup(t);
  ctx.view.render([]);
  assert.equal(ctx.shadow.querySelector("img"), null);
  assert.equal(ctx.shadow.querySelector("button"), null);
  ctx.view.render([items[0]]);
  assert.equal(ctx.shadow.querySelector(".roman-gallery-controls"), null);
  ctx.view.flush(() =>
    ctx.shadow
      .querySelector("img")
      .dispatchEvent(new ctx.window.Event("error")),
  );
  assert.match(ctx.shadow.textContent, /Image unavailable/);
  ctx.view.render(items);
  ctx.click('[aria-label="Next product image"]');
  ctx.click(".roman-gallery-open");
  ctx.view.render(items, { hidden: true });
  assert.equal(ctx.shadow.querySelector("img"), null);
  assert.equal(ctx.dialogs[0].open, false);
  ctx.view.render(items);
  assert.equal(ctx.current(), items[1].src);
  assert.equal(ctx.shadow.querySelector("dialog"), null);
  ctx.view.render([image("new")], { productPath: "/products/new" });
  assert.equal(ctx.current(), image("new").src);
  assert.doesNotMatch(ctx.shadow.innerHTML, /detail.jpg/);
});
