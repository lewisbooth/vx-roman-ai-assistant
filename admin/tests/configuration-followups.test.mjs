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
const { configuration, upsell, guides, measuring, memory, response, shopping, cart } = module.exports.ROMAN_KNOWLEDGE_MODULES;

test("configuration owns current-state dependencies and consumers reuse its evidence contract", () => {
  for (const identifier of ["get_product_configuration", "get_product_guides", "configure_product", "apply_measurements", "option.priceLabel", "configuredPrice", "actions.sampleAvailable"])
    assert.ok(configuration.includes(identifier), identifier);
  assert.match(configuration, /post-change configuration/);
  assert.match(configuration, /standalone read.*only/);
  assert.match(configuration, /controls AND choices/);
  assert.match(configuration, /parent relationships/);
  assert.match(configuration, /prerequisite/);
  assert.match(configuration, /Saved measurement readings and applied native dimensions are distinct/);
  assert.doesNotMatch(configuration, /After every.*read configuration again/);
  assert.match(guides, /without another configuration read/);
  assert.match(measuring, /verified post-change configuration under Product configuration/);
  // Behavioral dependency/price/polling cases live in configuration.mjs; this
  // test protects ownership and composition without prescribing reply wording.
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
  assert.match(upsell, /Leads are not proof/);
  assert.match(upsell, /Respect declines/);
  assert.match(upsell, /Product configuration owns paid-option consent/);
  assert.match(configuration, /Exploration alone does not/);
  assert.match(
    upsell,
    /measurement_guarantee requires explicit consent even if preselected/,
  );
  assert.match(upsell, /already accepted or declined/);
  assert.match(upsell, /current terms\/fee/);
  assert.match(upsell, /new window, product, guarantee fee or material terms/);
  assert.ok(upsell.includes("configuredPrice"));
  assert.ok(upsell.includes("feeBasis"));
  assert.match(upsell, /Guarantee acceptance alone is not purchase consent/);
});

test("continuity distinguishes customer pauses and retained declines from positive consent", () => {
  assert.match(memory, /latest request controls the reply/);
  assert.match(memory, /declined option.*customer constraint/);
  assert.match(memory, /positive paid-option consent/);
  assert.match(response, /explicit stop or pause/i);
  assert.doesNotMatch(response, /Never offer Finish for now\/goodbye\/pause/);
});

test("sample resumption keeps its task widget and requests direct Cart navigation at the shared contract", () => {
  assert.ok(shopping.includes("navigationActions"));
  assert.ok(cart.includes("navigationActions"));
  assert.match(shopping, /without submitting an answer/);
});
