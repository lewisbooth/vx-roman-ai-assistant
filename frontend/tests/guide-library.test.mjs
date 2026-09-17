import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export * from "./shared/guide-library.ts"; export * from "./frontend/src/tools/guide-library.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Library",
  platform: "browser",
});
const origin = "https://shopify-single-dev.hdecom.com";
const angled =
  "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/Angled_Bay_Guide-Roller_Blinds.pdf?v=1747062058";
const square =
  "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/Box-Bay_Roller.pdf?v=1747062808";
const plain = (value) => JSON.parse(JSON.stringify(value));

// Structural excerpt of the published libraries: one Shopify main section,
// h5/h6 headings and legacy nested main/layout tables inside .rte. Prose is synthetic.
function page(
  content = `<h5>Standard Windows</h5><p>First source paragraph.</p><p>Second source paragraph.</p>
  <table><tr><th>Blind type</th><th>Depth</th></tr><tr><td>Example</td><td>Consult its guide</td></tr></table>
  <table><tbody><tr><td><h5>Angled Bay Instructions</h5></td><td><h5>Square Bay Instructions</h5></td></tr>
  <tr><td><h3><img src="/angled.svg"></h3></td><td><img src="/square.svg"></td></tr>
  <tr><td><ul><li><a href="${angled}">Roller Blinds</a></li></ul></td>
  <td><ul><li><a href="${square}">Roller Blinds</a></li></ul></td></tr></tbody></table>`,
  title = "Blinds 2go Measuring Guide",
) {
  return `<!doctype html><html><head><base href="https://evil.example"><script>window.libraryExecuted=true</script></head><body>
  <nav><p>Never include navigation copy.</p><a href="${angled}">Wrong guide</a></nav>
  <app-provider><main id="main"><div class="shopify-section" id="shopify-section-template--123__breadcrumbs">Breadcrumbs</div>
  <div class="shopify-section" id="shopify-section-template--123__main"><div><h1>${title}</h1><div class="rte"><main>${content}</main></div></div></div>
  <div class="shopify-section" id="reviews"><p>Never include review copy.</p></div></main></app-provider>
  <footer><p>Never include footer copy.</p></footer></body></html>`;
}

function setup(t, options = {}) {
  const dom = new JSDOM(
    "<!doctype html><body><p>Current product stays here</p></body>",
    { url: `${origin}/products/example`, runScripts: "outside-only" },
  );
  const { window } = dom,
    calls = [];
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { TextEncoder, TextDecoder });
  window.fetch = async (...args) => {
    calls.push(args);
    return options.fetch
      ? options.fetch(...args)
      : new Response(options.html ?? page(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
  };
  window.eval(`${bundle.outputFiles[0].text}; window.Library=Library;`);
  t.after(() => window.close());
  return {
    window,
    api: window.Library,
    calls,
    read: (library = "blinds", signal = new window.AbortController().signal) =>
      window.Library.discoverGuides(library, signal),
  };
}

test("library discovery preserves paragraphs, table context and distinct bay-guide sections without navigation", async (t) => {
  const ctx = setup(t),
    before = ctx.window.document.body.innerHTML;
  const result = plain(await ctx.read());
  assert.equal(result.pagePath, "/pages/measuring-blinds");
  assert.equal(result.title, "Blinds 2go Measuring Guide");
  assert.deepEqual(
    result.sections.map((x) => x.title),
    ["Standard Windows", "Angled Bay Instructions", "Square Bay Instructions"],
  );
  assert.match(
    result.sections[0].text,
    /First source paragraph\.\n\nSecond source paragraph\./,
  );
  assert.match(
    result.sections[0].text,
    /Blind type \| Depth\n\nExample \| Consult its guide/,
  );
  assert.deepEqual(
    result.guides.map((x) => [
      x.title,
      x.url,
      result.sections.find((s) => s.id === x.section).title,
    ]),
    [
      ["Roller Blinds", angled, "Angled Bay Instructions"],
      ["Roller Blinds", square, "Square Bay Instructions"],
    ],
  );
  assert.match(result.diagramNotice, /not interpreted/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Never include|script|evil\.example/,
  );
  assert.equal(ctx.window.document.body.innerHTML, before);
  assert.equal(ctx.window.location.pathname, "/products/example");
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], `${origin}/pages/measuring-blinds`);
  assert.equal(ctx.calls[0][1].credentials, "same-origin");
  assert.equal(ctx.calls[0][1].redirect, "error");
  assert.deepEqual(
    plain(await ctx.read()),
    result,
    "IDs are deterministic for unchanged source content",
  );
});

