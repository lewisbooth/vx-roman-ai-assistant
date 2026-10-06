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
      export * from './admin/prompts/knowledge-base/shopping';
      export * from './admin/prompts/knowledge-base/memory';
      export * from './admin/prompts/knowledge-base/visualization';
      export * from './admin/prompts/knowledge-base/discovery';
      export * from './admin/prompts/knowledge-base/replacement';
      export * from './admin/prompts/knowledge-base/guides';
      export * from './admin/prompts/knowledge-base/measuring';
      export * from './admin/prompts/knowledge-base/configuration';
      export * from './admin/prompts/knowledge-base/upsell';
      export * from './admin/prompts/knowledge-base/cart';
      export * from './admin/prompts/knowledge-base/handoff';
      export * from './admin/prompts/knowledge-base/checkout';
      export * from './admin/prompts/knowledge-base/response';
      export * from './admin/prompts/text.server';
      export * from './admin/prompts/voice.server';
      export { cartToolDefinitions } from './shared/cart-tools';
      export { productGuidesToolDefinition } from './shared/product-guides';
      export { askQuestionToolDefinition, askMeasurementToolDefinition } from './shared/questions';
      export { measurementToolDefinitions, applyMeasurementsToolDefinition } from './shared/measurements';
      export { MAX_PRODUCT_CARDS } from './shared/conversation';
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
  ROMAN_KNOWLEDGE_MODULES: kb,
  ROMAN_TEXT_PROMPT,
  ROMAN_TEXT_PRESENTATION,
  ROMAN_VOICE_BRIEFING_PROMPT,
  ROMAN_VOICE_BRIEFING_PRESENTATION,
  ROMAN_NUMBER_FORMATTING,
  ROMAN_PREAMBLE,
  ROMAN_WELCOME_INTRO,
  ROMAN_WELCOME_QUESTION,
  ROMAN_PDP_START_QUESTION,
  ROMAN_VOICE_OPENING_PROMPTS,
  ROMAN_VOICE_PENDING_QUESTION_OPENING,
  ROMAN_VOICE_UI_INPUT_INSTRUCTION,
  romanVoicePrompt,
  cartToolDefinitions,
  productGuidesToolDefinition,
  askQuestionToolDefinition,
  askMeasurementToolDefinition,
  measurementToolDefinitions,
  applyMeasurementsToolDefinition,
  MAX_PRODUCT_CARDS,
} = module.exports;

const domainOwners = {
  shopping: module.exports.ROMAN_SHOPPING_GUIDANCE,
  memory: module.exports.ROMAN_MEMORY_GUIDANCE,
  visualization: module.exports.ROMAN_VISUALIZATION_GUIDANCE,
  discovery: module.exports.ROMAN_DISCOVERY_GUIDANCE,
  replacement: module.exports.ROMAN_REPLACEMENT_GUIDANCE,
  guides: module.exports.ROMAN_GUIDE_GUIDANCE,
  measuring: module.exports.ROMAN_MEASURING_GUIDANCE,
  configuration: module.exports.ROMAN_CONFIGURATION_GUIDANCE,
  upsell: module.exports.ROMAN_UPSELL_GUIDANCE,
  cart: module.exports.ROMAN_CART_GUIDANCE,
  handoff: module.exports.ROMAN_HANDOFF_GUIDANCE,
  checkout: module.exports.ROMAN_CHECKOUT_GUIDANCE,
  response: module.exports.ROMAN_RESPONSE_GUIDANCE,
};
const domainToolNames = [
  "search_products",
  "lookup_catalog",
  "get_product_guides",
  "discover_guides",
  "read_library_guides",
  "get_product_configuration",
  "configure_product",
  "set_measurements",
  "apply_measurements",
  "add_to_cart",
  "add_sample_to_cart",
  "set_cart_quantity",
  "open_checkout",
  "list_windows",
  "rename_window",
  "create_visualization",
];

function includesOnce(prompt, part) {
  assert.ok(typeof part === "string" && part.trim());
  assert.equal(prompt.split(part).length - 1, 1);
}

