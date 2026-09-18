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
      import { useSyncExternalStore } from 'react';
      import { ProductStage } from './frontend/src/chat/ProductStage';
      function Stage({navigation, session}) {
        const page = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
        return page.selectedPath ? <ProductStage key={page.selectedPath} navigation={navigation} session={session} selectedPath={page.selectedPath} selectedTitle="Selected blind" /> : null;
      }
      export function mount(container, navigation, session) {
        const root = createRoot(container);
        flushSync(() => root.render(<Stage navigation={navigation} session={session} />));
        return () => flushSync(() => root.unmount());
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "StageTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

function markup(title = "Calm linen blind") {
  return `<h1>${title}</h1>
    <div data-main-product-media-gallery><swiper-container id="product-main-swiper-initial"><img data-testid="pdp-product-image-main" src="/cdn/shop/files/room.jpg?width=1800&amp;v=123"></swiper-container></div>
    <dynamic-pricing><form data-dynamic-pricing-form>
      <dynamic-pricing-measurements><select data-measurement-select><option value="mm">mm</option></select>
        <div data-input-measurement-group="mm" data-active-input-measurement><input type="number" data-width-input value="500"><input type="number" data-drop-input value="600"></div>
      </dynamic-pricing-measurements>
      <fieldset data-feature="1"><input type="radio" name="Fitting##1" value="Recess##8" data-feature-option="1##8" checked><input type="radio" name="Fitting##1" value="Exact##7" data-feature-option="1##7"></fieldset>
      <fieldset data-feature="2" hidden><input type="radio" name="Hidden##2" value="Hidden choice##9" data-feature-option="2##9" checked></fieldset>
      <p data-dynamic-price>£45.00</p>
    </form></dynamic-pricing>`;
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function setup(t, { initialPath = "/products/linen", loadImage } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body class="template-product"><app-provider><main id="main">${markup()}</main></app-provider><roman-ai-assistant></roman-ai-assistant>`,
    {
      url: `https://shop.example${initialPath}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  const errors = [];
  window.console.error = (...error) => errors.push(error);
  window.fetch = () => assert.fail("The selected product stage must not fetch");
  for (const name of ["dynamic-pricing", "dynamic-pricing-measurements"])
    window.customElements.define(
      name,
      class extends window.HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML = "<slot></slot>";
        }
      },
    );
  let snapshot = {
    url: window.location.href,
    pending: false,
    error: null,
    selectedPath: "/products/linen",
  };
  const listeners = new Set();
  const navigation = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const imageReads = [];
  const session = {
    loadProductImage: (url, signal, maxWidth) => {
      imageReads.push({ url, signal, maxWidth });
      return loadImage?.(url, signal, maxWidth) ?? Promise.resolve(undefined);
    },
  };
  window.eval(`${bundle.outputFiles[0].text};window.StageTest=StageTest;`);
  const container = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const unmount = window.StageTest.mount(container, navigation, session);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      unmount();
    }
  };
  t.after(() => {
    dispose();
    window.close();
    assert.deepEqual(errors, []);
  });
  if (initialPath === "/products/linen")
    await until(
      () => container.querySelector(".roman-product-stage-price"),
      "Stage should read the PDP",
    );
  return {
    window,
    container,
    listeners,
    imageReads,
    dispose,
    update(changes) {
      snapshot = { ...snapshot, ...changes };
      listeners.forEach((fn) => fn());
    },
    replace(path, title) {
      window.history.pushState({}, "", path);
      window.document.querySelector("main").innerHTML = markup(title);
      snapshot = {
        url: window.location.href,
        pending: false,
        error: null,
        selectedPath: path,
      };
      listeners.forEach((fn) => fn());
    },
  };
}

test("stage uses the canonical PDP gallery, live quote and supported current selections", async (t) => {
  const { container } = await setup(t);
  assert.equal(container.querySelector("h2").textContent, "Calm linen blind");
  assert.equal(
    container.querySelector("img").src,
    "https://shop.example/cdn/shop/files/room.jpg?width=1200&v=123",
  );
  assert.match(
    container.querySelector(".roman-product-stage-price").textContent,
    /£45\.00/,
  );
  assert.match(
    container.querySelector(".roman-product-stage-measurements").textContent,
    /500 × 600 mm/,
  );
  assert.match(container.querySelector("dl").textContent, /FittingRecess/);
  assert.doesNotMatch(container.textContent, /Hidden choice/);
});

test("native changes update the stage and stale prices disappear during asynchronous pricing", async (t) => {
  const { window, container } = await setup(t);
  const form = window.document.querySelector("form");
  form.classList.add("loading");
  await until(
    () => !container.querySelector(".roman-product-stage-price"),
    "Stale quote is removed",
  );
  form.classList.remove("loading");
  form.querySelector("[data-width-input]").value = "750";
  form
    .querySelector("[data-width-input]")
    .dispatchEvent(new window.Event("input", { bubbles: true }));
  form.querySelector('[value="Exact##7"]').checked = true;
  form
    .querySelector('[value="Exact##7"]')
    .dispatchEvent(new window.Event("change", { bubbles: true }));
  form.querySelector("[data-dynamic-price]").textContent = "£70.00";
  await until(
    () => container.textContent.includes("£70.00"),
    "Live quote updates",
  );
  assert.match(container.textContent, /750 × 600 mm/);
  assert.match(container.querySelector("dl").textContent, /FittingExact/);
});

