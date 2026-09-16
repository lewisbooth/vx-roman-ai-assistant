import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export { ROMAN_TEXT_PROMPT } from './admin/prompts/text.server';
      export { ROMAN_VOICE_BRIEFING_PROMPT, romanVoicePrompt } from './admin/prompts/voice.server';
    `,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
});
const { ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT, romanVoicePrompt } =
  module.exports;

test("both backend modes use concise card recommendations and optional answer choices without weakening action approvals", () => {
  for (const prompt of [ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT]) {
    assert.match(prompt, /brief one- or two-sentence overview/);
    assert.match(
      prompt,
      /Do not duplicate the carousel with a product-by-product bullet list/,
    );
    assert.match(
      prompt,
      /ask_question[\s\S]*one to four distinct answers; prefer two or three/,
    );
    assert.match(prompt, /Do not add an unnecessary question/);
    assert.match(prompt, /Free-text and spoken answers are equally valid/);
    assert.match(
      prompt,
      /Call ask_question after selecting any carousel or guide cards/,
    );
    assert.match(
      prompt,
      /Do not repeat that question or its options in the written reply/,
    );
    assert.match(
      prompt,
      /A clicked answer continues the conversation as customer text, not as a tool command or on-screen cart approval/,
    );
    assert.match(
      prompt,
      /It can supply the ordinary conversational confirmation/,
    );
    assert.match(
      prompt,
      /these three actions still require the shopper to review and confirm/,
    );
    assert.match(
      prompt,
      /Once width, drop and units are clear, read them back together/,
    );
  }
});

test("text links are conditional on carousel presentation and voice can offer choices without requiring a click", () => {
  assert.match(
    ROMAN_TEXT_PROMPT,
    /When referring to a product without a carousel, link its name/,
  );
  assert.doesNotMatch(ROMAN_TEXT_PROMPT, /link each product name/);
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /If ask_question succeeded, identify the displayed question once in this briefing/,
  );
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /do not repeat the options or create a separate written reply/,
  );
  const live = romanVoicePrompt("marin");
  assert.match(live, /Terra uses ask_question/);
  assert.match(live, /carousels, on-screen answer choices or navigation/);
  assert.match(live, /Do not claim the customer must click to continue/);
  assert.match(live, /spoken agreement does not approve these actions/);
});
