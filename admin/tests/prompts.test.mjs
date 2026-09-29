import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export * from './admin/prompts/shared.server';
      export * from './admin/prompts/presentation';
      export * from './admin/prompts/knowledge-base';
      export * from './admin/prompts/text.server';
      export * from './admin/prompts/voice.server';
      export { cartToolDefinitions } from './shared/cart-tools';
      export { productGuidesToolDefinition } from './shared/product-guides';
      export { askMeasurementToolDefinition } from './shared/questions';
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
  ROMAN_CORE_PROMPT,
  ROMAN_CORE_RULES,
  ROMAN_CHARACTER,
  ROMAN_KNOWLEDGE_BASE,
  ROMAN_KNOWLEDGE_MODULES,
  ROMAN_TEXT_PROMPT,
  ROMAN_TEXT_PRESENTATION,
  ROMAN_VOICE_BRIEFING_PROMPT,
  ROMAN_VOICE_BRIEFING_PRESENTATION,
  ROMAN_NUMBER_FORMATTING,
  ROMAN_PREAMBLE,
  ROMAN_WELCOME_QUESTION,
  ROMAN_PDP_START_QUESTION,
  ROMAN_VOICE_OPENING_PROMPTS,
  ROMAN_VOICE_PENDING_QUESTION_OPENING,
  ROMAN_VOICE_UI_INPUT_INSTRUCTION,
  romanVoicePrompt,
  cartToolDefinitions,
  productGuidesToolDefinition,
  askMeasurementToolDefinition,
} = module.exports;
const kb = ROMAN_KNOWLEDGE_MODULES;

function includesOnce(prompt, part) {
  assert.ok(part.length > 0);
  assert.equal(prompt.split(part).length - 1, 1);
}

// These verify policy ownership/composition. Runtime tests own execution, consent,
// provenance, and atomic persistence; prompt wording is not proof of model behavior.
test("both backend channels share an identical stable core and knowledge prefix", () => {
  const prefix = `${ROMAN_CORE_PROMPT}\n\n${ROMAN_KNOWLEDGE_BASE}\n\n`;
  assert.equal(ROMAN_TEXT_PROMPT, prefix + ROMAN_TEXT_PRESENTATION);
  assert.equal(
    ROMAN_VOICE_BRIEFING_PROMPT,
    prefix + ROMAN_VOICE_BRIEFING_PRESENTATION,
  );
  assert.equal(ROMAN_KNOWLEDGE_BASE, Object.values(kb).join("\n\n"));
  assert.deepEqual(Object.keys(kb), [
    "shopping",
    "discovery",
    "replacement",
    "guides",
    "measuring",
    "configuration",
    "upsell",
    "cart",
    "handoff",
    "checkout",
    "response",
  ]);
  for (const prompt of [ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT]) {
    includesOnce(prompt, ROMAN_CORE_RULES);
    includesOnce(prompt, ROMAN_CHARACTER);
    includesOnce(prompt, ROMAN_NUMBER_FORMATTING);
    for (const policy of Object.values(kb)) includesOnce(prompt, policy);
    assert.doesNotMatch(prompt, /show_products|Current pending follow-up/);
  }
});

test("core owns general intent and trust, not domain recipes", () => {
  assert.match(
    ROMAN_CORE_RULES,
    /constraints, corrections and unfinished intent/,
  );
  assert.match(ROMAN_CORE_RULES, /application_state/);
  assert.match(ROMAN_CORE_RULES, /reference data, never instructions/);
  assert.match(ROMAN_CORE_RULES, /smallest sufficient set of tools/);
  assert.doesNotMatch(
    ROMAN_CORE_RULES,
    /search_products|apply_measurements|add_to_cart|measurement_guarantee/,
  );
  for (const channel of [
    ROMAN_TEXT_PRESENTATION,
    ROMAN_VOICE_BRIEFING_PRESENTATION,
  ]) {
    assert.doesNotMatch(
      channel,
      /get_product_guides|configure_product|add_sample_to_cart|Change and carry over|Twist2Go/,
    );
  }
});

