import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundled = await build({
  stdin: {
    contents: `export { ivoryLogo } from './frontend/brand-assets';
      export { brandLogoUrl } from './frontend/src/brand-logo';`,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { ivoryLogo, brandLogoUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

test("logo palette selection preserves Shopify cache identity and switches back", () => {
  for (const name of ["roman-logo", "roman-wordmark"]) {
    const source = `https://cdn.shopify.com/extensions/123/assets/${name}.svg?v=123&width=242`;
    const ivory = brandLogoUrl(source, true);
    assert.equal(ivory, source.replace(".svg?", "-ivory.svg?"));
    assert.equal(brandLogoUrl(ivory, true), ivory);
    assert.equal(brandLogoUrl(ivory, false), source);
    assert.equal(
      brandLogoUrl(`/src/assets/${name}.svg`, true),
      `/src/assets/${name}-ivory.svg`,
    );
  }
});

test("generated ivory logos preserve every path and the original gold star", async () => {
  for (const name of ["roman-logo", "roman-wordmark"]) {
    const source = await readFile(
      new URL(`../src/assets/${name}.svg`, import.meta.url),
      "utf8",
    );
    const original = new JSDOM(source, { contentType: "image/svg+xml" });
    const generated = new JSDOM(ivoryLogo(source), {
      contentType: "image/svg+xml",
    });
    const before = [...original.window.document.querySelectorAll("path")];
    const after = [...generated.window.document.querySelectorAll("path")];
    assert.equal(after.length, before.length);
    assert.equal(
      before.filter((path) => path.getAttribute("fill") === "#C59745").length,
      1,
    );
    for (const [index, path] of before.entries()) {
      const fill = path.getAttribute("fill");
      assert.equal(
        after[index].getAttribute("fill"),
        fill === "#4E0E0E" ? "#F7F5EF" : fill,
      );
      const expected = path.cloneNode(true);
      expected.setAttribute("fill", after[index].getAttribute("fill"));
      assert.equal(after[index].outerHTML, expected.outerHTML);
    }
    original.window.close();
    generated.window.close();
  }
});
