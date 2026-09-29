import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  stdin: {
    contents:
      "export { ROMAN_KNOWLEDGE_MODULES } from './admin/prompts/knowledge-base';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", result.outputFiles[0].text)(
  module,
  module.exports,
);
const { configuration, upsell } = module.exports.ROMAN_KNOWLEDGE_MODULES;

test("configuration policy owns fresh-read nested option discovery and meaningful follow-ups", () => {
  assert.match(
    configuration,
    /After every successful option change or dimension application, read configuration again/,
  );
  assert.match(configuration, /newly revealed\/enabled controls/);
  assert.match(configuration, /meaningful decision/);
  assert.match(configuration, /option.priceLabel/);
  assert.match(configuration, /At most three.*one apply_measurements/);
  assert.match(
    configuration,
    /Add product to cart only if required fields are valid and priced/,
  );
  assert.match(configuration, /actions.sampleAvailable/);
  assert.match(
    configuration,
    /This invitation is not a required review before an explicit add request/,
  );
});

test("upsell policy separates research leads, paid choice consent and guarantee consent", () => {
  for (const lead of [
    "TotalShade",
    "BlockScreen",
    "Complete Blackout",
    "Electric Smartview",
    "ClickFIT",
    "Click2Shade",
    "Twist2Go",
    "Stick2Fit",
    "Stick On",
  ])
    assert.ok(upsell.includes(lead));
  assert.match(
    upsell,
    /not proof of stock, suitability, colour or category preference/,
  );
  assert.match(upsell, /Respect declines/);
  assert.match(upsell, /exploration does not authorize enabling a paid extra/);
  assert.match(
    upsell,
    /measurement_guarantee requires explicit consent even if preselected/,
  );
  assert.match(
    upsell,
    /Native preselection, confirmed dimensions and generic add agreement are not guarantee consent/,
  );
  assert.match(
    upsell,
    /new window, product, guarantee fee or material terms needs a new decision/,
  );
  assert.match(upsell, /configuredPrice excludes its separate cart charge/);
  assert.match(upsell, /Guarantee acceptance alone is not purchase consent/);
});