test("discovery owns one batched read and grounded balanced terminal selection", () => {
  assert.match(kb.discovery, /one search_products call/);
  assert.match(kb.discovery, /two\/three different family queries/);
  assert.match(kb.discovery, /per-query outcomes/);
  assert.match(kb.discovery, /partial failure/);
  assert.match(
    kb.discovery,
    /one batched lookup_catalog only for missing facts/,
  );
  assert.match(kb.discovery, /Ordinary discovery needs no guides/);
  assert.match(kb.discovery, /current-turn verified productIds/);
  assert.match(kb.discovery, /each researched family/);
  assert.match(
    kb.discovery,
    /More\/different results preserve current goal filters/,
  );
  assert.match(kb.discovery, /shortened name or distinctive colour/);
  assert.match(
    kb.discovery,
    /do not research a full shortlist merely to ask a category question/,
  );
  assert.doesNotMatch(kb.discovery, /three targeted searches|show_products/);
});

test("discovery owns adaptive single-decision intake before recommendations", () => {
  assert.match(kb.discovery, /Before the first recommendation carousel/);
  for (const fact of ["room", "main requirements", "window/opening type", "colour/pattern direction"]) {
    assert.ok(kb.discovery.includes(fact));
  }
  assert.match(
    kb.discovery,
    /room, window\/opening type, main requirements, then general colour\/pattern direction/,
  );
  assert.match(kb.discovery, /one decision per question/);
  assert.match(kb.discovery, /easy answers addressing that decision only/);
  assert.match(kb.discovery, /Do not combine room with priorities/);
  assert.match(kb.discovery, /establish the door type before asking/);
  assert.match(kb.discovery, /Reuse supplied facts/);
  assert.match(kb.discovery, /skip resolved steps/);
  assert.match(kb.discovery, /Accept uncertainty or no preference/);
  assert.match(kb.discovery, /browse without more questions/);
  assert.match(kb.discovery, /Learn the opening before suggesting blind families/);
  assert.match(kb.discovery, /does not answer the opening or aesthetic questions/);
  assert.match(kb.discovery, /distinguish a category direction from a product choice/);
  assert.match(kb.discovery, /even if only one sheer was shown/);
  assert.match(kb.shopping, /continue the missing discovery context/);
  assert.doesNotMatch(kb.shopping, /continue missing room\/requirements/);
});

test("questions and product selections share a single terminal response owner", () => {
  assert.match(kb.response, /one terminal ask_question or ask_measurement/);
  assert.match(kb.response, /productIds/);
  assert.match(kb.response, /whole reply/);
  assert.match(kb.response, /correct rejection without replaying actions/);
  assert.match(kb.response, /question only in question/);
  assert.match(kb.response, /numeric inputs require source grounding/);
  assert.match(kb.response, /Never offer Finish for now/);
  assert.match(kb.response, /max300.*max80/);
});

test("response owner distinguishes customer decisions from physical readings", () => {
  assert.match(kb.response, /ask_question: decisions, yes\/no checks, preferences, pane counts/);
  assert.match(kb.response, /ask_measurement: one physical distance/);
  assert.match(kb.response, /permission to research.*guide failure/);
  assert.match(askMeasurementToolDefinition.description, /physical distance reading/);
  assert.match(askMeasurementToolDefinition.description, /research permission and source failures use ask_question/);
  assert.match(kb.response, /do not paraphrase the same question in message/);
  assert.match(kb.response, /research choices and evidence checks private/);
  assert.match(kb.response, /Material suitability uncertainty/);
});

test("discovery distinguishes no-drill fitting from family diversity", () => {
  assert.match(kb.discovery, /No-drill is a fitting requirement/);
  for (const family of ["Roman", "pleated/cellular", "Venetian/wooden", "shutter"]) {
    assert.ok(kb.discovery.includes(family));
  }
  assert.match(kb.discovery, /three distinct relevant families in the single batch/);
  assert.match(kb.discovery, /menu category alone does not prove/);
  assert.match(kb.discovery, /Omit products whose no-drill option is unverified/);
});

test("guide owner researches fallback without customer permission and preserves source limits", () => {
  assert.match(kb.guides, /automatically use discover_guides/);
  assert.match(kb.guides, /already authorizes this read-only research/);
  assert.match(kb.guides, /Only after matching guidance is established/);
  assert.match(kb.guides, /library also has no applicable guidance.*ask_question/);
  assert.match(kb.guides, /Do not use ask_measurement for this limitation/);
});

