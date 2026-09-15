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
      data-script-url="${runtimeUrl}" data-logo-url="/roman-logo.svg"></roman-ai-assistant></body></html>`,
    { url, runScripts: "outside-only", pretendToBeVisual: true },
  );
  const { window } = dom;
  const { document } = window;
  const requests = [];
  const logs = [];
  const errors = [];
  const warnings = [];
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
    mountAssistant(host, container, loadingStartedAt) {
      const content = window.document.createElement("p");
      content.textContent = "Runtime content";
      container.append(content);
      const mount = {
        host,
        container,
        content,
        loadingStartedAt,
        open: [],
        disposed: 0,
      };
      mounts.push(mount);
      return {
        ready: readiness(mounts.length),
        setOpen: (open) => mount.open.push(open),
        dispose: () => {
          mount.disposed++;
          content.remove();
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
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
    false,
  );
  assert.equal(window.history.length, 1);
  button.click();
  assert.equal(hidden(panel()), false);
  assert.equal(panel().tagName, "SECTION");
  assert.equal(panel().getAttribute("aria-label"), "Roman AI Assistant");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(hidden(progress()), false);
  assert.equal(progress().getAttribute("aria-label"), "Loading Roman");
  assert.equal(
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
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

test("traditional navigation restores an open sidebar and starts a new runtime without stealing storefront focus", async (t) => {
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
  const search = next.document.getElementById("store-search");
  assert.equal(next.launcher().getAttribute("aria-expanded"), "true");
  assert.equal(hidden(next.panel()), false);
  assert.equal(hidden(next.progress()), false);
  assert.equal(
    next.document.documentElement.hasAttribute("data-roman-sidebar-open"),
    true,
  );
  assert.equal(next.document.activeElement, search);
  assert.ok(loadingScript(next.document));
  const newMounts = installRuntime(next.window);
  loadingScript(next.document).dispatchEvent(new next.window.Event("load"));
  await until(
    () => newMounts.length === 1 && hidden(next.progress()),
    "restored runtime did not become ready",
  );
  assert.equal(newMounts[0].open.at(-1), true);
  assert.equal(next.document.activeElement, search);
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
    next.document.documentElement.hasAttribute("data-roman-sidebar-open"),
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
    ctx.document.documentElement.hasAttribute("data-roman-sidebar-open"),
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

test("a cached page restore follows the latest saved visibility without moving focus or remounting", async (t) => {
  const ctx = setup(t);
  ctx.launcher().click();
  const mounts = installRuntime(ctx.window);
  loadingScript(ctx.document).dispatchEvent(new ctx.window.Event("load"));
  await until(
    () => mounts.length === 1 && hidden(ctx.progress()),
    "runtime did not become ready",
  );
  const search = ctx.document.createElement("input");
  ctx.document.querySelector("main").append(search);
  search.focus();
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
  assert.equal(ctx.document.activeElement, search);
  assert.equal(mounts[0].open.at(-1), false);
  assert.equal(
    ctx.document.documentElement.hasAttribute("data-roman-sidebar-open"),
    false,
  );
  ctx.window.sessionStorage.setItem(openStorageKey, "1");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(hidden(ctx.panel()), false);
  assert.equal(ctx.document.activeElement, search);
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
  assert.equal(
    hidden(progress()),
    false,
    "script arrival is not React readiness",
  );
  close().click();
  assert.equal(hidden(panel()), true);
  assert.equal(host.shadowRoot.activeElement, launcher());
  assert.equal(
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
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
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
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
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
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
    document.documentElement.hasAttribute("data-roman-sidebar-open"),
    false,
  );
  assert.equal(document.querySelector("style[data-roman-layout]"), null);
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
  const browse = content.querySelector('nav[aria-label="Browse store"]');
  assert.ok(heading);
  assert.ok(browse);
  assert.equal(
    browse.querySelector('a[aria-current="page"]').getAttribute("href"),
    "/",
  );
  assert.equal(window.location.href, `${origin}/`);
  close().click();
  launcher().click();
  await delay(0);
  assert.equal(mounts, 1);
  assert.equal(disposals, 0);
  assert.equal(content.querySelector("h1"), heading);
  assert.equal(content.querySelector('nav[aria-label="Browse store"]'), browse);
  assert.equal(requests.length, 1);
  host.remove();
  await delay(0);
  assert.equal(disposals, 1);
});