test("curtain HTML is valid evidence without PDFs; inert extraction never upgrades elements or includes forms/scripts", async (t) => {
  const ctx = setup(t, {
    html: page(
      `<h5>Measuring the correct curtain width</h5><p>Source curtain paragraph.</p>
    <h6>Curtain poles</h6><p>Native pole instructions.</p><img src="https://tracking.example/image"><iframe src="https://tracking.example/frame"></iframe>
    <guide-tracker></guide-tracker><script>window.libraryExecuted=true</script><form><p>Private input</p></form>
    <template><p>Unused template</p></template><p hidden>Hidden text</p>`,
      "Measuring Curtains",
    ),
  });
  let constructions = 0;
  ctx.window.customElements.define(
    "guide-tracker",
    class extends ctx.window.HTMLElement {
      constructor() {
        super();
        constructions++;
      }
    },
  );
  const result = plain(await ctx.read("curtains"));
  assert.equal(result.pagePath, "/pages/measuring-curtains");
  assert.deepEqual(result.guides, []);
  assert.deepEqual(
    result.sections.map((x) => x.title),
    ["Measuring the correct curtain width", "Curtain poles"],
  );
  assert.equal(constructions, 0);
  assert.equal(ctx.window.libraryExecuted, undefined);
  assert.equal(ctx.calls.length, 1);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Private|Hidden|Unused|tracking|libraryExecuted/,
  );
});

test("only strict supported PDF links enter discovery, regardless of a document base URL", async (t) => {
  const ctx = setup(t, {
    html: page(`<h5>References</h5><p>
    <a href="/cdn/shop/files/local.pdf?v=12">Local guide</a>
    <a href="https://evil.example/a.pdf">Foreign</a><a href="javascript:alert(1)">Action</a>
    <a href="/cdn/shop/files/local.pdf?token=secret">Query</a><a href="/account">Account</a></p>`),
  });
  const result = plain(await ctx.read());
  assert.deepEqual(
    result.guides.map((x) => x.url),
    [`${origin}/cdn/shop/files/local.pdf?v=12`],
  );
  assert.doesNotMatch(JSON.stringify(result), /token=secret|javascript:/);
});

test("missing or ambiguous guide owners fail without falling back to unrelated page text", async (t) => {
  for (const html of [
    "<main id=main><h1>Login</h1></main>",
    page().replace("</app-provider>", `${page()}</app-provider>`),
    page().replace(
      '<div class="rte">',
      '<div class="rte"></div><div class="rte">',
    ),
    page().replace("<h1>", "<h1>Other</h1><h1>"),
  ]) {
    const ctx = setup(t, { html });
    await assert.rejects(ctx.read(), /unavailable or ambiguous/);
  }
});

test("ambiguous spanned heading columns cannot mislabel bay guide links", async (t) => {
  const ctx = setup(t, {
    html: page().replace(
      "<td><h5>Square Bay",
      '<td colspan="2"><h5>Square Bay',
    ),
  });
  await assert.rejects(ctx.read(), /ambiguous table layout/);
});

