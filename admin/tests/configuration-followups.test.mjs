import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export { ROMAN_TEXT_PROMPT } from './admin/prompts/text.server';
      export { ROMAN_VOICE_BRIEFING_PROMPT } from './admin/prompts/voice.server';
      export { ROMAN_UPSELL_GUIDANCE } from './admin/prompts/knowledge-base/upsell';
    `,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const {
  ROMAN_TEXT_PROMPT,
  ROMAN_VOICE_BRIEFING_PROMPT,
  ROMAN_UPSELL_GUIDANCE,
} = module.exports;

for (const [channel, prompt] of [
  ["text", ROMAN_TEXT_PROMPT],
  ["voice", ROMAN_VOICE_BRIEFING_PROMPT],
]) {
  test(`${channel} configuration completion offers concrete native choices through the shared upsell policy`, () => {
    assert.equal(prompt.split(ROMAN_UPSELL_GUIDANCE).length - 1, 1);
    assert.match(
      prompt,
      /from the fresh get_product_configuration result, choose one or two useful available options that are not already selected or decided/,
    );
    assert.match(
      prompt,
      /include their returned option\.priceLabel when known/,
    );
    assert.match(
      prompt,
      /prefer these useful examples to a generic "Keep configuring" answer/,
    );
    assert.match(prompt, /Keep at most four answers in total/);
    assert.match(
      prompt,
      /"Add sample to cart" only when this fresh read returns actions\.sampleAvailable true/,
    );
    assert.match(
      prompt,
      /Omit Add product when required dimensions or choices are still missing/,
    );
    assert.doesNotMatch(prompt, /Use just these useful next actions/);
  });

  test(`${channel} suggestions preserve availability, brevity, declines and purchase consent`, () => {
    assert.match(
      prompt,
      /only candidates when this blind's current controls actually offer them/,
    );
    assert.match(
      prompt,
      /Do not re-offer a selected upgrade, resolved preference or declined extra/,
    );
    assert.match(prompt, /Missing price is unknown, never free/);
    assert.match(
      prompt,
      /An exploration answer does not authorize enabling a paid extra/,
    );
    assert.match(
      prompt,
      /requests that option: use configure_product under the normal fresh-read rules without another approval question/,
    );
    assert.match(prompt, /never authorizes adding the blind to the cart/);
    assert.match(
      prompt,
      /rather than adding a second sales paragraph or a list of every option/,
    );
    assert.match(
      prompt,
      /Resolve a selected paid guarantee before adding; accepting it alone does not authorize adding the full product/,
    );
    assert.match(
      prompt,
      /a concrete option choice follows the normal configuration rules and useful completion follow-ups/,
    );
  });
}
