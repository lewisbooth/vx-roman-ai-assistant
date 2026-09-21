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
        return page.selectedPath ? <ProductStage key={page.selectedPath} navigation={navigation} session={session} selectedPath={page.selectedPath} selectedTitle="Selected blind" hidden={page.hidden} /> : null;
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

function gallery(src, productPath = "/products/linen") {
  return {
    productPath,
    items: [
      {
        id: src,
        src,
        thumbnailSrc: src,
        zoomSrc: src,
        alt: "Room view",
        kind: "product",
      },
    ],
  };
}

async function setup(
  t,
  {
    initialPath = "/products/linen",
    loadGallery,
    hidden = false,
    mobile = false,
  } = {},
) {
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
  window.fetch = () =>
    assert.fail("The selected product stage must not fetch");
  const mediaQueries = new Map();
  window.matchMedia = (query) => {
    if (!mediaQueries.has(query)) {
      const listeners = new Set();
      mediaQueries.set(query, {
        media: query,
        matches: /max-width:\s*1023px/.test(query) && mobile,
        listeners,
        addEventListener: (_event, fn) => listeners.add(fn),
        removeEventListener: (_event, fn) => listeners.delete(fn),
      });
    }
    return mediaQueries.get(query);
  };
  const dialogs = [],
    closedDialogs = [];
  const dialogFocus = new WeakMap();
  window.HTMLDialogElement.prototype.showModal = function () {
    // Model the native dialog's previously-focused element across Shadow DOM.
    dialogFocus.set(this, this.getRootNode().activeElement);
    this.open = true;
    dialogs.push(this);
  };
  window.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    closedDialogs.push(this);
    const previous = dialogFocus.get(this);
    if (previous?.isConnected) previous.focus();
    this.dispatchEvent(new window.Event("close"));
  };
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
    hidden,
  };
  const listeners = new Set();
  const navigation = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const galleryReads = [];
  const session = {
    loadProductGallery: (url, signal) => {
      galleryReads.push({ url, signal });
      return loadGallery?.(url, signal) ?? Promise.resolve(undefined);
    },
  };
  window.eval(`${bundle.outputFiles[0].text};window.StageTest=StageTest;`);
  const container = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  // Roman's native shell is outside React; modal key events must not escape to it.
  const shell = window.document.createElement("div");
  shell.dataset.romanPanel = "";
  const content = window.document.createElement("div");
  const shellKeys = [];
  shell.addEventListener("keydown", (event) => shellKeys.push(event.key));
  shell.append(content);
  container.append(shell);
  const unmount = window.StageTest.mount(content, navigation, session);
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
  if (initialPath === "/products/linen" && !hidden)
    await until(
      () => container.querySelector(".roman-product-stage-price"),
      "Stage should read the PDP",
    );
  return {
    window,
    container,
    listeners,
    galleryReads,
    dialogs,
    closedDialogs,
    shellKeys,
    shell,
    mediaQueries,
    dispose,
    setMobile(value) {
      for (const media of mediaQueries.values()) {
        if (!/max-width:\s*1023px/.test(media.media)) continue;
        media.matches = value;
        media.listeners.forEach((fn) =>
          fn({ matches: value, media: media.media }),
        );
      }
    },
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
  assert.doesNotMatch(
    container.textContent,
    /Hidden choice|Your selection|Current product quote/,
  );
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
    () => ctx.container.textContent.includes("Opening your next page"),
    "Pending navigation has a status without a selection eyebrow",
  );
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-price"),
    null,
  );
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
  ctx.window.document.querySelector("main").innerHTML =
    markup("Removed stage");
  await delay(35);
  assert.equal(ctx.container.textContent, "");
});

test("selected imagery survives the empty DOM between a PDP and another background page", async (t) => {
  const ctx = await setup(t);
  const image = ctx.container.querySelector("img").src;
  ctx.window.document.querySelector("main").replaceChildren();
  await delay(40);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-price"),
    null,
  );
  ctx.window.history.pushState({}, "", "/products/unselected");
  ctx.window.document.querySelector("main").innerHTML = markup(
    "Not the selected blind",
  ).replace("room.jpg", "other.jpg");
  ctx.update({ url: ctx.window.location.href });
  await delay(40);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.doesNotMatch(ctx.container.textContent, /Not the selected blind/);
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-price"),
    null,
  );
});

