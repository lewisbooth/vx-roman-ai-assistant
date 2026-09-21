import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const origin = "https://hd-dev-multi.myshopify.com";
const runtimeUrl =
  "https://cdn.shopify.com/extensions/roman-assistant.bundle.js";
const openStorageKey = "roman:sidebar-open";
const bundle = await build({
  entryPoints: ["frontend/src/bootstrap.ts"],
  bundle: true,
  write: false,
  metafile: true,
  format: "iife",
  platform: "browser",
  define: { "import.meta.env.DEV": "false" },
  loader: { ".svg": "dataurl", ".css": "text", ".woff2": "dataurl" },
});
const focusBundle = await build({
  entryPoints: ["frontend/src/chat/composer-focus.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ComposerFocus",
  platform: "browser",
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail(message);
}

function setup(t, beforeImport, { url = `${origin}/`, storage = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html data-roman-preview="true"><head><title>Store</title></head>
    <body><app-provider><main id="main"><h1>Store content</h1></main></app-provider>
    <roman-ai-assistant data-shop="hd-dev-multi.myshopify.com" data-label="Roman AI Assistant"
      data-script-url="${runtimeUrl}" data-logo-url="/roman-logo.svg" data-wordmark-url="/roman-wordmark.svg"></roman-ai-assistant></body></html>`,
    { url, runScripts: "outside-only", pretendToBeVisual: true },
  );
  const { window } = dom;
  const { document } = window;
  const requests = [];
  const logs = [];
  const errors = [];
  const warnings = [];
  const intersections = [];
  window.IntersectionObserver = class {
    targets = new Set();
    constructor(callback) {
      this.callback = callback;
      intersections.push(this);
    }
    observe(target) {
      this.targets.add(target);
      this.callback([{ target, isIntersecting: true }]);
    }
    disconnect() {
      this.targets.clear();
    }
  };
  window.console.log = (...args) => logs.push(args.map(String).join(" "));
  window.console.error = (...args) => errors.push(args.map(String).join(" "));
  window.console.warn = (...args) => warnings.push(args.map(String).join(" "));
  window.scrollTo = () => {};
  window.fetch = () =>
    assert.fail("The shell must not request storefront pages");
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof window.HTMLScriptElement &&
          node.hasAttribute("data-roman-runtime")
        )
          requests.push(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  for (const [key, value] of Object.entries(storage))
    window.sessionStorage.setItem(key, value);
  beforeImport?.(window);
  window.eval(`${focusBundle.outputFiles[0].text}\nwindow.ComposerFocus = ComposerFocus;`);
  window.eval(bundle.outputFiles[0].text);
  const host = document.querySelector("roman-ai-assistant");
  t.after(async () => {
    host.remove();
    await delay(0);
    observer.disconnect();
    window.close();
  });
  return {
    window,
    document,
    host,
    requests,
    logs,
    errors,
    warnings,
    intersections,
    setInView(target, isIntersecting) {
      for (const observer of intersections)
        if (observer.targets.has(target))
          observer.callback([{ target, isIntersecting }]);
    },
    launcher: () => host.shadowRoot.querySelector("[data-roman-launcher]"),
    panel: () => host.shadowRoot.querySelector("[data-roman-panel]"),
    close: () =>
      host.shadowRoot.querySelector('button[aria-label="Close assistant"]'),
    progress: () => host.shadowRoot.querySelector('[role="progressbar"]'),
    retry: () => host.shadowRoot.querySelector("[data-roman-retry]"),
  };
}

function installRuntime(window, readiness = () => Promise.resolve()) {
  const mounts = [];
  window.RomanAssistant = {
    mountAssistant(
      host,
      container,
      loadingStartedAt,
      setSessionActive = () => {},
    ) {
      const content = window.document.createElement("p");
      content.textContent = "Runtime content";
      container.append(content);
      const composerFocus = window.ComposerFocus.createComposerFocus(container);
      const mount = {
        host,
        container,
        content,
        loadingStartedAt,
        setSessionActive,
        open: [],
        disposed: 0,
      };
      mounts.push(mount);
      return {
        ready: readiness(mounts.length),
        focus: () => composerFocus.focus(),
        setOpen: (open) => {
          mount.open.push(open);
          if (!open) composerFocus.cancel();
        },
        dispose: () => {
          mount.disposed++;
          setSessionActive(false);
          content.remove();
          composerFocus.dispose();
        },
      };
    },
  };
  return mounts;
}

function loadingScript(document) {
  return document.querySelector("script[data-roman-runtime]");
}

function hidden(element) {
  return !element || !!element.closest("[hidden]");
}

function addRuntimeComposer(mount, disabled = false) {
  const { document } = mount.host.ownerDocument.defaultView;
  const input = document.createElement("textarea");
  input.dataset.romanComposer = "";
  input.disabled = disabled;
  const mute = document.createElement("button");
  mute.textContent = "Mute microphone";
  mount.container.append(input, mute);
  return { input, mute };
}

test("first lazy mount focuses the welcome composer only once visible, and reopening focuses it again beside voice controls", async (t) => {
  const ctx = setup(t);
  const ready = deferred();
  ctx.launcher().click();
  const mounts = installRuntime(ctx.window, () => ready.promise);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "Runtime did not mount");
  const { input, mute } = addRuntimeComposer(mounts[0]);
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
  assert.equal(hidden(input), true);
  ready.resolve();
  await until(() => ctx.host.shadowRoot.activeElement === input, "Visible welcome composer was not focused");
  mute.focus();
  input.disabled = true;
  input.disabled = false;
  await delay(0);
  assert.equal(ctx.host.shadowRoot.activeElement, mute, "Unrelated changes must not steal focus");
  ctx.close().click();
  ctx.launcher().click();
  assert.equal(ctx.host.shadowRoot.activeElement, input);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].open.at(-1), true);
});

test("mobile opening, restoration and reopening never summon the text keyboard", async (t) => {
  for (const restore of [false, true]) {
    await t.test(restore ? "restored" : "first open", async (t) => {
      const ctx = setup(
        t,
        (window) => {
          window.matchMedia = () => ({ matches: true });
        },
        { storage: restore ? { [openStorageKey]: "1" } : {} },
      );
      const ready = deferred();
      if (!restore) ctx.launcher().click();
      const mounts = installRuntime(ctx.window, () => ready.promise);
      await until(() => loadingScript(ctx.document), "Runtime was not requested");
      loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
      await until(() => mounts.length === 1, "Runtime did not mount");
      const { input } = addRuntimeComposer(mounts[0], true);
      ready.resolve();
      await until(() => !hidden(mounts[0].container), "Runtime stayed hidden");
      input.disabled = false;
      await delay(0);
      assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
      input.focus();
      assert.equal(
        ctx.host.shadowRoot.activeElement,
        input,
        "Deliberate typing stays available",
      );
      ctx.close().click();
      ctx.launcher().click();
      assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
    });
  }
});

test("opening during restoration waits for the composer but respects a later customer focus choice", async (t) => {
  for (const destination of ["input", "voice", "shell-close", "close", "remove"])
    await t.test(destination, async (t) => {
      const ctx = setup(t);
      const ready = deferred();
      ctx.launcher().click();
      const mounts = installRuntime(ctx.window, () => ready.promise);
      loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
      await until(() => mounts.length === 1, "Runtime did not mount");
      const { input, mute } = addRuntimeComposer(mounts[0], true);
      ready.resolve();
      await until(() => !hidden(mounts[0].container), "Runtime stayed hidden");
      assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
      if (destination === "voice") mute.focus();
      if (destination === "shell-close") {
        const sibling = ctx.document.createElement("button");
        ctx.panel().append(sibling);
        sibling.focus();
        ctx.close().focus();
      }
      if (destination === "close") ctx.close().click();
      if (destination === "remove") {
        ctx.host.remove();
        await delay(0);
      }
      input.disabled = false;
      await delay(0);
      if (destination === "input")
        assert.equal(ctx.host.shadowRoot.activeElement, input);
      else if (destination === "voice")
        assert.equal(ctx.host.shadowRoot.activeElement, mute);
      else if (destination === "shell-close")
        assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
      else assert.notEqual(ctx.host.shadowRoot.activeElement, input);
    });
});

test("closing before the lazy runtime is ready never focuses its hidden composer", async (t) => {
  const ctx = setup(t);
  const ready = deferred();
  ctx.launcher().click();
  const mounts = installRuntime(ctx.window, () => ready.promise);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "Runtime did not mount");
  const { input } = addRuntimeComposer(mounts[0]);
  ctx.close().click();
  ready.resolve();
  await until(() => !mounts[0].container.hidden, "Runtime did not become ready");
  assert.notEqual(ctx.host.shadowRoot.activeElement, input);
  ctx.launcher().click();
  assert.equal(ctx.host.shadowRoot.activeElement, input);
});

function addVisibleHeader(document) {
  const header = document.createElement("main-header");
  const form = document.createElement("form");
  form.dataset.form = "header-search";
  const row = document.createElement("div");
  row.dataset.searchContainer = "";
  const field = document.createElement("div");
  const search = document.createElement("input");
  search.dataset.testid = "menu-search-input";
  search.getClientRects = () => [{ width: 1, height: 48 }];
  Object.defineProperty(search, "offsetHeight", { value: 48 });
  const submit = document.createElement("button");
  submit.type = "submit";
  field.append(search, submit);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.searchClose = "";
  row.append(field, cancel);
  form.append(row);
  const utilities = document.createElement("div");
  utilities.className = "header__utilities";
  const account = document.createElement("a");
  account.dataset.testid = "menu-account-link";
  utilities.append(account);
  header.append(form, utilities);
  document.body.prepend(header);
  return { header, search, form, cancel, account };
}

function headerLauncher(document) {
  return document.querySelector("[data-roman-header-launcher]");
}

function headerButton(document) {
  return headerLauncher(document)?.shadowRoot?.querySelector(
    "[data-roman-launcher]",
  );
}

test("the production bootstrap excludes React, the app and storefront navigation", () => {
  const inputs = Object.keys(bundle.metafile.inputs).join("\n");
  assert.doesNotMatch(
    inputs,
    /node_modules\/(?:react|react-dom|react-router)(?:\/|$)/,
  );
  assert.doesNotMatch(
    inputs,
    /frontend\/src\/(?:main\.tsx|app\.tsx|navigation\/)/,
  );
});

test("the shell waits for a click before requesting runtime or loading images", async (t) => {
  const {
    document,
    window,
    host,
    launcher,
    panel,
    progress,
    close,
    requests,
    logs,
  } = setup(t);
  await delay(0);
  const button = launcher();
  assert.ok(button);
  assert.equal(button.getAttribute("aria-label"), "Roman AI Assistant");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(host.shadowRoot.querySelector("img"), null);
  assert.equal(requests.length, 0);
  assert.equal(document.querySelector("script[data-roman-runtime]"), null);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  assert.equal(window.history.length, 1);
  button.click();
  assert.equal(hidden(panel()), false);
  assert.equal(panel().tagName, "SECTION");
  assert.equal(panel().getAttribute("role"), "dialog");
  assert.equal(panel().getAttribute("aria-modal"), "true");
  assert.equal(panel().getAttribute("aria-label"), "Roman AI Assistant");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(hidden(progress()), false);
  assert.equal(progress().getAttribute("aria-label"), "Loading Roman");
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    true,
  );
  assert.ok(document.querySelector("style[data-roman-layout]"));
  assert.equal(loadingScript(document).src, runtimeUrl);
  assert.deepEqual(logs, ["Hello from Roman"]);
  close().click();
  button.click();
  await delay(0);
  assert.equal(
    requests.length,
    1,
    "reopening during download must share the request",
  );
  assert.equal(launcher(), button);
});

test("fullscreen containment locks storefront scrolling without disabling native product controls", async (t) => {
  const ctx = setup(t);
  const body = ctx.document.body;
  body.style.width = "1280px";
  const themeStyle = ctx.document.createElement("style");
  themeStyle.textContent = "body { overflow: auto }";
  ctx.document.head.append(themeStyle);
  const product = ctx.document.querySelector("main");
  const input = ctx.document.createElement("input");
  const button = ctx.document.createElement("button");
  product.append(input, button);
  let changes = 0;
  let clicks = 0;
  input.addEventListener("change", () => changes++);
  button.addEventListener("click", () => clicks++);
  ctx.launcher().click();
  assert.equal(ctx.window.getComputedStyle(body).overflow, "hidden");
  assert.equal(ctx.window.getComputedStyle(ctx.document.documentElement).overflow, "hidden");
  assert.equal(body.style.width, "1280px");
  assert.equal(body.style.marginRight, "");
  assert.equal(product.closest("[inert],[aria-hidden=true],[hidden]"), null);
  input.value = "500";
  input.dispatchEvent(new ctx.window.Event("change", { bubbles: true }));
  button.click();
  assert.equal(input.value, "500");
  assert.equal(changes, 1);
  assert.equal(clicks, 1);
  input.focus();
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
  ctx.close().click();
  assert.equal(ctx.window.getComputedStyle(body).overflow, "auto");
  input.focus();
  assert.equal(ctx.document.activeElement, input);
  ctx.launcher().click();
  ctx.host.remove();
  await delay(0);
  input.focus();
  assert.equal(ctx.document.activeElement, input);
  assert.equal(ctx.window.getComputedStyle(body).overflow, "auto");
  assert.equal(body.style.width, "1280px");
});

test("the fullscreen dialog wraps Tab at its visible controls without trapping ordinary field editing", (t) => {
  const ctx = setup(t);
  ctx.launcher().click();
  const field = ctx.document.createElement("textarea");
  const disabled = ctx.document.createElement("button");
  disabled.disabled = true;
  const invisible = ctx.document.createElement("button");
  invisible.style.visibility = "hidden";
  ctx.panel().prepend(field, disabled, invisible);
  for (const element of [field, disabled, invisible, ctx.close()])
    element.getClientRects = () => [{ width: 44, height: 44 }];
  const tab = (element, shiftKey = false) => {
    const event = new ctx.window.KeyboardEvent("keydown", {
      key: "Tab", shiftKey, bubbles: true, cancelable: true,
    });
    element.dispatchEvent(event);
    return event;
  };
  assert.equal(tab(ctx.close()).defaultPrevented, true);
  assert.equal(ctx.host.shadowRoot.activeElement, field);
  assert.equal(tab(field).defaultPrevented, false);
  assert.equal(tab(field, true).defaultPrevented, true);
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
});

test("traditional navigation restores the fullscreen dialog and keeps focus out of the covered storefront", async (t) => {
  const first = setup(t);
  first.launcher().click();
  const oldMounts = installRuntime(first.window);
  loadingScript(first.document).dispatchEvent(new first.window.Event("load"));
  await until(
    () => oldMounts.length === 1 && hidden(first.progress()),
    "original runtime did not become ready",
  );
  first.host.remove();
  await delay(0);
  assert.equal(oldMounts[0].disposed, 1);
  assert.equal(first.window.sessionStorage.getItem(openStorageKey), "1");
  const next = setup(
    t,
    (window) => {
      const search = window.document.createElement("input");
      search.id = "store-search";
      search.setAttribute("aria-label", "Search products");
      window.document.querySelector("main").append(search);
      search.focus();
    },
    {
      url: `${origin}/collections/all`,
      storage: { ...first.window.sessionStorage },
    },
  );
  assert.equal(next.launcher().getAttribute("aria-expanded"), "true");
  assert.equal(hidden(next.panel()), false);
  assert.equal(hidden(next.progress()), false);
  assert.equal(
    next.document.documentElement.hasAttribute("data-roman-open"),
    true,
  );
  assert.equal(next.host.shadowRoot.activeElement, next.close());
  assert.ok(loadingScript(next.document));
  const newMounts = installRuntime(next.window);
  loadingScript(next.document).dispatchEvent(new next.window.Event("load"));
  await until(
    () => newMounts.length === 1 && hidden(next.progress()),
    "restored runtime did not become ready",
  );
  assert.equal(newMounts[0].open.at(-1), true);
  assert.equal(next.host.shadowRoot.activeElement, next.close());
  assert.equal(next.requests.length, 1);
  assert.deepEqual(next.logs, [], "restoration is not another launcher click");
});

test("an explicit close persists across traditional navigation without loading the next runtime", async (t) => {
  const first = setup(t);
  first.launcher().click();
  first.close().click();
  assert.equal(first.window.sessionStorage.getItem(openStorageKey), "0");
  first.host.remove();
  await delay(0);
  const next = setup(t, undefined, {
    url: `${origin}/products/another-product`,
    storage: { ...first.window.sessionStorage },
  });
  await delay(0);
  assert.equal(next.launcher().getAttribute("aria-expanded"), "false");
  assert.equal(hidden(next.panel()), true);
  assert.equal(loadingScript(next.document), null);
  assert.equal(next.requests.length, 0);
  assert.equal(next.host.shadowRoot.querySelector("img"), null);
  assert.equal(
    next.document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
});

test("opening persists before download completion so a new document restores the loading sidebar", async (t) => {
  const first = setup(t);
  first.launcher().click();
  assert.ok(loadingScript(first.document));
  assert.equal(first.window.RomanAssistant, undefined);
  assert.equal(first.window.sessionStorage.getItem(openStorageKey), "1");
  first.host.remove();
  await delay(0);
  const next = setup(t, undefined, {
    url: `${origin}/cart`,
    storage: { ...first.window.sessionStorage },
  });
  await delay(0);
  assert.equal(next.launcher().getAttribute("aria-expanded"), "true");
  assert.equal(hidden(next.progress()), false);
  assert.ok(loadingScript(next.document));
  assert.equal(next.requests.length, 1);
  assert.equal(next.window.sessionStorage.getItem(openStorageKey), "1");
});

test("an existing conversation resumes behind a closed panel without focus or layout changes", async (t) => {
  const ctx = setup(
    t,
    (window) => {
      const input = window.document.createElement("input");
      input.id = "store-search";
      window.document.querySelector("main").append(input);
      input.focus();
    },
    {
      storage: {
        [openStorageKey]: "0",
        "roman:conversation": "stored credential wake hint",
      },
    },
  );
  assert.equal(hidden(ctx.panel()), true);
  assert.equal(ctx.launcher().getAttribute("aria-expanded"), "false");
  assert.equal(ctx.document.querySelector("style[data-roman-layout]"), null);
  assert.equal(
    ctx.document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  assert.equal(ctx.document.activeElement.id, "store-search");
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => mounts.length === 1 && hidden(ctx.progress()),
    "hidden runtime did not become ready",
  );
  assert.equal(hidden(ctx.panel()), true);
  assert.deepEqual(mounts[0].open, [false]);
  assert.equal(ctx.document.activeElement.id, "store-search");
  ctx.launcher().click();
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(mounts.length, 1);
  assert.equal(ctx.requests.length, 1);
});

test("BFCache wakes a previously untouched closed page only when a conversation now exists", async (t) => {
  const ctx = setup(t);
  const show = () =>
    ctx.window.dispatchEvent(
      new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
    );
  show();
  assert.equal(loadingScript(ctx.document), null);
  ctx.window.sessionStorage.setItem(
    "roman:conversation",
    "stored credential wake hint",
  );
  show();
  assert.ok(loadingScript(ctx.document));
  assert.equal(hidden(ctx.panel()), true);
  assert.equal(ctx.launcher().getAttribute("aria-expanded"), "false");
  assert.equal(ctx.host.shadowRoot.activeElement, null);
  await delay(0);
  assert.equal(ctx.requests.length, 1);
});

test("blocked session storage does not prevent opening or closing the sidebar", async (t) => {
  for (const failure of ["access denied", "writes denied"]) {
    await t.test(failure, async (t) => {
      const ctx = setup(t, (window) => {
        const denied = () => {
          throw new window.DOMException("Storage unavailable", "SecurityError");
        };
        if (failure === "access denied")
          Object.defineProperty(window, "sessionStorage", { get: denied });
        else window.Storage.prototype.setItem = denied;
      });
      ctx.launcher().click();
      assert.equal(hidden(ctx.panel()), false);
      assert.ok(loadingScript(ctx.document));
      ctx.close().click();
      assert.equal(hidden(ctx.panel()), true);
      assert.equal(ctx.launcher().getAttribute("aria-expanded"), "false");
      ctx.launcher().click();
      await delay(0);
      assert.equal(hidden(ctx.panel()), false);
      assert.equal(ctx.requests.length, 1);
      ctx.window.dispatchEvent(
        new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
      );
      assert.equal(
        hidden(ctx.panel()),
        false,
        "unavailable storage must not close an open cached sidebar",
      );
    });
  }
});

test("malformed saved values leave the sidebar closed without loading assets", async (t) => {
  for (const value of ["", "true", "false", "2", "null", '{"open":true}']) {
    const ctx = setup(t, undefined, { storage: { [openStorageKey]: value } });
    await delay(0);
    assert.equal(
      ctx.launcher().getAttribute("aria-expanded"),
      "false",
      `unexpected restoration for ${JSON.stringify(value)}`,
    );
    assert.equal(hidden(ctx.panel()), true);
    assert.equal(loadingScript(ctx.document), null);
    assert.equal(ctx.requests.length, 0);
  }
});

test("a cached page restore updates modal focus and visibility without remounting", async (t) => {
  const ctx = setup(t);
  ctx.launcher().click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => mounts.length === 1 && hidden(ctx.progress()),
    "runtime did not become ready",
  );
  mounts[0].setSessionActive(true);
  const search = ctx.document.createElement("input");
  ctx.document.querySelector("main").append(search);
  search.focus();
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
  ctx.window.sessionStorage.setItem(openStorageKey, "0");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: false }),
  );
  assert.equal(
    hidden(ctx.panel()),
    false,
    "ordinary pageshow must not resync an active document",
  );
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(hidden(ctx.panel()), true);
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.launcher());
  assert.equal(mounts[0].open.at(-1), false);
  assert.equal(
    ctx.document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  ctx.window.sessionStorage.setItem(openStorageKey, "1");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
  assert.equal(mounts[0].open.at(-1), true);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].disposed, 0);
  assert.equal(ctx.requests.length, 1);
  ctx.close().focus();
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.close());
  ctx.window.sessionStorage.setItem(openStorageKey, "0");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(hidden(ctx.panel()), true);
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.launcher());
});

test("the cached-page visibility listener is removed with its embed and restored on reinsertion", async (t) => {
  const listeners = new Set();
  const ctx = setup(t, (window) => {
    const addEventListener = window.addEventListener.bind(window);
    const removeEventListener = window.removeEventListener.bind(window);
    window.addEventListener = (type, listener, ...options) => {
      if (type === "pageshow") listeners.add(listener);
      addEventListener(type, listener, ...options);
    };
    window.removeEventListener = (type, listener, ...options) => {
      if (type === "pageshow") listeners.delete(listener);
      removeEventListener(type, listener, ...options);
    };
  });
  assert.equal(listeners.size, 1);
  ctx.host.remove();
  await delay(0);
  assert.equal(listeners.size, 0);
  ctx.document.body.append(ctx.host);
  assert.equal(listeners.size, 1);
});

test("closing during runtime readiness stays closed and reopening keeps the mounted content", async (t) => {
  const ready = deferred();
  const { document, window, host, launcher, panel, progress, close, requests } =
    setup(t);
  launcher().click();
  const mounts = installRuntime(window, () => ready.promise);
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  mounts[0].setSessionActive(true);
  assert.equal(
    hidden(progress()),
    false,
    "script arrival is not React readiness",
  );
  close().click();
  assert.equal(hidden(panel()), true);
  assert.equal(host.shadowRoot.activeElement, launcher());
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
  ready.resolve();
  await delay(0);
  assert.equal(hidden(panel()), true);
  assert.equal(host.shadowRoot.activeElement, launcher());
  assert.equal(mounts[0].open.at(-1), false);
  assert.equal(mounts[0].disposed, 0);
  launcher().click();
  assert.equal(hidden(panel()), false);
  assert.equal(hidden(progress()), true);
  assert.equal(mounts[0].content.isConnected, true);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].open.at(-1), true);
  assert.equal(requests.length, 1);
  const escape = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  close().dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(hidden(panel()), true);
  assert.equal(host.shadowRoot.activeElement, launcher());
});

test("download errors, timeouts and missing exports expose an explicit working retry", async (t) => {
  for (const failure of ["network", "timeout", "missing exports"]) {
    await t.test(failure, async (t) => {
      let timeout;
      let now = 100;
      const ctx = setup(t, (window) => {
        window.performance.now = () => now;
        if (failure !== "timeout") return;
        const setTimeout = window.setTimeout.bind(window);
        window.setTimeout = (callback, milliseconds, ...args) => {
          if (milliseconds === 15000) {
            timeout = callback;
            return 900000;
          }
          return setTimeout(callback, milliseconds, ...args);
        };
      });
      const { document, window, host, launcher, progress, retry, requests } =
        ctx;
      launcher().click();
      const script = loadingScript(document);
      if (failure === "timeout") timeout();
      else
        script.dispatchEvent(
          new window.Event(failure === "network" ? "error" : "load"),
        );
      await until(
        () => !hidden(retry()),
        "failed loading did not expose Retry",
      );
      assert.equal(hidden(progress()), true);
      assert.ok(host.shadowRoot.querySelector('[role="alert"]'));
      assert.equal(script.isConnected, false);
      assert.equal(requests.length, 1);
      now = 2000;
      retry().click();
      const replacement = loadingScript(document);
      assert.ok(replacement);
      assert.notEqual(replacement, script);
      const mounts = installRuntime(window);
      replacement.dispatchEvent(new window.Event("load"));
      await until(
        () => mounts.length === 1 && hidden(progress()),
        "retry did not finish mounting",
      );
      assert.equal(hidden(retry()), true);
      assert.equal(requests.length, 2);
      assert.equal(
        mounts[0].loadingStartedAt,
        100,
        "retry must retain the original loading start time",
      );
    });
  }
});

test("a readiness failure disposes the failed mount and retries the downloaded runtime", async (t) => {
  const ready = deferred();
  const { document, window, launcher, retry, progress, requests } = setup(t);
  launcher().click();
  const mounts = installRuntime(window, (attempt) =>
    attempt === 1 ? ready.promise : Promise.resolve(),
  );
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  ready.reject(new Error("Runtime initialization failed"));
  await until(() => !hidden(retry()), "readiness failure did not expose Retry");
  assert.equal(mounts[0].disposed, 1);
  retry().click();
  await until(
    () => mounts.length === 2 && hidden(progress()),
    "ready retry did not complete",
  );
  assert.equal(mounts[1].disposed, 0);
  assert.equal(
    requests.length,
    1,
    "mounted runtime retry should not download it again",
  );
});

test("synchronous mount errors clear partial content and allow retry without another download", async (t) => {
  const { document, window, host, launcher, retry, progress, requests } =
    setup(t);
  launcher().click();
  const mounts = installRuntime(window);
  const mountAssistant = window.RomanAssistant.mountAssistant;
  let attempts = 0;
  window.RomanAssistant.mountAssistant = (host, container) => {
    attempts++;
    if (attempts === 1) {
      container.append(document.createElement("p"));
      throw new window.Error("Runtime could not initialize");
    }
    return mountAssistant(host, container);
  };
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(() => !hidden(retry()), "mount failure did not expose Retry");
  assert.equal(
    host.shadowRoot.querySelector("[data-roman-content]").childElementCount,
    0,
  );
  assert.equal(mounts.length, 0);
  retry().click();
  await until(
    () => mounts.length === 1 && hidden(progress()),
    "mount retry did not become ready",
  );
  assert.equal(attempts, 2);
  assert.equal(requests.length, 1);
});

test("same-turn DOM moves preserve a ready mount while full removal disposes and permits a fresh mount", async (t) => {
  const { document, window, host, launcher, panel, progress, requests } =
    setup(t);
  launcher().click();
  const mounts = installRuntime(window);
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(
    () => mounts.length === 1 && hidden(progress()),
    "runtime did not become ready",
  );
  const originalPanel = panel();
  const originalLauncher = launcher();
  host.remove();
  document.body.append(host);
  await delay(0);
  assert.equal(mounts[0].disposed, 0);
  assert.equal(panel(), originalPanel);
  assert.equal(launcher(), originalLauncher);
  assert.equal(mounts[0].content.isConnected, true);
  host.remove();
  await delay(0);
  assert.equal(mounts[0].disposed, 1);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
  document.body.append(host);
  assert.equal(launcher().getAttribute("aria-expanded"), "true");
  await until(
    () => mounts.length === 2 && hidden(progress()),
    "reinserted embed did not create a fresh mount",
  );
  assert.equal(mounts[0].disposed, 1);
  assert.equal(mounts[1].disposed, 0);
  assert.equal(requests.length, 1);
});

test("download completion after disconnection cannot mount a detached embed", async (t) => {
  const { document, window, host, launcher, progress, requests } = setup(t);
  launcher().click();
  const script = loadingScript(document);
  host.remove();
  await delay(0);
  const mounts = installRuntime(window);
  script.dispatchEvent(new window.Event("load"));
  await delay(0);
  assert.equal(mounts.length, 0);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  document.body.append(host);
  assert.equal(launcher().getAttribute("aria-expanded"), "true");
  await until(
    () => mounts.length === 1 && hidden(progress()),
    "reinserted embed did not use the downloaded runtime",
  );
  assert.equal(requests.length, 1);
});

test("readiness completion after disconnection cannot reopen or retain the old runtime", async (t) => {
  const ready = deferred();
  const { document, window, host, launcher } = setup(t);
  launcher().click();
  const mounts = installRuntime(window, () => ready.promise);
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  host.remove();
  await delay(0);
  ready.resolve();
  await delay(0);
  assert.equal(mounts[0].disposed, 1);
  assert.equal(mounts[0].content.isConnected, false);
  assert.equal(
    document.documentElement.hasAttribute("data-roman-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
});

test("the header launcher sits after the search field and controls Roman without submitting search", async (t) => {
  const ctx = setup(t);
  const { search, form, cancel, account } = addVisibleHeader(ctx.document);
  let submitted = 0;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitted++;
  });
  await until(
    () => !!headerButton(ctx.document),
    "header launcher was not attached beside the visible search input",
  );
  const host = headerLauncher(ctx.document);
  const button = headerButton(ctx.document);
  assert.equal(search.parentElement.nextElementSibling, host);
  assert.equal(host.nextElementSibling, cancel);
  assert.equal(host.closest(".header__utilities"), null);
  assert.equal(account.parentElement.children.length, 1);
  assert.equal(button.style.height, "48px");
  assert.equal(button.type, "button");
  assert.equal(button.getAttribute("aria-label"), "Roman AI Assistant");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(button.firstChild.textContent.trim(), "Ask");
  const logo = button.querySelector('img[alt="Roman"]');
  assert.equal(logo.alt, "Roman");
  assert.match(logo.src, /roman-wordmark\.svg$/);
  assert.equal(ctx.launcher().hidden, true);
  button.click();
  assert.equal(submitted, 0);
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(ctx.launcher().getAttribute("aria-expanded"), "true");
  ctx.close().click();
  assert.equal(ctx.document.activeElement, host);
  assert.equal(host.shadowRoot.activeElement, button);
});

test("header replacement preserves the open runtime and moves close focus to the replacement launcher", async (t) => {
  const ctx = setup(t);
  const first = addVisibleHeader(ctx.document);
  await until(
    () => !!headerButton(ctx.document),
    "first header launcher was not attached",
  );
  headerButton(ctx.document).click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => mounts.length === 1 && hidden(ctx.progress()),
    "runtime did not become ready",
  );
  const replacement = addVisibleHeader(ctx.document);
  first.header.remove();
  await until(() => {
    const launcher = headerLauncher(ctx.document);
    return (
      !!launcher &&
      replacement.search.parentElement.nextElementSibling === launcher
    );
  }, "header launcher was not moved to the replacement header");
  const replacementHost = headerLauncher(ctx.document);
  const replacementButton = headerButton(ctx.document);
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(replacementButton.getAttribute("aria-expanded"), "true");
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].disposed, 0);
  let restoredFocusOptions;
  const focusReplacement = replacementButton.focus.bind(replacementButton);
  replacementButton.focus = (options) => {
    restoredFocusOptions = options;
    focusReplacement(options);
  };
  ctx.close().click();
  assert.equal(ctx.document.activeElement, replacementHost);
  assert.equal(replacementHost.shadowRoot.activeElement, replacementButton);
  assert.equal(restoredFocusOptions?.preventScroll, true);
});

test("an active conversation falls back when its header hook disappears and cleans up with the embed", async (t) => {
  const ctx = setup(t);
  const visible = addVisibleHeader(ctx.document);
  await until(
    () => !!headerLauncher(ctx.document),
    "header launcher was not attached",
  );
  headerButton(ctx.document).click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  mounts[0].setSessionActive(true);
  visible.search.getClientRects = () => [];
  ctx.window.dispatchEvent(new ctx.window.Event("resize"));
  await until(
    () => !headerLauncher(ctx.document),
    "hidden header hook did not remove its launcher",
  );
  assert.equal(ctx.launcher().hidden, false);
  ctx.host.remove();
  await delay(0);
  assert.ok(ctx.intersections.every((observer) => observer.targets.size === 0));
  const replacement = addVisibleHeader(ctx.document);
  await delay(20);
  assert.equal(
    !!replacement.search.parentElement.nextElementSibling?.hasAttribute(
      "data-roman-header-launcher",
    ),
    false,
    "a removed app embed must not retain a header observer",
  );
});

test("scrolling or opening the home view never shows the floating R without a conversation", async (t) => {
  const ctx = setup(t);
  assert.equal(
    ctx.launcher().hidden,
    true,
    "a missing header is not a session",
  );
  const { search } = addVisibleHeader(ctx.document);
  await until(
    () => !!headerButton(ctx.document),
    "header launcher did not attach",
  );
  const header = headerLauncher(ctx.document);
  ctx.setInView(search, false);
  ctx.window.dispatchEvent(new ctx.window.Event("scroll"));
  assert.equal(
    header.isConnected,
    true,
    "scrolling must not detach the inline trigger",
  );
  assert.equal(ctx.launcher().hidden, true);
  assert.equal(ctx.requests.length, 0);
  ctx.setInView(search, true);
  headerButton(ctx.document).click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "home runtime did not mount");
  ctx.setInView(search, false);
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(
    ctx.launcher().hidden,
    true,
    "sidebar visibility is not conversation activity",
  );
  mounts[0].setSessionActive(false);
  assert.equal(ctx.launcher().hidden, true);
});

test("active text or voice conversations float only offscreen and confirmed End hides the R immediately", async (t) => {
  const ctx = setup(t);
  const { search } = addVisibleHeader(ctx.document);
  await until(
    () => !!headerButton(ctx.document),
    "header launcher did not attach",
  );
  headerButton(ctx.document).click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  const trigger = headerButton(ctx.document);
  mounts[0].setSessionActive(true);
  assert.equal(ctx.launcher().hidden, true);
  ctx.setInView(search, false);
  assert.equal(ctx.launcher().hidden, false);
  assert.equal(headerButton(ctx.document), trigger);
  ctx.close().click();
  assert.equal(ctx.host.shadowRoot.activeElement, ctx.launcher());
  assert.equal(ctx.launcher().getAttribute("aria-expanded"), "false");
  ctx.launcher().click();
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  ctx.setInView(search, true);
  assert.equal(ctx.launcher().hidden, true);
  ctx.setInView(search, false);
  assert.equal(ctx.launcher().hidden, false);
  mounts[0].setSessionActive(false);
  assert.equal(ctx.launcher().hidden, true);
  ctx.setInView(search, true);
  ctx.setInView(search, false);
  assert.equal(
    ctx.launcher().hidden,
    true,
    "scrolling cannot restore an ended conversation",
  );
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].disposed, 0);
});

test("header replacement ignores old intersection notifications without restarting an active session", async (t) => {
  const ctx = setup(t);
  const first = addVisibleHeader(ctx.document);
  await until(
    () => !!headerButton(ctx.document),
    "header launcher did not attach",
  );
  headerButton(ctx.document).click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(() => mounts.length === 1, "runtime did not mount");
  mounts[0].setSessionActive(true);
  ctx.setInView(first.search, false);
  assert.equal(ctx.launcher().hidden, false);
  const replacement = addVisibleHeader(ctx.document);
  first.header.remove();
  await until(
    () =>
      replacement.search.parentElement.nextElementSibling ===
      headerLauncher(ctx.document),
    "header launcher did not rebind",
  );
  assert.equal(ctx.launcher().hidden, true);
  ctx.intersections[0].callback([
    { target: first.search, isIntersecting: false },
  ]);
  assert.equal(ctx.launcher().hidden, true);
  ctx.setInView(replacement.search, false);
  assert.equal(ctx.launcher().hidden, false);
  assert.equal(mounts.length, 1);
});

test("the actual React runtime keeps its rendered content and storefront state across close and reopen", async (t) => {
  const runtimeBundle = await build({
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
  let now = 0;
  const { document, window, host, launcher, close, progress, requests } = setup(
    t,
    (window) => {
      window.performance.now = () => now;
    },
  );
  launcher().click();
  window.eval(
    `${runtimeBundle.outputFiles[0].text}\nwindow.RomanAssistant = RomanAssistant;`,
  );
  const mountAssistant = window.RomanAssistant.mountAssistant;
  let mounts = 0;
  let disposals = 0;
  window.RomanAssistant = {
    mountAssistant(...args) {
      mounts++;
      const runtime = mountAssistant(...args);
      return {
        ...runtime,
        dispose() {
          disposals++;
          runtime.dispose();
        },
      };
    },
  };
  now = 1000;
  loadingScript(document).dispatchEvent(new window.Event("load"));
  await until(
    () => mounts === 1 && hidden(progress()),
    "React content never became ready",
  );
  const content = host.shadowRoot.querySelector("[data-roman-content]");
  const heading = content.querySelector("h1");
  const drawer = content.querySelector(".roman-tools");
  assert.ok(heading);
  assert.ok(drawer);
  assert.equal(window.location.href, `${origin}/`);
  close().click();
  launcher().click();
  await delay(0);
  assert.equal(mounts, 1);
  assert.equal(disposals, 0);
  assert.equal(content.querySelector("h1"), heading);
  assert.equal(content.querySelector(".roman-tools"), drawer);
  assert.equal(requests.length, 1);
  host.remove();
  await delay(0);
  assert.equal(disposals, 1);
});
