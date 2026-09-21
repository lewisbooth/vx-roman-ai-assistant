import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/storefront-cart-notification.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "StorefrontCartNotification",
  platform: "browser",
});

function setup(t) {
  const dom = new JSDOM("<body><app-provider></app-provider></body>", {
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.CartNotification = StorefrontCartNotification;`,
  );
  const owner = window.CartNotification.createStorefrontCartNotification();
  t.after(() => {
    owner.dispose();
    dom.window.close();
  });
  const handled = [];
  const updates = [];
  let closes = 0;

  function install(provider) {
    provider.innerHTML = `<dynamic-pricing></dynamic-pricing>
      <modal-dialog id="cart-drawer-dialog" type="notification"></modal-dialog>
      <modal-dialog id="product-guide"></modal-dialog>`;
    const source = provider.querySelector("dynamic-pricing");
    const button = window.document.createElement("button");
    source.attachShadow({ mode: "open" }).append(button);
    const modal = provider.querySelector("#cart-drawer-dialog");
    const native = window.document.createElement("dialog");
    modal.attachShadow({ mode: "open" }).append(native);
    modal.modalIsOpen = false;
    modal.closeModal = () => {
      closes += 1;
      modal.dispatchEvent(new window.CustomEvent("modal-dialog::close", {
        bubbles: true,
        composed: true,
        detail: "cart-drawer-dialog",
      }));
    };
    provider.addEventListener("modal-dialog::close", (event) => {
      if (event.detail === "cart-drawer-dialog") {
        modal.modalIsOpen = false;
        native.open = false;
      }
    });
    provider.addEventListener("modal-dialog::open", (event) => {
      handled.push(event.detail);
      if (event.detail === "cart-drawer-dialog") {
        modal.modalIsOpen = true;
        native.open = true;
      }
    });
    provider.addEventListener("cart:updated", (event) => updates.push(event.detail));
    function request(id = "cart-drawer-dialog") {
      button.dispatchEvent(new window.CustomEvent("modal-dialog::open", {
        bubbles: true,
        composed: true,
        detail: id,
      }));
    }
    function add() {
      button.dispatchEvent(new window.CustomEvent("cart:updated", {
        bubbles: true,
        composed: true,
        detail: { item_count: updates.length + 1 },
      }));
      request();
    }
    return { provider, modal, native, request, add };
  }
  return {
    window,
    owner,
    handled,
    updates,
    install,
    get closes() { return closes; },
    ...install(window.document.querySelector("app-provider")),
  };
}

test("Roman blocks only cart notification promotion while native cart updates complete", (t) => {
  const { owner, add, native, handled, updates } = setup(t);
  owner.setOpen(true);
  add();
  add();
  assert.equal(native.open, false);
  assert.deepEqual(handled, []);
  assert.deepEqual(updates, [{ item_count: 1 }, { item_count: 2 }]);
});

test("closed Roman and disposed runtime preserve ordinary theme confirmation behavior", (t) => {
  const { owner, request, native, handled } = setup(t);
  request();
  assert.equal(native.open, true);
  owner.setOpen(true);
  assert.equal(native.open, false);
  request();
  assert.equal(native.open, false);
  owner.setOpen(false);
  request();
  assert.equal(native.open, true);
  owner.setOpen(true);
  owner.dispose();
  owner.setOpen(true);
  request();
  assert.equal(native.open, true);
  assert.equal(handled.length, 3);
});

test("opening Roman closes an existing cart notification through the theme context", (t) => {
  const ctx = setup(t);
  ctx.request();
  assert.equal(ctx.modal.modalIsOpen, true);
  ctx.owner.setOpen(true);
  assert.equal(ctx.modal.modalIsOpen, false);
  assert.equal(ctx.native.open, false);
  assert.equal(ctx.closes, 1);
  ctx.owner.setOpen(true);
  assert.equal(ctx.closes, 1, "Repeated state synchronization must not close twice");
  ctx.owner.setOpen(false);
  assert.equal(ctx.native.open, false, "Old notifications are not replayed on exit");
});

test("unrelated theme dialogs and non-theme events remain untouched", (t) => {
  const { owner, window, request, handled } = setup(t);
  owner.setOpen(true);
  request("product-guide");
  request("product-error");
  assert.deepEqual(handled, ["product-guide", "product-error"]);
  let outside = 0;
  window.document.body.addEventListener("modal-dialog::open", () => { outside += 1; });
  window.document.body.dispatchEvent(new window.CustomEvent("modal-dialog::open", {
    bubbles: true,
    detail: "cart-drawer-dialog",
  }));
  assert.equal(outside, 1);
});

test("delegation follows replacement theme shells without altering their markup", (t) => {
  const { owner, window, install, provider, handled } = setup(t);
  owner.setOpen(true);
  const replacement = window.document.createElement("app-provider");
  provider.replaceWith(replacement);
  const next = install(replacement);
  const before = replacement.innerHTML;
  next.request();
  assert.equal(next.native.open, false);
  assert.deepEqual(handled, []);
  assert.equal(replacement.innerHTML, before);
  owner.setOpen(false);
  next.request();
  assert.equal(next.native.open, true);
});

test("pages without the supported theme cart surface have no interception", (t) => {
  const { owner, modal, request, handled } = setup(t);
  modal.remove();
  owner.setOpen(true);
  request();
  assert.deepEqual(handled, ["cart-drawer-dialog"]);
});
