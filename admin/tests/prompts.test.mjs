import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export { ROMAN_TEXT_PROMPT } from './admin/prompts/text.server';
      export { ROMAN_VOICE_BRIEFING_PROMPT, ROMAN_VOICE_OPENING_PROMPTS, romanVoicePrompt } from './admin/prompts/voice.server';
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
const {
  ROMAN_TEXT_PROMPT,
  ROMAN_VOICE_BRIEFING_PROMPT,
  ROMAN_VOICE_OPENING_PROMPTS,
  romanVoicePrompt,
} = module.exports;

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
      /When it succeeds, keep a written text reply to a concise overview and do not end it with a question/,
    );
    assert.match(
      prompt,
      /A voice briefing instead supplies the displayed question once, with its exact wording, for Roman to say after the concise overview/,
    );
    assert.match(
      prompt,
      /Only end a written text reply with a direct question when you do not call ask_question/,
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
      /Once width, drop and units are clear, read them back together in ask_question/,
    );
    assert.match(
      prompt,
      /exactly two answers: "That's correct" and "Change measurements"/,
    );
    assert.match(prompt, /"Change measurements" does not confirm it/);
  }
});

test("text leaves a displayed question to its widget while voice says it once", () => {
  assert.match(
    ROMAN_TEXT_PROMPT,
    /When referring to a product without a carousel, link its name/,
  );
  assert.doesNotMatch(ROMAN_TEXT_PROMPT, /link each product name/);
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /If ask_question succeeded, include its displayed question exactly once after the factual overview so Roman can say it aloud/,
  );
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /call ask_question with that exact saved question and its saved concise answers/,
  );
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /Do not fetch the catalog, replay an action or create a new recommendation to resume it/,
  );
  assert.match(
    ROMAN_VOICE_BRIEFING_PROMPT,
    /Do not reword it, repeat it, add a second question or turn it into a written customer reply/,
  );
  const live = romanVoicePrompt("marin");
  assert.match(
    live,
    /delegate so the backend calls ask_question with the pair/,
  );
  assert.match(live, /exactly "That's correct" and "Change measurements"/);
  assert.match(live, /Delegate a choice-based clarification so its quick answers can appear/);
  assert.match(live, /carousels, on-screen answer choices or navigation/);
  assert.match(
    live,
    /say its displayed question once, with its exact wording, after the overview/,
  );
  assert.match(live, /Do not repeat, reword or add a second question/);
  assert.match(live, /short answer choices only when useful for the customer to choose/);
  assert.match(live, /Do not claim the customer must click to continue/);
  assert.match(live, /spoken agreement does not approve these actions/);
  assert.match(
    ROMAN_VOICE_OPENING_PROMPTS.resumedConversation,
    /If its last unanswered, unsuperseded follow-up is a saved question with Suggested answers, resume that exact question/,
  );
  assert.match(
    ROMAN_VOICE_OPENING_PROMPTS.resumedConversation,
    /do not fetch the catalog, replay an action or create another recommendation/,
  );
});

test("functional filters preserve unknown colour preferences and limited catalog coverage in both backend modes", () => {
  for (const prompt of [ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT]) {
    assert.match(
      prompt,
      /Confirming no-drill, full blackout or an inside\/recess fit does not choose a colour, pattern or style/,
    );
    assert.match(prompt, /blackout does not mean dark-coloured fabric/);
    assert.match(prompt, /without adding an unrequested colour/);
    assert.match(
      prompt,
      /sample, not evidence that it is the only matching product or colour available/,
    );
    assert.match(
      prompt,
      /make a focused range search[\s\S]*preserve the confirmed functional filters and verify each option/,
    );
    assert.match(
      prompt,
      /use ask_question for the next useful colour or style preference/,
    );
    assert.match(
      prompt,
      /These answers express preferences, not claims of availability/,
    );
    assert.match(
      prompt,
      /short overview and a small carousel of verified options before the question/,
    );
    assert.match(
      prompt,
      /Respect an existing colour preference or specific product choice[\s\S]*instead of reopening it or adding a style questionnaire to a configure\/fill request/,
    );
    assert.match(
      prompt,
      /A raw catalog count, casual product mention or unvetted choice is not enough/,
    );
  }
});

test("a selected sole recommendation opens its verified PDP before a follow-up in text and voice", () => {
  for (const prompt of [ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT]) {
    assert.match(
      prompt,
      /proactively open the product detail page in the same turn when either the customer explicitly selected or preferred one product, or you deliberately present exactly one specific, verified product as the sole recommendation/,
    );
    assert.match(prompt, /Navigate before continuing with a fitting or preference question/);
    assert.match(prompt, /A raw catalog count, casual product mention or unvetted choice is not enough/);
    assert.match(prompt, /do not navigate if it already identifies that product page/);
    assert.match(prompt, /Respect requests to stay in chat, continue comparing or decline navigation/);
  }
  assert.match(
    ROMAN_TEXT_PROMPT,
    /If presenting one selected recommendation, navigate to its verified PDP in that same turn before continuing with any fitting or preference question/,
  );
  const live = romanVoicePrompt("marin");
  assert.match(
    live,
    /When presenting exactly one specific selected recommendation, delegate so Terra navigates to its verified PDP in that same turn/,
  );
  assert.match(live, /A raw single search result is not a selected recommendation/);
  assert.match(live, /Respect a request to stay in chat or keep comparing/);
});

test("Live keeps functional requirements distinct from a chosen colour when presenting backend results", () => {
  const live = romanVoicePrompt("marin");
  assert.match(
    live,
    /No-drill, blackout and recess requirements do not establish a colour\/style preference or select a specific product/,
  );
  assert.match(
    live,
    /a sampled colourway does not establish that it is the only available option/,
  );
  assert.match(
    live,
    /use the backend's easy question and let the customer choose rather than assuming charcoal or another colour/,
  );
  assert.match(live, /Respect a product or style already chosen/);
});