test("HTTP failures, unexpected redirects, types and oversized bodies cancel the response without returning partial instructions", async (t) => {
  for (const variant of [
    "status",
    "redirect",
    "url",
    "type",
    "length",
    "body",
  ]) {
    let cancelled = 0;
    const ctx = setup(t, {
      fetch: async () => ({
        ok: variant !== "status",
        redirected: variant === "redirect",
        url: variant === "url" ? `${origin}/password` : "",
        headers: new Headers({
          "content-type": variant === "type" ? "application/json" : "text/html",
          ...(variant === "length" ? { "content-length": "1048577" } : {}),
        }),
        body: {
          getReader: () => ({
            read: async () => ({
              done: false,
              value: new Uint8Array(variant === "body" ? 1048577 : 1),
            }),
            cancel: async () => {
              cancelled++;
            },
            releaseLock() {},
          }),
        },
      }),
    });
    await assert.rejects(ctx.read(), /could not be read|page limit/);
    assert.equal(cancelled, 1, variant);
  }
});

test("cancellation and deadline abort pending streams, with no result or lingering timeout", async (t) => {
  for (const cause of ["abort", "timeout"]) {
    let complete,
      cancelled = 0,
      deadline,
      cleared = 0;
    const ctx = setup(t, {
      fetch: async () => ({
        ok: true,
        redirected: false,
        url: "",
        headers: new Headers({ "content-type": "text/html" }),
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve) => {
                complete = resolve;
              }),
            cancel: async () => {
              cancelled++;
              complete?.({ done: true });
            },
            releaseLock() {},
          }),
        },
      }),
    });
    ctx.window.setTimeout = (callback, ms) => {
      assert.equal(ms, 10000);
      deadline = callback;
      return 1;
    };
    ctx.window.clearTimeout = () => {
      cleared++;
    };
    const controller = new ctx.window.AbortController();
    const pending = ctx.read("blinds", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    if (cause === "abort") controller.abort();
    else deadline();
    await assert.rejects(pending, /abort|timed out/i);
    assert.ok(cancelled >= 1);
    assert.equal(cleared, 1);
  }
  const ctx = setup(t),
    controller = new ctx.window.AbortController();
  controller.abort();
  await assert.rejects(ctx.read("blinds", controller.signal));
  assert.equal(ctx.calls.length, 0);
});

test("shared contracts reject forged section references, unsafe sources, extra inputs and excessive content", async (t) => {
  const ctx = setup(t),
    result = plain(await ctx.read());
  for (const value of [
    { library: "other" },
    { library: "blinds", url: "https://evil.example" },
    { library: "blinds", productPath: "/products/example" },
  ])
    assert.throws(() => ctx.api.parseGuideLibraryCall(value));
  const variants = [
    { ...result, pagePath: "/pages/other" },
    { ...result, diagramNotice: "All diagrams verified" },
    {
      ...result,
      guides: [{ ...result.guides[0], section: "s_" + "0".repeat(24) }],
    },
    { ...result, sections: [result.sections[0], result.sections[0]] },
    {
      ...result,
      sections: [{ ...result.sections[0], text: "a".repeat(8001) }],
    },
    {
      ...result,
      guides: [{ ...result.guides[0], url: "https://evil.example/guide.pdf" }],
    },
  ];
  for (const value of variants)
    assert.throws(() => ctx.api.parseGuideLibraryResult(value, origin));
  const parsed = ctx.api.parseGuideLibraryResult(result, origin);
  parsed.sections[0].title = "changed";
  assert.notEqual(result.sections[0].title, "changed");
  const large = {
    ...result,
    sections: Array.from({ length: 4 }, (_, index) => ({
      id: `s_${index.toString(16).padStart(24, "0")}`,
      title: "Source",
      text: "界".repeat(7_990),
    })),
    guides: Array.from({ length: 40 }, (_, index) => ({
      id: `g_${index.toString(16).padStart(24, "0")}`,
      title: "Source PDF",
      section: "s_" + "0".repeat(24),
      url: `${origin}/cdn/shop/files/${"a".repeat(1_000)}${index}.pdf`,
    })),
  };
  assert.throws(
    () => ctx.api.parseGuideLibraryResult(large, origin),
    /response byte budget/,
    "UTF-8 plus link metadata cannot exceed the result envelope",
  );
});
