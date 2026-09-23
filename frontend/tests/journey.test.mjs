import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/session/journey.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanJourneyTest",
  platform: "browser",
});

function setup(t) {
  const dom = new JSDOM(
    "<!doctype html><title>Store</title><app-provider><main id='main'><h1>  Roman   blinds </h1><input value='Private dimensions'></main></app-provider>",
    {
      url: "https://hd-dev-single.myshopify.com/products/roman?token=private#customer",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanJourneyTest = RomanJourneyTest;`,
  );
  let state = { conversation: null, restoring: false, availability: "available" };
  const listeners = new Set();
  const calls = [];
  const navigationState = { pending: false };
  const dispose = window.RomanJourneyTest.createJourneyObserver(
    {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      recordPage: async (page) => {
        calls.push(JSON.parse(JSON.stringify(page)));
      },
    },
    { getSnapshot: () => navigationState },
  );
  t.after(() => {
    dispose();
    window.close();
  });
  function update(change) {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  }
  function navigate(path, title = "Next page") {
    window.history.pushState({}, "", path);
    window.document.querySelector("h1").textContent = title;
    window.document.dispatchEvent(new window.CustomEvent("roman:navigation"));
  }
  return {
    window,
    calls,
    update,
    navigate,
    navigationState,
    dispose,
    listeners,
  };
}

test("journey starts with an active conversation and excludes query, fragment and input values", (t) => {
  const ctx = setup(t);
  ctx.navigate("/products/roman?token=private#customer", "  Roman   blinds ");
  assert.equal(ctx.calls.length, 0);
  ctx.update({
    conversation: { id: "one", status: "active" },
    restoring: true,
  });
  assert.equal(ctx.calls.length, 0);
  ctx.update({ restoring: false });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].title, "Roman blinds");
  assert.equal(ctx.calls[0].path, "/products/roman");
  assert.ok(Number.isFinite(Date.parse(ctx.calls[0].occurredAt)));
  assert.doesNotMatch(JSON.stringify(ctx.calls), /private|customer|dimensions/);
});

test("only committed page changes are recorded, including revisits, without duplicate snapshot events", (t) => {
  const ctx = setup(t);
  ctx.update({ conversation: { id: "one", status: "active" } });
  ctx.update({ pending: true });
  ctx.navigate("/products/roman?variant=123#description");
  assert.equal(ctx.calls.length, 1);
  ctx.navigationState.pending = true;
  ctx.window.history.pushState({}, "", "/collections/all");
  ctx.update({ pending: false });
  assert.equal(ctx.calls.length, 1);
  ctx.navigationState.pending = false;
  ctx.navigate("/collections/all", "All blinds");
  ctx.navigate("/products/roman", "Roman blinds");
  assert.deepEqual(
    ctx.calls.map((call) => call.path),
    ["/products/roman", "/collections/all", "/products/roman"],
  );
});

test("visits pause during suspension and the current page records once on recovery", (t) => {
  const ctx = setup(t);
  ctx.update({ conversation: { id: "one", status: "active" } });
  ctx.update({ availability: "suspended" });
  ctx.navigate("/collections/all", "All blinds");
  ctx.navigate("/products/other", "Other blinds");
  assert.deepEqual(ctx.calls.map((call) => call.path), ["/products/roman"]);
  ctx.update({ availability: "available" });
  assert.deepEqual(
    ctx.calls.map((call) => call.path),
    ["/products/roman", "/products/other"],
  );
  ctx.update({ pending: false });
  assert.equal(ctx.calls.length, 2);
});

test("End stops tracking, a new conversation starts fresh, and disposal removes all observers", (t) => {
  const ctx = setup(t);
  ctx.update({ conversation: { id: "one", status: "active" } });
  ctx.update({ conversation: { id: "one", status: "ended" } });
  ctx.navigate("/collections/all");
  assert.equal(ctx.calls.length, 1);
  ctx.update({ conversation: { id: "two", status: "active" } });
  assert.equal(ctx.calls.length, 2);
  ctx.dispose();
  ctx.navigate("/cart");
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  ctx.update({ conversation: { id: "three", status: "active" } });
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.listeners.size, 0);
});

test("BFCache records a return after credential restoration, with document-title fallback", (t) => {
  const ctx = setup(t);
  ctx.update({ conversation: { id: "one", status: "active" } });
  ctx.update({ restoring: true });
  ctx.window.document.querySelector("h1").remove();
  ctx.window.document.title = "Saved collection";
  ctx.window.dispatchEvent(
    new ctx.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  assert.equal(ctx.calls.length, 1);
  ctx.update({ restoring: false });
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].title, "Saved collection");
});

test("private Shopify pages are skipped before reading their title or submitting a visit", (t) => {
  const ctx = setup(t);
  ctx.update({ conversation: { id: "one", status: "active" } });
  const heading = ctx.window.document.querySelector("h1");
  Object.defineProperty(heading, "textContent", {
    configurable: true,
    get() {
      return assert.fail("Private page title was read");
    },
  });
  for (const path of [
    "/account",
    "/en/account/orders/123",
    "/%61ccount",
    "/checkouts/private",
    "/challenge",
    "/password",
  ]) {
    ctx.window.history.pushState({}, "", path);
    ctx.window.document.dispatchEvent(
      new ctx.window.CustomEvent("roman:navigation"),
    );
  }
  assert.equal(ctx.calls.length, 1);
  delete heading.textContent;
  ctx.navigate("/products/roman", "Roman blinds");
  assert.equal(
    ctx.calls.length,
    2,
    "Returning from an untracked page is a new storefront visit",
  );
});