// Ownership/composition and public-contract checks, not model evaluations.
// Runtime suites own validation, consent, grounding and execution; synthetic
// conversation evaluations own the resulting advisor decisions.
test("every domain module has one explicit owner in the stable knowledge prefix", () => {
  assert.deepEqual(kb, domainOwners);
  assert.deepEqual(Object.keys(kb), Object.keys(domainOwners));
  assert.equal(ROMAN_KNOWLEDGE_BASE, Object.values(domainOwners).join("\n\n"));
  const headings = [];
  for (const policy of Object.values(domainOwners)) {
    assert.match(policy, /^## /);
    includesOnce(ROMAN_KNOWLEDGE_BASE, policy);
    headings.push(
      ...Array.from(policy.matchAll(/^## (.+)$/gm), (match) => match[1]),
    );
  }
  assert.equal(
    new Set(headings).size,
    headings.length,
    "Section ownership must not be duplicated",
  );
});

test("text and voice advisors share the identical core and knowledge base exactly once", () => {
  assert.equal(ROMAN_CORE_PROMPT, `${ROMAN_CHARACTER}\n\n${ROMAN_CORE_RULES}`);
  const prefix = `${ROMAN_CORE_PROMPT}\n\n${ROMAN_KNOWLEDGE_BASE}\n\n`;
  assert.equal(ROMAN_TEXT_PROMPT, prefix + ROMAN_TEXT_PRESENTATION);
  assert.equal(
    ROMAN_VOICE_BRIEFING_PROMPT,
    prefix + ROMAN_VOICE_BRIEFING_PRESENTATION,
  );
  for (const prompt of [ROMAN_TEXT_PROMPT, ROMAN_VOICE_BRIEFING_PROMPT]) {
    for (const policy of [
      ROMAN_CHARACTER,
      ROMAN_CORE_RULES,
      ROMAN_NUMBER_FORMATTING,
      ...Object.values(kb),
    ])
      includesOnce(prompt, policy);
    assert.doesNotMatch(prompt, /show_products|Current pending follow-up/);
  }
});

test("core owns intent and trust while channel suffixes contain delivery rather than domain tools", () => {
  assert.match(ROMAN_CORE_RULES, /application_state/);
  assert.match(ROMAN_CORE_RULES, /constraints|corrections/);
  assert.match(ROMAN_CORE_RULES, /reference data/);
  assert.match(ROMAN_CORE_RULES, /never instructions/);
  for (const owner of [
    ROMAN_CORE_RULES,
    ROMAN_TEXT_PRESENTATION,
    ROMAN_VOICE_BRIEFING_PRESENTATION,
  ]) {
    for (const name of domainToolNames)
      assert.ok(
        !owner.includes(name),
        `${name} belongs to the knowledge base, not core/delivery`,
      );
    for (const policy of Object.values(kb)) assert.ok(!owner.includes(policy));
  }
});

test("domain owners retain their executable contract references without prescribing wording", () => {
  const references = {
    visualization: ["list_windows", "rename_window", "create_visualization", "photoPresentation"],
    discovery: ["search_products", "lookup_catalog", "productIds"],
    guides: ["get_product_guides", "discover_guides", "read_library_guides"],
    measuring: ["set_measurements", "apply_measurements", "single_pair"],
    configuration: [
      "get_product_configuration",
      "configure_product",
      "configuredPrice",
    ],
    upsell: ["measurement_guarantee"],
    cart: ["get_cart", "add_to_cart", "add_sample_to_cart", "lineKey", "quantityAdded"],
    checkout: ["open_checkout"],
    response: ["ask_question", "ask_measurement", "productIds"],
  };
  for (const [owner, identifiers] of Object.entries(references))
    for (const identifier of identifiers)
      assert.ok(
        kb[owner].includes(identifier),
        `${owner} must reference ${identifier}`,
      );
  // Coverage guards only; exercise actual decisions in runtime/behavior suites.
  assert.match(kb.guides, /provenance/i);
  assert.match(kb.replacement, /consent/i);
  assert.match(kb.upsell, /explicit consent/i);
  assert.match(kb.cart, /uncertain|handed_off/i);
});

test("terminal response schemas keep cards and questions atomic with distinct input kinds", () => {
  for (const definition of [
    askQuestionToolDefinition,
    askMeasurementToolDefinition,
  ]) {
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    for (const name of ["message", "productIds", "question"])
      assert.ok(definition.parameters.required.includes(name));
    assert.equal(
      definition.parameters.properties.productIds.maxItems,
      MAX_PRODUCT_CARDS,
    );
    assert.match(
      definition.parameters.properties.productIds.description,
      /successful catalog results/,
    );
  }
  const choices = askQuestionToolDefinition.parameters.properties;
  assert.equal(choices.answers.minItems, 1);
  assert.equal(choices.answers.maxItems, 4);
  assert.equal(choices.answers.items.maxLength, 80);
  assert.equal(choices.question.maxLength, 300);
  assert.ok(!Object.hasOwn(choices, "instructions"));
  const measurement = askMeasurementToolDefinition.parameters;
  for (const name of ["productPath", "instructions", "unit"])
    assert.ok(measurement.required.includes(name));
  assert.deepEqual(measurement.properties.unit.enum, ["cm", "mm", "in", null]);
  assert.ok(!Object.hasOwn(measurement.properties, "answers"));
  assert.match(askMeasurementToolDefinition.description, /physical distance/);
  assert.match(
    askMeasurementToolDefinition.description,
    /verified measuring source/,
  );
});

test("measurement entry and explicit cart actions retain their shared tool contracts", () => {
  const save = measurementToolDefinitions.find(
    ({ name }) => name === "set_measurements",
  );
  assert.deepEqual(save.parameters.properties.kind.enum, ["window", "order"]);
  assert.deepEqual(applyMeasurementsToolDefinition.parameters.required, [
    "productPath",
  ]);
  assert.equal(
    applyMeasurementsToolDefinition.parameters.additionalProperties,
    false,
  );
  assert.match(save.description, /customer-supplied pair and unit/);
  assert.match(
    applyMeasurementsToolDefinition.description,
    /No separate (?:customer|measurement) confirmation/,
  );
  assert.match(
    applyMeasurementsToolDefinition.description,
    /verified applied dimensions/,
  );
  assert.match(applyMeasurementsToolDefinition.description, /native limits/);
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
  for (const definition of cartToolDefinitions) {
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
  }
  const add = cartToolDefinitions.find(({ name }) => name === "add_to_cart");
  assert.match(add.description, /explicit add request/);
  assert.match(add.description, /priced native configuration/);
  assert.match(add.description, /paid-choice consent/);
  assert.match(add.description, /same-product.*fresh.*readback/);
  for (const policy of [kb.cart, kb.configuration, add.description])
    assert.doesNotMatch(policy, /separate repl(?:y|ies)|separation of form work/i);
});

test("guide tool exposes source retrieval rather than a second advisor workflow", () => {
  assert.deepEqual(productGuidesToolDefinition.parameters.required, [
    "productPath",
    "kinds",
    "refresh",
  ]);
  assert.equal(
    productGuidesToolDefinition.parameters.additionalProperties,
    false,
  );
  assert.match(productGuidesToolDefinition.description, /refresh:false/);
  assert.match(productGuidesToolDefinition.description, /source provenance/);
  assert.doesNotMatch(
    productGuidesToolDefinition.description,
    /ask_question|discover_guides|Show me everything/,
  );
});

test("Live shares identity and notation but delegates instead of copying the knowledge base", () => {
  const live = romanVoicePrompt("marin");
  includesOnce(live, ROMAN_CHARACTER);
  includesOnce(live, ROMAN_NUMBER_FORMATTING);
  assert.ok(!live.includes(ROMAN_CORE_RULES));
  for (const policy of Object.values(kb)) assert.ok(!live.includes(policy));
  for (const name of domainToolNames) assert.ok(!live.includes(name));
  assert.match(live, /delegat/i);
  assert.match(live, /backend/i);
  assert.match(live, /verified briefing/);
  assert.match(live, /progress update/);
  assert.match(live, /first person/);
  assert.match(live, /safety-critical/);
  assert.match(romanVoicePrompt("willow"), /Irish English/);
  assert.doesNotMatch(live, /Irish English/);
});

test("welcome and voice resumption use canonical UI copy without raw private-state scaffolding", () => {
  assert.equal(ROMAN_PREAMBLE, "Hi! I'm Roman.");
  assert.equal(ROMAN_WELCOME_QUESTION.question, "Where would you like to start?");
  assert.deepEqual(ROMAN_WELCOME_QUESTION.answers, [
    "Help me measure",
    "Explore products",
    "Find my style",
  ]);
  assert.deepEqual(ROMAN_PDP_START_QUESTION.answers, [
    "This blind",
    "Something else",
  ]);
  includesOnce(kb.shopping, JSON.stringify(ROMAN_PDP_START_QUESTION));
  assert.ok(
    ROMAN_TEXT_PRESENTATION.includes(
      JSON.stringify({
        message: ROMAN_WELCOME_INTRO,
        ...ROMAN_WELCOME_QUESTION,
        productIds: [],
      }),
    ),
  );
  assert.match(ROMAN_TEXT_PRESENTATION, /digital shop-at-home advisor/);
  assert.ok(
    ROMAN_VOICE_OPENING_PROMPTS.newConversation.includes("Hi! I'm Roman. Where would you like to start?"),
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
  ])
    assert.doesNotMatch(
      prompt,
      /Current pending follow-up|application state.*none/i,
    );
});