test("a restored selection loads its own large image once from another page and retains it through navigation", async (t) => {
  const image = "https://shop.example/cdn/shop/files/restored.jpg?width=1200";
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadGallery: async () => gallery(image),
  });
  await until(
    () => ctx.container.querySelector("img")?.src === image,
    "Restored image is displayed",
  );
  assert.equal(ctx.galleryReads.length, 1);
  assert.equal(ctx.galleryReads[0].url, "/products/linen");
  assert.ok(ctx.galleryReads[0].signal);
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-price"),
    null,
  );
  ctx.update({ pending: true });
  await delay(10);
  ctx.window.history.pushState({}, "", "/");
  ctx.update({ url: ctx.window.location.href, pending: false });
  await delay(10);
  assert.equal(ctx.container.querySelector("img").src, image);
  assert.equal(ctx.galleryReads.length, 1);
});

test("replacement and ending release image work and cannot display an obsolete result", async (t) => {
  const pending = [];
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadGallery: () => new Promise((resolve) => pending.push(resolve)),
  });
  await until(() => pending.length === 1, "Original image lookup started");
  ctx.update({ selectedPath: "/products/replacement" });
  await until(() => pending.length === 2, "Replacement image lookup started");
  assert.equal(ctx.galleryReads[0].signal.aborted, true);
  pending[0](gallery("https://shop.example/cdn/shop/files/obsolete.jpg"));
  await delay(10);
  assert.equal(ctx.container.querySelector("img"), null);
  pending[1](
    gallery(
      "https://shop.example/cdn/shop/files/replacement.jpg",
      "/products/replacement",
    ),
  );
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
  assert.equal(ctx.galleryReads[2].signal.aborted, true);
  pending[2](
    gallery(
      "https://shop.example/cdn/shop/files/late.jpg",
      "/products/third",
    ),
  );
  await delay(10);
  assert.equal(ctx.container.textContent, "");
});

test("an unavailable recovery image settles without a request loop and later live imagery can restore it", async (t) => {
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadGallery: async () => undefined,
  });
  await until(() => ctx.galleryReads.length === 1, "Recovery attempted once");
  await delay(10);
  ctx.update({ error: "Unrelated page error" });
  await delay(10);
  assert.equal(ctx.galleryReads.length, 1);
  assert.equal(ctx.container.querySelector("img"), null);
  ctx.window.history.pushState({}, "", "/products/linen");
  ctx.update({ url: ctx.window.location.href });
  await until(
    () => ctx.container.querySelector("img"),
    "Live PDP restores imagery",
  );
  assert.match(ctx.container.querySelector("img").src, /room\.jpg/);
});

test("live supporting and feature images update the gallery without losing it on background navigation", async (t) => {
  const ctx = await setup(t);
  const gallery = ctx.window.document.querySelector("swiper-container");
  gallery.insertAdjacentHTML(
    "beforeend",
    '<img data-testid="pdp-product-image-main" src="/cdn/shop/files/detail.jpg?width=1200"><div data-feature-option-slide-holder hidden><img data-feature-option-slide-image src="/cdn/shop/files/motor.jpg?width=1200"></div>',
  );
  await until(
    () =>
      ctx.container.querySelectorAll(".roman-gallery-thumbnails button")
        .length === 2,
    "Supporting image appears",
  );
  const feature = gallery.querySelector("[data-feature-option-slide-holder]");
  feature.hidden = false;
  await until(
    () =>
      ctx.container
        .querySelector(".roman-gallery-viewport [data-current] img")
        ?.src.includes("motor.jpg"),
    "New feature imagery is selected",
  );
  feature.querySelector("img").src = "/cdn/shop/files/remote.jpg?width=1200";
  await until(
    () =>
      ctx.container
        .querySelector(".roman-gallery-viewport [data-current] img")
        ?.src.includes("remote.jpg"),
    "Changed feature imagery is selected",
  );
  feature.style.display = "none";
  await until(
    () =>
      ctx.container.querySelectorAll(".roman-gallery-thumbnails button")
        .length === 2,
    "Native inline hiding removes its feature slide",
  );
  feature.style.display = "";
  await until(
    () =>
      ctx.container
        .querySelector(".roman-gallery-viewport [data-current] img")
        ?.src.includes("remote.jpg"),
    "Native inline reveal restores its feature slide",
  );
  ctx.window.history.pushState({}, "", "/cart");
  ctx.window.document.querySelector("main").replaceChildren();
  ctx.update({ url: ctx.window.location.href });
  await delay(30);
  assert.equal(
    ctx.container.querySelectorAll(".roman-gallery-thumbnails button").length,
    3,
  );
  assert.match(
    ctx.container.querySelector(".roman-gallery-viewport [data-current] img")
      .src,
    /remote.jpg/,
  );
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-price"),
    null,
  );
});

