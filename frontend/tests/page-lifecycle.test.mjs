import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const origin = "https://hd-dev-single.myshopify.com";
const bundle = await build({
  entryPoints: ["frontend/src/navigation/shared/page.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanPage",
  platform: "browser",
});

function page(path, content) {
  return `<!doctype html><html data-roman-preview="true"><head>
    <title>Store ${path}</title></head>
    <body class="template-${path === "/" ? "index" : "collection"}">
    <app-provider><header>Persistent header</header>
    <main id="main">${content}</main></app-provider>
    <roman-ai-assistant></roman-ai-assistant></body></html>`;
}

for (const initialPath of ["/", "/collections/all"]) {
  test(`collection constructors bind to the inserted page when navigating from ${initialPath}`, async (t) => {
    const dom = new JSDOM(
      page(
        initialPath,
        initialPath === "/"
          ? "<h1>Home</h1>"
          : '<section id="collection"><div product-grid-container class="loading">Old grid</div></section>',
      ),
      { url: origin + initialPath, runScripts: "outside-only" },
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    const previousMain = document.querySelector("main");
    const previousGrid = previousMain.querySelector("[product-grid-container]");
    const header = document.querySelector("header");
    const assistant = document.querySelector("roman-ai-assistant");
    let finishPricing;
    const pricingReady = new Promise((resolve) => {
      finishPricing = resolve;
    });
    const constructions = [];

    // The current HD facets constructor caches document.getElementById rather
    // than a relative query. Its initial-load handler later clears this grid.
    window.customElements.define(
      "facet-filters-form",
      class extends window.HTMLElement {
        constructor() {
          super();
          this.collectionSection = document.getElementById("collection");
          constructions.push({
            section: this.collectionSection,
            connected: this.isConnected,
            pathname: window.location.pathname,
            collectionTemplate: document.body.classList.contains(
              "template-collection",
            ),
          });
        }

        connectedCallback() {
          this.initialLoad = pricingReady.then(() => {
            this.collectionSection
              ?.querySelector("[product-grid-container]")
              ?.classList.remove("loading");
          });
        }
      },
    );
    window.eval(`${bundle.outputFiles[0].text}\nwindow.RomanPage = RomanPage;`);
    const destination = new URL("/collections/blackout-blinds", origin);
    const prepared = window.RomanPage.preparePage(
      page(
        destination.pathname,
        '<section id="collection"><facet-filters-form></facet-filters-form><collection-grid product-grid-container class="loading">New grid</collection-grid></section>',
      ),
      destination,
      { id: "test", prepare: () => ({}) },
    );
    assert.equal(constructions.length, 0, "preparation must remain inert");

    const { main } = window.RomanPage.commitPage(prepared, () => {
      assert.equal(
        constructions.length,
        0,
        "URL changes precede component construction",
      );
      window.history.pushState({}, "", destination.href);
    });
    const section = main.querySelector("#collection");
    const grid = section.querySelector("[product-grid-container]");
    const facets = section.querySelector("facet-filters-form");

    assert.deepEqual(constructions, [
      {
        section,
        connected: true,
        pathname: destination.pathname,
        collectionTemplate: true,
      },
    ]);
    assert.equal(main.ownerDocument, document);
    assert.equal(previousMain.isConnected, false);
    assert.equal(document.querySelector("header"), header);
    assert.equal(document.querySelector("roman-ai-assistant"), assistant);
    assert.equal(
      grid.classList.contains("loading"),
      true,
      "pricing still owns readiness",
    );

    finishPricing();
    await facets.initialLoad;
    assert.equal(
      grid.classList.contains("loading"),
      false,
      "the theme clears the new grid",
    );
    if (previousGrid) {
      assert.equal(
        previousGrid.classList.contains("loading"),
        true,
        "the old page is untouched",
      );
    }
  });
}
