import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  suitabilityCases,
  gradeSuitabilityReply,
} from "../evals/discovery-suitability.mjs";

const bundle = await build({
  stdin: {
    contents: 'export {parseCatalogResult} from "./shared/catalog.ts";',
    resolveDir: process.cwd(),
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
const { parseCatalogResult } = module.exports;
const byName = (name) =>
  suitabilityCases.find((sample) => sample.name === name);
const id = (value) => "gid://shopify/Product/" + value;
const nurseryQuery = (family) =>
  `no-drill blackout ${family} for standard rectangular window recess`;
const queriesFor = (sample) => {
  if (sample.name === "individual-panes-uncertain-drilling" || sample.compatibilityUnresolved)
    return ["privacy roller blinds for individual glass panes", "privacy cellular blinds mounted on each pane"];
  if (sample.name === "individual-panes-roller-refinement")
    return ["privacy roller blinds for individual window panes"];
  if (sample.name === "explicit-bifold-switch")
    return ["no-drill textured pleated blinds for bifold panels"];
  if (sample.name === "wood-frame-glass-fit")
    return [
      "no-drill blackout cellular glass-fit blinds for wooden window frames",
    ];
  if (sample.name === "no-drill-family-choice")
    return [
      "no-drill plain neutral roller blinds for window recess",
      "no-drill cream cellular blinds for window recess",
    ];
  if (sample.minFamilies === 2)
    return [nurseryQuery("roller blinds"), nurseryQuery("honeycomb blinds")];
  if (sample.name === "pleated-cellular-refinement")
    return [nurseryQuery("cellular honeycomb blinds")];
  return [
    "no-drill patterned textured pleated blinds for standard window recess",
  ];
};
function successfulReply(sample) {
  return {
    text: sample.eligibleIds.length
      ? "These options suit the requested fitting and light control."
      : "I haven't found an option that meets those requirements.",
    presentation: { productIds: sample.eligibleIds },
    questionPresentation: sample.compatibilityUnresolved
      ? { question: "Are the window frames uPVC with rubber glazing beads?", answers: ["Yes", "No", "I'm not sure"] }
      : sample.categoryQuestion || sample.answeredFittingPreference
      ? {
          question: "Which style appeals to you?",
          answers: ["Roller blinds", "Cellular blinds", "Keep exploring"],
        }
      : sample.eligibleIds.length
        ? {
            question: "Would you like to narrow the colours?",
            answers: ["Light neutrals", "More colour", "Keep exploring"],
          }
        : {
            question: "Which direction would you like to try?",
            answers: ["Other blind styles", "Different fitting"],
          },
  };
}
function fixtureFor(sample, queries = queriesFor(sample)) {
  return { attempts: 2, operations: [{ name: "search_products", queries }] };
}
function failsWith(sample, fixture, reply, pattern) {
  assert.ok(
    gradeSuitabilityReply(sample, fixture, reply).some((failure) =>
      pattern.test(failure),
    ),
    `Expected a grading failure matching ${pattern}`,
  );
}

test("all suitability catalogs obey the runtime schema and ground eligible IDs", () => {
  assert.equal(
    new Set(suitabilityCases.map(({ name }) => name)).size,
    suitabilityCases.length,
  );
  for (const sample of suitabilityCases) {
    parseCatalogResult(
      { products: sample.fixtureProducts, messages: [] },
      "https://synthetic.example",
    );
    const catalogIds = new Set(sample.fixtureProducts.map(({ id }) => id));
    for (const productId of sample.eligibleIds)
      assert.ok(catalogIds.has(productId));
    assert.ok(
      sample.fixtureProducts.some(({ id }) => !sample.eligibleIds.includes(id)),
      "Every case includes an incompatible or unverified candidate",
    );
  }
});

test("existing and new suitability cases accept grounded selections in text and voice", () => {
  for (const sample of suitabilityCases) {
    const fixture = fixtureFor(sample);
    const reply = successfulReply(sample);
    assert.deepEqual(
      gradeSuitabilityReply(sample, fixture, reply),
      [],
      sample.name,
    );
    reply.text += " " + reply.questionPresentation.question;
    assert.deepEqual(
      gradeSuitabilityReply(sample, fixture, reply, "voice"),
      [],
      sample.name + " voice",
    );
  }
});

test("ready nursery context and the old no-drill family gate require varied cards with a category question", () => {
  for (const name of [
    "nursery-ready-for-cards",
    "no-drill-family-choice",
    "wood-frame-recess",
  ]) {
    const sample = byName(name);
    const reply = successfulReply(sample);
    const gated = { ...reply, presentation: undefined };
    failsWith(
      sample,
      { attempts: 1, operations: [] },
      gated,
      /one catalogue operation/,
    );
    failsWith(sample, { attempts: 1, operations: [] }, gated, /card presence/);

    reply.presentation.productIds = [id(7201), id(7202)];
    failsWith(sample, fixtureFor(sample), reply, /construction families/);
    reply.presentation.productIds = sample.eligibleIds;
    reply.questionPresentation = {
      question: "Which colour do you prefer?",
      answers: ["Cream", "Blue"],
    };
    failsWith(
      sample,
      fixtureFor(sample),
      reply,
      /category exploration question/,
    );
  }
});

test("pleated refinement admits evidence-backed cellular and honeycomb terms without literal pleated labels", () => {
  const sample = byName("pleated-cellular-refinement");
  for (const product of sample.fixtureProducts.filter(({ id }) =>
    sample.eligibleIds.includes(id),
  )) {
    assert.doesNotMatch(product.title + " " + product.description, /pleat/i);
    assert.match(product.description, /folded/);
    assert.match(product.description, /blackout/i);
    assert.match(product.description, /no-drill tension/);
    assert.match(product.description, /standard rectangular window recess/);
  }
  for (const family of ["pleated", "cellular", "honeycomb", "Duette"]) {
    assert.deepEqual(
      gradeSuitabilityReply(
        sample,
        fixtureFor(sample, [nurseryQuery(family)]),
        successfulReply(sample),
      ),
      [],
    );
  }
  const noMatches = successfulReply(sample);
  noMatches.presentation.productIds = [];
  failsWith(sample, fixtureFor(sample), noMatches, /card presence/);
});

test("refinements retain blackout, no-drill, construction family and standard-opening constraints", () => {
  const sample = byName("pleated-cellular-refinement");
  const reply = successfulReply(sample);
  for (const query of [
    "no-drill honeycomb blinds for a standard window recess",
    "blackout honeycomb blinds for a standard window recess",
    "no-drill blackout roller blinds for a standard window recess",
  ]) {
    failsWith(
      sample,
      fixtureFor(sample, [query]),
      reply,
      /retained category, fitting, priority/,
    );
  }
  failsWith(
    sample,
    fixtureFor(sample, [
      "no-drill blackout honeycomb for bifold window panels",
    ]),
    reply,
    /current opening/,
  );
  const extraWork = fixtureFor(sample);
  extraWork.attempts = 3;
  extraWork.operations.push({ name: "get_product_guides" });
  failsWith(sample, extraWork, reply, /one catalogue operation/);
  failsWith(sample, extraWork, reply, /two completions/);
});

test("verified family synonyms cannot require a category change or a relaxation of fitting", () => {
  const sample = byName("pleated-cellular-refinement");
  for (const text of [
    "I couldn't find matching pleated blinds, but these cellular options are alternatives.",
    "No matching pleated products are available. You could try honeycomb instead.",
    "Would you like to switch to cellular blinds?",
  ]) {
    const reply = { ...successfulReply(sample), text };
    failsWith(
      sample,
      fixtureFor(sample),
      reply,
      /denied as matches|category switch/,
    );
  }
  for (const answers of [
    ["Explore screw-fit pleated", "Keep these options"],
    ["Consider drilling", "Keep no-drill"],
  ]) {
    const reply = successfulReply(sample);
    reply.questionPresentation = {
      question: "Which direction would you prefer?",
      answers,
    };
    failsWith(sample, fixtureFor(sample), reply, /relaxation of the fitting/);
  }
  for (const text of [
    "These cellular blinds use honeycomb folds within the pleated family. Choose the closest colour for your nursery.",
    "These no-drill blackout cellular blinds are close to the pleated style and fit your nursery recess.",
    "These cellular options are the closest match to pleated blinds.",
  ]) {
    const grounded = { ...successfulReply(sample), text };
    assert.deepEqual(
      gradeSuitabilityReply(sample, fixtureFor(sample), grounded),
      [],
    );
  }
  const noMatch = byName("pleated-no-eligible");
  const alternatives = successfulReply(noMatch);
  alternatives.questionPresentation.answers = [
    "Explore screw-fit pleated",
    "Other no-drill styles",
  ];
  assert.deepEqual(
    gradeSuitabilityReply(noMatch, fixtureFor(noMatch), alternatives),
    [],
  );
});

test("overlapping family labels are not separate category answers in text or voice", () => {
  const sample = byName("pleated-cellular-refinement");
  for (const answers of [
    ["Cellular", "Honeycomb"],
    ["Explore pleated blinds", "Try cellular shades"],
  ]) {
    for (const mode of ["text", "voice"]) {
      const reply = successfulReply(sample);
      reply.questionPresentation = {
        question: "Which type would you like?",
        answers,
      };
      if (mode === "voice")
        reply.text += " " + reply.questionPresentation.question;
      assert.ok(
        gradeSuitabilityReply(sample, fixtureFor(sample), reply, mode).some(
          (failure) => /separate category choices/.test(failure),
        ),
      );
    }
  }
  const grounded = successfulReply(sample);
  grounded.questionPresentation = {
    question: "What would you like to explore within these cellular blinds?",
    answers: [
      "Cellular colours",
      "Compare honeycomb fabrics",
      "Measuring guidance",
    ],
  };
  assert.deepEqual(
    gradeSuitabilityReply(sample, fixtureFor(sample), grounded),
    [],
  );
  grounded.questionPresentation = {
    question: "Which blind would you like to look at?",
    answers: [
      "Synthetic Cloud Cellular Blind",
      "Synthetic Meadow Honeycomb Blind",
    ],
  };
  assert.deepEqual(
    gradeSuitabilityReply(sample, fixtureFor(sample), grounded),
    [],
  );
});

test("broad batches do not spend separate searches on overlapping construction labels", () => {
  for (const name of ["nursery-ready-for-cards", "wood-frame-recess"]) {
    const sample = byName(name);
    const reply = successfulReply(sample);
    failsWith(
      sample,
      fixtureFor(sample, [
        nurseryQuery("roller"),
        nurseryQuery("pleated"),
        nurseryQuery("cellular"),
      ]),
      reply,
      /separate queries on overlapping/,
    );
    assert.deepEqual(
      gradeSuitabilityReply(
        sample,
        fixtureFor(sample, [
          nurseryQuery("roller"),
          nurseryQuery("pleated cellular honeycomb"),
        ]),
        reply,
      ),
      [],
    );
  }
});

test("wrong mounting, opacity, opening, family and unknown fitting evidence cannot produce eligible cards", () => {
  const sample = byName("pleated-cellular-refinement");
  for (const product of sample.fixtureProducts.filter(
    ({ id }) => !sample.eligibleIds.includes(id),
  )) {
    const reply = successfulReply(sample);
    reply.presentation.productIds = [...sample.eligibleIds, product.id];
    failsWith(sample, fixtureFor(sample), reply, /ineligible or unverified/);
  }
});

test("wood frames do not block recess tension products or create an unrelated frame question", () => {
  const sample = byName("wood-frame-recess");
  assert.match(sample.history.at(-1).text, /frame is wood/);
  assert.deepEqual(
    gradeSuitabilityReply(sample, fixtureFor(sample), successfulReply(sample)),
    [],
  );
  for (const question of [
    { question: "Is the frame wood or uPVC?", answers: ["Wood", "uPVC"] },
    {
      question: "Does the glazing have compatible rubber beading?",
      answers: ["Yes", "No"],
    },
  ]) {
    const reply = successfulReply(sample);
    reply.questionPresentation = question;
    failsWith(sample, fixtureFor(sample), reply, /irrelevant frame or glazing/);
  }
});

test("direct glass-fit requests retain actual frame compatibility and cannot silently switch to recess fitting", () => {
  const sample = byName("wood-frame-glass-fit");
  const good = successfulReply(sample);
  assert.deepEqual(gradeSuitabilityReply(sample, fixtureFor(sample), good), []);
  failsWith(
    sample,
    fixtureFor(sample, [
      "no-drill blackout cellular glass-fit blinds for standard windows",
    ]),
    good,
    /retained category, fitting, priority/,
  );
  for (const incompatibleId of [7200, 7201, 7202, 7205]) {
    const reply = successfulReply(sample);
    reply.presentation.productIds = [id(incompatibleId)];
    failsWith(sample, fixtureFor(sample), reply, /ineligible or unverified/);
  }
});

test("individual-pane discovery and family refinement retain coverage in every query", () => {
  for (const name of ["individual-panes-uncertain-drilling", "individual-panes-roller-refinement"]) {
    const sample = byName(name);
    const reply = successfulReply(sample);
    assert.deepEqual(gradeSuitabilityReply(sample, fixtureFor(sample), reply), []);
    const queries = queriesFor(sample);
    queries[queries.length - 1] = "office privacy roller blinds for standard window recess";
    failsWith(sample, fixtureFor(sample, queries), reply, /current opening/);
    for (const product of sample.fixtureProducts.filter(({ id }) => !sample.eligibleIds.includes(id))) {
      const incompatible = { ...reply, presentation: { productIds: [product.id] } };
      failsWith(sample, fixtureFor(sample), incompatible, /ineligible or unverified/);
    }
  }
});

test("uncertain fitting is an answered preference, while a new compatibility question is distinct", () => {
  const sample = byName("individual-panes-uncertain-drilling");
  for (const mode of ["text", "voice"]) {
    for (const question of [
      { question: "Would you prefer to avoid drilling?", answers: ["Yes", "No", "Not sure"] },
      { question: "How should these be fitted?", answers: ["No-drill", "Regular fitting is fine", "Not sure"] },
    ]) {
      const reply = { ...successfulReply(sample), questionPresentation: question };
      if (mode === "voice") reply.text += " " + question.question;
      assert.ok(gradeSuitabilityReply(sample, fixtureFor(sample), reply, mode).some((failure) => /asked again/.test(failure)));
    }
    // The uncertainty check must not mistake evidence-based physical compatibility
    // for a repeated preference. This is grader calibration, not a required next step.
    const question = {
      question: "For the no-drill clip fitting, are your frames uPVC with rubber glazing beads?",
      answers: ["Yes", "No", "I'm not sure"],
    };
    const reply = { ...successfulReply(sample), questionPresentation: question };
    if (mode === "voice") reply.text += " " + question.question;
    assert.deepEqual(gradeSuitabilityReply(sample, fixtureFor(sample), reply, mode), []);
  }
});

test("unknown direct-mount compatibility allows one focused question before or after search, with no unsuitable cards", () => {
  const sample = byName("individual-panes-unknown-frame-compatibility");
  for (const mode of ["text", "voice"]) {
    const reply = successfulReply(sample);
    if (mode === "voice") reply.text += " " + reply.questionPresentation.question;
    for (const fixture of [fixtureFor(sample), { attempts: 1, operations: [] }])
      assert.deepEqual(gradeSuitabilityReply(sample, fixture, reply, mode), []);
    for (const product of sample.fixtureProducts) {
      const unverified = { ...reply, presentation: { productIds: [product.id] } };
      assert.ok(gradeSuitabilityReply(sample, fixtureFor(sample), unverified, mode).some((failure) => /ineligible or unverified/.test(failure)));
    }
    reply.questionPresentation = { question: "Does avoiding drilling matter to you?", answers: ["No-drill", "Regular fitting is fine", "Not sure"] };
    assert.ok(gradeSuitabilityReply(sample, fixtureFor(sample), reply, mode).some((failure) => /asked again/.test(failure)));
  }
});