test("hidden selected-product panels defer and cancel gallery recovery until visible", async (t) => {
  const pending = [];
  const ctx = await setup(t, {
    initialPath: "/cart",
    hidden: true,
    loadGallery: () => new Promise((resolve) => pending.push(resolve)),
  });
  await delay(10);
  assert.equal(ctx.galleryReads.length, 0);
  ctx.update({ hidden: false });
  await until(() => pending.length === 1, "Visible panel restores imagery");
  ctx.update({ hidden: true });
  await until(
    () => ctx.galleryReads[0].signal.aborted,
    "Hidden panel cancels its display lookup",
  );
  pending[0](gallery("https://shop.example/cdn/shop/files/late.jpg"));
  await delay(10);
  assert.equal(ctx.container.querySelector("img"), null);
  ctx.update({ hidden: false });
  await until(
    () => pending.length === 2,
    "Reopening restores current imagery",
  );
  pending[1](gallery("https://shop.example/cdn/shop/files/current.jpg"));
  await until(
    () => ctx.container.querySelector("img")?.src.includes("current.jpg"),
    "Fresh image appears",
  );
  ctx.update({ hidden: true });
  await until(
    () => !ctx.container.querySelector("img"),
    "Hidden gallery unmounts image elements",
  );
  ctx.update({ hidden: false });
  await until(
    () => ctx.container.querySelector("img"),
    "Retained gallery reappears",
  );
  assert.equal(ctx.galleryReads.length, 2);
});

test("restoring mismatched gallery data cannot display another product", async (t) => {
  const ctx = await setup(t, {
    initialPath: "/cart",
    loadGallery: async () =>
      gallery(
        "https://shop.example/cdn/shop/files/wrong.jpg",
        "/products/other",
      ),
  });
  await until(() => ctx.galleryReads.length === 1, "Recovery completed");
  await delay(10);
  assert.equal(ctx.container.querySelector("img"), null);
  assert.equal(ctx.galleryReads.length, 1);
});

async function expandSelectedProduct(ctx) {
  const trigger = ctx.container.querySelector(
    '[aria-label="Expand selected product"]',
  );
  assert.ok(trigger, "Mobile selected product exposes expansion");
  trigger.click();
  await until(
    () => ctx.container.querySelector(".roman-product-expanded[open]"),
    "Expanded product is a native modal",
  );
  return ctx.container.querySelector(".roman-product-expanded");
}

test("mobile selection stays compact and expands the existing gallery without fetching or changing the theme", async (t) => {
  const ctx = await setup(t, { mobile: true });
  const thumbnail = ctx.container.querySelector("img");
  assert.ok(thumbnail);
  assert.match(ctx.container.textContent, /Calm linen blind/);
  assert.match(ctx.container.textContent, /45\.00/);
  assert.match(ctx.container.textContent, /500 × 600 mm/);
  assert.doesNotMatch(
    ctx.container.textContent,
    /Your selection|Current product quote/,
  );
  assert.equal(ctx.container.querySelector(".roman-product-gallery"), null);
  assert.equal(
    ctx.container.querySelector(".roman-product-stage-configuration"),
    null,
  );
  assert.equal(ctx.container.querySelector(".roman-gallery-controls"), null);
  assert.equal(ctx.container.querySelector(".roman-gallery-enlarge"), null);

  const nativeGallery = ctx.window.document.querySelector("swiper-container");
  nativeGallery.insertAdjacentHTML(
    "beforeend",
    '<img data-testid="pdp-product-image-main" src="/cdn/shop/files/detail.jpg?width=1200">',
  );
  await delay(35);
  const readsBefore = ctx.galleryReads.length;
  const themeBefore = ctx.window.document.querySelector("main").innerHTML;
  const dialog = await expandSelectedProduct(ctx);
  assert.equal(ctx.dialogs.length, 1);
  assert.equal(
    ctx.container.activeElement.getAttribute("aria-label"),
    "Collapse selected product",
  );
  assert.ok(dialog.querySelector(".roman-product-gallery"));
  assert.equal(
    dialog.querySelector(".roman-product-stage-configuration").open,
    true,
  );
  assert.match(dialog.querySelector("dl").textContent, /FittingRecess/);
  assert.equal(
    dialog.querySelector(".roman-gallery-enlarge"),
    null,
    "Expansion owns the mobile full-screen view without nested image zoom",
  );
  assert.ok(dialog.querySelector('[aria-label="Next product image"]'));
  dialog.querySelector('[aria-label="Next product image"]').click();
  await until(
    () =>
      dialog
        .querySelector(".roman-gallery-viewport [data-current] img")
        ?.src.includes("detail.jpg"),
    "Expanded product uses the shared gallery controls",
  );
  assert.equal(ctx.galleryReads.length, readsBefore);
  assert.equal(
    ctx.window.document.querySelector("main").innerHTML,
    themeBefore,
  );
  dialog.querySelector('[aria-label="Collapse selected product"]').click();
  await until(
    () => !ctx.container.querySelector(".roman-product-expanded"),
    "Collapse removes the modal",
  );
  assert.equal(dialog.open, false);
  assert.equal(ctx.closedDialogs.length, 1);
  assert.equal(
    ctx.container.activeElement.getAttribute("aria-label"),
    "Expand selected product",
  );
  assert.equal(ctx.container.querySelector(".roman-product-gallery"), null);
  assert.equal(ctx.galleryReads.length, readsBefore);
});