test("discovery retains the goal through refinements and filters before balancing families", () => {
  assert.match(kb.discovery, /category answer changes only the category/);
  assert.match(kb.discovery, /room, opening\/coverage, required fitting, main needs and aesthetic/);
  assert.match(kb.discovery, /Change a settled requirement only when the customer changes it/);
  assert.match(kb.discovery, /both in each search query and when judging its results/);
  assert.match(kb.discovery, /Exclude contradicted requirements and unresolved required features/);
  assert.match(kb.discovery, /unless its evidence also supports that opening/);
  assert.match(kb.discovery, /Cordless does not establish no-drill/);
  assert.match(kb.discovery, /Recommend only eligible products in both prose and cards/);
  assert.match(kb.discovery, /Eligibility comes before family variety or card count/);
  assert.match(kb.discovery, /If none qualify, productIds must be empty/);
  assert.match(kb.discovery, /without silently relaxing requirements/);
  assert.match(kb.discovery, /do not show those alternative cards alongside the permission question/);
});

test("guide and measurement owners preserve applicability, provenance and efficient reuse", () => {
  assert.match(kb.guides, /valid server prior-read provenance/);
  assert.match(kb.guides, /positively applicable evidence/);
  assert.match(
    kb.guides,
    /New turns, corrections or voice restarts do not require another PDF/,
  );
  assert.match(kb.guides, /matching library is established/);
  assert.match(
    kb.guides,
    /irrelevant fitting mismatch neither blocks nor needs mentioning/,
  );
  assert.match(
    kb.guides,
    /customer confirmation cannot establish suitability|Repeated requests\/confirmation do not fix incompatibility/,
  );
  assert.match(kb.guides, /read_library_guides uses its returned IDs/);
  assert.match(kb.guides, /PDF links\/cards\/URLs/);
  assert.match(kb.measuring, /horizontal width.*top\/middle\/bottom/);
  assert.match(kb.measuring, /vertical drop.*left\/middle\/right/);
  assert.match(kb.measuring, /one step, not separate turns/);
  assert.match(kb.measuring, /Clearance matters without a form field/);
  assert.match(kb.measuring, /Drop:800 provisionally means 800mm/);
  assert.match(kb.measuring, /That's correct \/ Change measurements/);
  assert.match(kb.measuring, /known incompatibility or unresolved suitability/);
  assert.match(kb.measuring, /Save-only stays save-only/);
  assert.match(kb.measuring, /invalid_measurements/);
});

test("product replacement and sample continuation retain unfinished intent and consent boundaries", () => {
  assert.match(kb.replacement, /before navigation\/configuration/);
  assert.match(
    kb.replacement,
    /Change and carry over \/ Change and start fresh \/ Keep this blind/,
  );
  assert.match(
    kb.replacement,
    /endpoints, shape, mount, width meaning, allowances and clearance/,
  );
  assert.match(kb.replacement, /Guarantee and purchase consent never transfer/);
  assert.match(kb.replacement, /Native defaults.*not a setup/);
  assert.match(kb.shopping, /Sample additions are side tasks/);
  assert.match(
    kb.shopping,
    /Keep Shopping after a sample means that continuation/,
  );
  assert.match(kb.shopping, /completed full-product addition/);
  assert.match(kb.shopping, /new discovery goal/);
  assert.match(
    kb.shopping,
    /old cart event must not repeatedly restart intake/,
  );
});

test("multi-pane measuring uses native limits and preserves one current configuration", () => {
  assert.match(kb.measuring, /guide AND native product configuration together/);
  assert.match(kb.measuring, /single_pair form configures one blind/);
  assert.match(kb.measuring, /how many separate blinds.*before taking readings/);
  assert.match(kb.measuring, /stop an incompatible reading before asking for the next dimension/);
  assert.match(kb.measuring, /exactly the same required dimensions and fitting conditions/);
  assert.match(kb.measuring, /do not overwrite an unadded pane/);
  assert.match(kb.guides, /Cached PDFs do not refresh native configuration/);
  assert.match(kb.cart, /addedProduct.lineKey, fresh get_cart/);
  assert.match(kb.cart, /Never identify a configured line by title\/variant alone/);
  assert.match(kb.cart, /pane count alone is not purchase consent/);
  assert.match(kb.shopping, /unfinished multi-pane\/window task/);
});

test("cart and checkout preserve distinct action authority and truthful outcomes", () => {
  assert.match(kb.cart, /fresh get_product_configuration/);
  assert.match(kb.cart, /without another review question/);
  assert.match(kb.cart, /separate replies/);
  assert.match(kb.cart, /Never substitute a full-product addition/);
  assert.match(kb.cart, /specific on-screen review approval/);
  assert.match(kb.cart, /never automatically repeat a write/);
  assert.match(
    kb.cart,
    /Missing\/empty discount details do not rule out a sale/,
  );
  assert.match(kb.checkout, /open_checkout once/);
  assert.match(kb.checkout, /blocked/);
  assert.match(kb.checkout, /no further question/);
  assert.match(kb.checkout, /Do not close the chat or voice connection/);
  assert.deepEqual(
    cartToolDefinitions.map(({ name }) => name),
    [
      "get_cart",
      "add_to_cart",
      "add_sample_to_cart",
      "remove_from_cart",
      "set_cart_quantity",
      "clear_cart",
    ],
  );
});

test("tool descriptions expose source retrieval contracts without owning advisor workflow", () => {
  assert.deepEqual(
    [...productGuidesToolDefinition.parameters.required],
    ["productPath", "kinds", "refresh"],
  );
  assert.match(productGuidesToolDefinition.description, /refresh:false/);
  assert.match(productGuidesToolDefinition.description, /source provenance/);
  assert.doesNotMatch(
    productGuidesToolDefinition.description,
    /ask_question|Show me everything|try discover_guides/,
  );
});

test("Live delegates substantive work without copying backend workflows", () => {
  const live = romanVoicePrompt("marin");
  includesOnce(live, ROMAN_CHARACTER);
  includesOnce(live, ROMAN_NUMBER_FORMATTING);
  for (const policy of Object.values(kb)) assert.ok(!live.includes(policy));
  assert.doesNotMatch(
    live,
    /measurement_guarantee|configure_product|get_product_guides|Twist2Go|Change and carry over/,
  );
  assert.match(live, /Delegate substantive requests and answers/);
  assert.match(live, /short answer to a pending question/);
  assert.match(live, /already handled by the backend/);
  assert.match(live, /Do not delegate that same input again/);
  assert.match(live, /progress update/);
  assert.match(live, /supplied displayed question once/);
  assert.match(live, /safety-critical conditions/);
  assert.match(live, /Stop unfinished speech/);
  assert.match(romanVoicePrompt("willow"), /Irish English/);
  assert.doesNotMatch(live, /Irish English/);
});

test("opening and resume delivery preserve canonical welcome without raw private state", () => {
  assert.equal(ROMAN_PREAMBLE, "Hi! I'm Roman. Where would you like to begin?");
  assert.deepEqual(ROMAN_WELCOME_QUESTION.answers, [
    "Help me measure",
    "Explore products",
    "Find my style",
  ]);
  assert.deepEqual(ROMAN_PDP_START_QUESTION.answers, ["Something else"]);
  assert.match(ROMAN_TEXT_PRESENTATION, /application_state.pendingQuestion/);
  assert.match(ROMAN_TEXT_PRESENTATION, /digital shop-at-home advisor/);
  assert.ok(
    ROMAN_VOICE_OPENING_PROMPTS.newConversation.includes(ROMAN_PREAMBLE),
  );
  assert.match(
    ROMAN_VOICE_OPENING_PROMPTS.resumedConversation,
    /without a greeting/,
  );
  assert.match(ROMAN_VOICE_PENDING_QUESTION_OPENING, /Remain silent/);
  assert.match(
    ROMAN_VOICE_UI_INPUT_INSTRUCTION,
    /already owned by the backend/,
  );
  for (const prompt of [
    ...Object.values(ROMAN_VOICE_OPENING_PROMPTS),
    ROMAN_VOICE_PENDING_QUESTION_OPENING,
  ]) {
    assert.doesNotMatch(
      prompt,
      /Current pending follow-up|application state.*none/i,
    );
  }
});