test("navigation keeps a marked prior selection with no quote, restores cancellation and replaces safely", async (t) => {
  const ctx = await setup(t);
  ctx.update({ pending: true });
  await until(
    () => ctx.container.textContent.includes("Previously selected"),
    "Previous selection is labelled",
  );
  assert.equal(ctx.container.querySelector(".roman-product-stage-price"), null);
  assert.match(ctx.container.textContent, /Calm linen blind/);
  ctx.update({ pending: false });
  await until(
    () => ctx.container.textContent.includes("£45.00"),
    "Cancellation restores current state",
  );
  ctx.update({ pending: true });
  ctx.replace("/products/another", "Soft sage blind");
  await until(
    () => ctx.container.textContent.includes("Soft sage blind"),
    "Next product replaces previous",
  );
  assert.doesNotMatch(ctx.container.textContent, /Calm linen blind/);
  ctx.window.history.pushState({}, "", "/cart");
  ctx.update({ url: ctx.window.location.href });
  await until(
    () => !ctx.container.querySelector(".roman-product-stage-price"),
    "Native cart must not retain a stale quote",
  );
  assert.match(ctx.container.textContent, /Soft sage blind/);
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-configuration"),
    null,
  );
});

test("unsupported controls and unavailable images degrade without breaking the product display", async (t) => {
  const ctx = await setup(t);
  ctx.container
    .querySelector("img")
    .dispatchEvent(new ctx.window.Event("error"));
  await until(
    () => !ctx.container.querySelector("img"),
    "Failed image is not retried indefinitely",
  );
  ctx.window.document.querySelector("dynamic-pricing").remove();
  await until(
    () => !ctx.container.querySelector(".roman-product-stage-price"),
    "Unsupported form has no quote",
  );
  assert.match(ctx.container.textContent, /Calm linen blind/);
  assert.equal(ctx.container.querySelector("dl"), null);
});

test("stage cleans up navigation subscriptions and queued theme observations on unmount", async (t) => {
  const ctx = await setup(t);
  ctx.window.document.querySelector("h1").textContent = "Pending change";
  ctx.dispose();
  assert.equal(ctx.listeners.size, 0);
  ctx.update({ pending: true });
  ctx.window.document.querySelector("main").innerHTML = markup("Removed stage");
  await delay(35);
  assert.equal(ctx.container.textContent, "");
});

test("selected imagery survives the empty DOM between a PDP and another background page", async (t) => {
  const ctx = await setup(t);
  const image = ctx.container.querySelector("img").src;
  ctx.window.document.querySelector("main").replaceChildren();
  await delay(40);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.equal(ctx.container.querySelector(".roman-product-stage-price"), null);
  ctx.window.history.pushState({}, "", "/products/unselected");
  ctx.window.document.querySelector("main").innerHTML = markup(
    "Not the selected blind",
  ).replace("room.jpg", "other.jpg");
  ctx.update({ url: ctx.window.location.href });
  await delay(40);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.doesNotMatch(ctx.container.textContent, /Not the selected blind/);
  assert.equal(ctx.container.querySelector(".roman-product-stage-price"), null);
});

test("a restored selection loads its own large image once from another page and retains it through navigation", async (t) => {
  const image = "https://shop.example/cdn/shop/files/restored.jpg?width=1200";
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadImage: async () => image,
  });
  await until(
    () => ctx.container.querySelector("img")?.src === image,
    "Restored image is displayed",
  );
  assert.equal(ctx.imageReads.length, 1);
  assert.equal(ctx.imageReads[0].url, "/products/linen");
  assert.equal(ctx.imageReads[0].maxWidth, 1200);
  assert.equal(ctx.container.querySelector(".roman-product-stage-price"), null);
  ctx.update({ pending: true });
  await delay(10);
  ctx.window.history.pushState({}, "", "/");
  ctx.update({ url: ctx.window.location.href, pending: false });
  await delay(10);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.equal(ctx.imageReads.length, 1);
});

test("replacement and ending release image work and cannot display an obsolete result", async (t) => {
  const pending = [];
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadImage: () => new Promise((resolve) => pending.push(resolve)),
  });
  await until(() => pending.length === 1, "Original image lookup started");
  ctx.update({ selectedPath: "/products/replacement" });
  await until(() => pending.length === 2, "Replacement image lookup started");
  assert.equal(ctx.imageReads[0].signal.aborted, true);
  pending[0]("https://shop.example/cdn/shop/files/obsolete.jpg");
  await delay(10);
  assert.equal(ctx.container.querySelector("img"), null);
  pending[1]("https://shop.example/cdn/shop/files/replacement.jpg");
  await until(
    () => ctx.container.querySelector("img")?.src.endsWith("replacement.jpg"),
    "Only the current image appears",
  );
  ctx.update({ selectedPath: "/products/third" });
  await until(() => pending.length === 3, "Third lookup started");
  assert.equal(ctx.container.querySelector("img"), null);
  ctx.update({ selectedPath: null });
  await until(
    () => !ctx.container.querySelector("aside"),
    "End chat removes selection",
  );
  assert.equal(ctx.imageReads[2].signal.aborted, true);
  pending[2]("https://shop.example/cdn/shop/files/late.jpg");
  await delay(10);
  assert.equal(ctx.container.textContent, "");
});

test("an unavailable recovery image settles without a request loop and later live imagery can restore it", async (t) => {
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadImage: async () => undefined,
  });
  await until(() => ctx.imageReads.length === 1, "Recovery attempted once");
  await delay(10);
  ctx.update({ error: "Unrelated page error" });
  await delay(10);
  assert.equal(ctx.imageReads.length, 1);
  assert.equal(ctx.container.querySelector("img"), null);
  ctx.window.history.pushState({}, "", "/products/linen");
  ctx.update({ url: ctx.window.location.href });
  await until(
    () => ctx.container.querySelector("img"),
    "Live PDP restores imagery",
  );
  assert.match(ctx.container.querySelector("img").src, /room\.jpg/);
});