test("expanded mobile selection reflects current native measurements, quote and choices", async (t) => {
  const ctx = await setup(t, { mobile: true });
  const dialog = await expandSelectedProduct(ctx);
  const form = ctx.window.document.querySelector("form");
  form.classList.add("loading");
  await until(
    () => !dialog.querySelector(".roman-product-stage-price"),
    "Expanded view hides stale pricing",
  );
  form.classList.remove("loading");
  form.querySelector("[data-width-input]").value = "750";
  form.querySelector('[value="Exact##7"]').checked = true;
  form.querySelector("[data-dynamic-price]").textContent = "£70.00";
  form.dispatchEvent(new ctx.window.Event("change", { bubbles: true }));
  await until(
    () => dialog.textContent.includes("£70.00"),
    "Expanded view receives live pricing",
  );
  assert.match(dialog.textContent, /750 × 600 mm/);
  assert.match(dialog.querySelector("dl").textContent, /FittingExact/);
  assert.equal(
    ctx.dialogs.length,
    1,
    "A native update does not reopen or replace the modal",
  );
});

test("native cancellation closes the expanded product and modal keys never escape to the assistant shell", async (t) => {
  const ctx = await setup(t, { mobile: true });
  const dialog = await expandSelectedProduct(ctx);
  for (const key of ["Escape", "Tab"]) {
    dialog.querySelector("button").dispatchEvent(
      new ctx.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }
  assert.deepEqual(ctx.shellKeys, []);
  const cancel = new ctx.window.Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  await until(
    () => !ctx.container.querySelector(".roman-product-expanded"),
    "Native cancel collapses only the product view",
  );
  assert.equal(dialog.open, false);
  assert.ok(
    ctx.container.querySelector("aside"),
    "Roman's active selection remains mounted",
  );
  assert.equal(
    ctx.container.activeElement.getAttribute("aria-label"),
    "Expand selected product",
  );
});

test("expanded product releases its native modal on hiding, shell closure, replacement, desktop resize and unmount", async (t) => {
  for (const transition of [
    "hide",
    "shell",
    "replace",
    "desktop",
    "unmount",
  ]) {
    await t.test(transition, async (t) => {
      const ctx = await setup(t, { mobile: true });
      const dialog = await expandSelectedProduct(ctx);
      if (transition === "hide") ctx.update({ hidden: true });
      else if (transition === "shell") ctx.shell.hidden = true;
      else if (transition === "replace")
        ctx.replace("/products/replacement", "Another blind");
      else if (transition === "desktop") ctx.setMobile(false);
      else ctx.dispose();
      await until(
        () => !dialog.open,
        "Leaving the mobile expanded view releases native modality",
      );
      assert.equal(
        ctx.container.querySelector(".roman-product-expanded"),
        null,
      );
      assert.equal(
        ctx.closedDialogs.filter((item) => item === dialog).length,
        1,
      );
      if (transition === "hide") {
        ctx.update({ hidden: false });
        await until(
          () =>
            ctx.container.querySelector(
              '[aria-label="Expand selected product"]',
            ),
          "Reopening uses compact view",
        );
        assert.equal(
          ctx.container.querySelector(".roman-product-expanded"),
          null,
        );
      } else if (transition === "replace") {
        await until(
          () => ctx.container.textContent.includes("Another blind"),
          "Replacement stays collapsed",
        );
      } else if (transition === "desktop") {
        assert.equal(
          ctx.container.querySelector(
            '[aria-label="Expand selected product"]',
          ),
          null,
        );
        assert.ok(ctx.container.querySelector(".roman-product-gallery"));
        assert.ok(
          ctx.container.querySelector(".roman-gallery-enlarge"),
          "Desktop keeps the existing image zoom",
        );
      }
      ctx.dispose();
      assert.equal(ctx.listeners.size, 0);
      for (const media of ctx.mediaQueries.values())
        assert.equal(media.listeners.size, 0);
    });
  }
});
