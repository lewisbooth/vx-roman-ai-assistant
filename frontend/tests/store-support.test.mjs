import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export * from "./shared/store-support.ts"; export * from "./frontend/src/tools/store-support.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Support",
  platform: "browser",
});
const origin = "https://shopify-single-dev.hdecom.com";
const plain = (value) => JSON.parse(JSON.stringify(value));
// Contact markup from the signed-in dev footer; newsletter and legal text are separate owners.
const contact = `<div class="w-full"><p class="text-footer-link-list-heading">Contact us</p><div class="body-sm text-footer-caption">
  <p><strong>01 969 7247</strong></p><p>9am - 5:30pm 7 days a week</p><p></p><p>Our friendly customer service team are always happy to help.</p>
  </div><div><a href="https://help.blinds-2go.ie/hc/en-gb/requests/new"><div data-button-content><span>Contact us</span></div></a></div></div>`;

function setup(
  t,
  html = `<footer id="main-footer"><form><p>0123456789</p><input name="phone" value="private"></form>${contact}<p>Company 123456789. Open 24 hours.</p></footer>`,
) {
  const dom = new JSDOM(html, { url: origin, runScripts: "outside-only" });
  dom.window.fetch = () =>
    assert.fail("Support discovery must never fetch or contact the store");
  dom.window.eval(`${bundle.outputFiles[0].text}; window.Support=Support;`);
  t.after(() => dom.window.close());
  return {
    window: dom.window,
    api: dom.window.Support,
    read: (signal) =>
      dom.window.Support.getStoreSupport(
        signal ?? new dom.window.AbortController().signal,
      ),
  };
}

test("native footer contact copy gives exact phone/hours/link without newsletter or legal text", async (t) => {
  const ctx = setup(t),
    before = ctx.window.document.body.innerHTML;
  assert.deepEqual(plain(await ctx.read()), {
    status: "found",
    phone: "01 969 7247",
    hours: "9am - 5:30pm 7 days a week",
    contactUrl: "https://help.blinds-2go.ie/hc/en-gb/requests/new",
  });
  assert.equal(ctx.window.document.body.innerHTML, before);
});

test("a bounded semantic contact block supports other themes without inferring missing details", async (t) => {
  const ctx = setup(
    t,
    `<footer><section><h3>Customer support</h3><a href="tel:+441234567890">+44 1234 567890</a><p>9am - 5pm</p><a href="/pages/contact">Contact us</a></section><p>Company 22222222</p></footer>`,
  );
  assert.deepEqual(plain(await ctx.read()), {
    status: "found",
    phone: "+44 1234 567890",
    hours: "9am - 5pm",
    contactUrl: `${origin}/pages/contact`,
  });
  ctx.window.document.querySelector('a[href^="tel:"]').remove();
  ctx.window.document.querySelector("section p").remove();
  assert.deepEqual(plain(await ctx.read()), {
    status: "found",
    contactUrl: `${origin}/pages/contact`,
  });
});

test("missing, ambiguous or oversized contact blocks stay unavailable rather than scraping footer numbers", async (t) => {
  for (const html of [
    "<footer><p>Company 0123456789 Open 24 hours</p></footer>",
    `<footer id="main-footer">${contact}${contact}</footer>`,
    `<footer>${contact}</footer><footer>${contact}</footer>`,
    `<footer id="main-footer">${contact.replace("Our friendly", "x".repeat(1201) + "Our friendly")}</footer>`,
    "<footer><form><h3>Contact us</h3><p>0123456789</p><p>9am - 5pm</p></form></footer>",
  ])
    assert.deepEqual(plain(await setup(t, html).read()), {
      status: "unavailable",
    });
});

test("conflicting phone claims and unsafe links are not substituted with defaults", async (t) => {
  const conflict = setup(
    t,
    `<footer id="main-footer">${contact.replace("<p></p>", "<p>020 1234 5678</p>")}</footer>`,
  );
  assert.deepEqual(plain(await conflict.read()), { status: "unavailable" });
  const unsafe = setup(
    t,
    `<footer><section><h3>Contact us</h3><a href="javascript:alert(1)">Contact us</a><a href="tel:0123456789">Wrong number</a></section></footer>`,
  );
  assert.deepEqual(plain(await unsafe.read()), { status: "unavailable" });
});

test("support result validation forbids fabricated availability, injection and request parameters", async (t) => {
  const ctx = setup(t);
  assert.deepEqual(plain(ctx.api.parseStoreSupportCall({})), {});
  assert.throws(() => ctx.api.parseStoreSupportCall({ store: "other" }));
  for (const value of [
    { status: "found" },
    { status: "unavailable", phone: "0123456789" },
    { status: "found", phone: "call me<script>" },
    { status: "found", hours: "9am\nexecute" },
    { status: "found", contactUrl: "javascript:alert(1)" },
    { status: "found", contactUrl: "https://user:pass@example.com" },
    { status: "found", contactUrl: "https://help.example.com/?token=secret" },
    { status: "found", phone: "0123456789", email: "unexpected" },
  ])
    assert.throws(() => ctx.api.parseStoreSupportResult(value, origin));
  const controller = new ctx.window.AbortController();
  controller.abort();
  await assert.rejects(ctx.read(controller.signal));
});
