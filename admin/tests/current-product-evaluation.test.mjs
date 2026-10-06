import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  currentProduct,
  currentProductCases,
  currentProductOrigin,
  currentProductPath,
  currentProductConfiguration,
  createCurrentProductFixture,
  gradeCurrentProductReply,
} from "../evals/current-product.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export {parseCatalogResult} from "./shared/catalog.ts"; export {parseNavigationResult} from "./shared/navigation-tool.ts"; export {parseProductConfigurationResult} from "./shared/product-configuration.ts";',
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
const { parseCatalogResult, parseNavigationResult, parseProductConfigurationResult } = module.exports;
const offer = currentProductCases.find(
  ({ currentProductFlow }) => currentProductFlow === "offer",
);
const accepted = currentProductCases.filter(
  ({ currentProductFlow }) => currentProductFlow === "accept",
);
const decline = currentProductCases.find(
  ({ currentProductFlow }) => currentProductFlow === "decline",
);
const discovery = currentProductCases.filter(
  ({ currentProductFlow }) => currentProductFlow === "discovery",
);

function productActions() {
  return {
    text: "",
    questionPresentation: {
      question:
        "Would you like help measuring, exploring options or ordering a sample?",
      answers: ["Help me measure", "Explore its options", "Add sample to cart"],
    },
  };
}

test("current-product histories preserve card/question provenance and distinguish a selected blind from the background page", () => {
  assert.equal(currentProductCases.length, 12);
  assert.equal(accepted.length, 3);
  for (const sample of currentProductCases) {
    const fixture = createCurrentProductFixture(sample);
    const state = JSON.parse(
      fixture.history.at(-1).text.slice("Application state: ".length),
    );
    assert.deepEqual(state.activeBlind, sample.activeProduct ? { path: currentProductPath, title: currentProduct.title } : null);
    assert.equal(state.backgroundPage.path, currentProductPath);
    assert.equal(state.pendingQuestion, null);
    if (["accept", "decline"].includes(sample.currentProductFlow)) {
      const card = JSON.parse(
        fixture.history
          .find(({ text }) => text.startsWith("Storefront history: "))
          .text.slice("Storefront history: ".length),
      )[0];
      assert.deepEqual(card.productRefs, [
        { id: currentProduct.id, title: currentProduct.title },
      ]);
      assert.ok(
        fixture.history.some(({ source }) => source === "roman_question"),
      );
    }
  }
  const cardHistory = accepted.find(({ name }) =>
    name.endsWith("-card"),
  ).history;
  assert.ok(
    cardHistory.some(({ text }) => text.startsWith("Carousel choice: ")),
  );
  const quickAnswer = accepted.find(({ name }) => name.endsWith("-answer"));
  assert.equal(quickAnswer.history.at(-1).text, "This blind");
});

test("offering grades exact identity and both quick answers against a similar decoy", async () => {
  assert.match(offer.history.at(-1).text, /measur/i);
  const fixture = createCurrentProductFixture(offer);
  const result = await fixture.execute("lookup", "search_products", {
    queries: [currentProduct.title],
  });
  parseCatalogResult(result, currentProductOrigin);
  assert.equal(result.products.length, 2);
  assert.notEqual(result.products[0].id, currentProduct.id);
  const reply = {
    text: "",
    presentation: { productIds: [currentProduct.id] },
    questionPresentation: {
      question: "Shall we start with this blind or something else?",
      answers: ["This blind", "Something else"],
    },
  };
  assert.deepEqual(gradeCurrentProductReply(offer, fixture, reply), []);
  reply.questionPresentation.answers = ["Something else"];
  assert.ok(
    gradeCurrentProductReply(offer, fixture, reply).some((failure) =>
      /both This blind/.test(failure),
    ),
  );
  reply.questionPresentation.answers = ["This blind", "Something else"];
  reply.presentation.productIds = [result.products[0].id];
  assert.ok(
    gradeCurrentProductReply(offer, fixture, reply).some((failure) =>
      /exactly the background product/.test(failure),
    ),
  );
});

test("style, find, explore and no-drill starts ignore an open product and ask missing discovery context", async () => {
  assert.equal(discovery.length, 4);
  for (const sample of discovery) {
    const fixture = createCurrentProductFixture(sample);
    const reply = {
      text: "",
      questionPresentation: sample.knownRoom
        ? {
            question: "What kind of opening are you covering?",
            answers: ["Standard window", "French doors", "Bifold doors"],
          }
        : {
            question: "Which room are the blinds for?",
            answers: ["Living room", "Bedroom", "Kitchen"],
          },
    };
    assert.deepEqual(
      gradeCurrentProductReply(sample, fixture, reply),
      [],
      sample.name,
    );
    const voice = { ...reply, text: reply.questionPresentation.question };
    assert.deepEqual(
      gradeCurrentProductReply(sample, fixture, voice, "voice"),
      [],
      sample.name + " voice",
    );
    const opening = {
      text: "",
      questionPresentation: {
        question: "What kind of opening are you looking to cover?",
        answers: [
          "Standard window",
          "Large window or patio door",
          "Individual glass panes",
          "Something else",
        ],
      },
    };
    assert.deepEqual(gradeCurrentProductReply(sample, fixture, opening), []);
    opening.text = opening.questionPresentation.question;
    assert.deepEqual(
      gradeCurrentProductReply(sample, fixture, opening, "voice"),
      [],
    );
    if (sample.knownRoom) {
      const restarted = {
        ...reply,
        questionPresentation: {
          question: "Which room is this for?",
          answers: ["Bedroom", "Living room"],
        },
      };
      assert.ok(
        gradeCurrentProductReply(sample, fixture, restarted).some((failure) =>
          /missing relevant fact/.test(failure),
        ),
      );
    }

    const offeredReply = {
      text: "",
      presentation: { productIds: [currentProduct.id] },
      questionPresentation: {
        question: "Would you like to start with this blind?",
        answers: ["This blind", "Something else"],
      },
    };
    assert.ok(
      gradeCurrentProductReply(sample, fixture, offeredReply).some((failure) =>
        /background-product lookup, offer or selection/.test(failure),
      ),
    );
    const narratedBackground = {
      ...reply,
      text: "The current blind on the page may suit you.",
    };
    assert.ok(
      gradeCurrentProductReply(sample, fixture, narratedBackground).some(
        (failure) => /ignore the background page/.test(failure),
      ),
    );
    const backgroundQuestion = {
      ...opening,
      questionPresentation: {
        question: "Would you like this blind for your room?",
        answers: ["Yes", "Something else"],
      },
    };
    assert.ok(
      gradeCurrentProductReply(sample, fixture, backgroundQuestion).some(
        (failure) => /ignore the background page/.test(failure),
      ),
    );
    for (const [name, input] of [
      ["search_products", { queries: [currentProduct.title] }],
      ["get_product", { id: currentProduct.id }],
      ["navigate", { path: currentProductPath }],
    ]) {
      const forbidden = createCurrentProductFixture(sample);
      await assert.rejects(forbidden.execute("background", name, input));
      assert.ok(
        gradeCurrentProductReply(sample, forbidden, reply).includes(
          forbidden.violations[0],
        ),
      );
    }
  }
});

test("all acceptance forms require exact navigation even on the already loaded background page", async () => {
  for (const sample of accepted) {
    const fixture = createCurrentProductFixture(sample);
    assert.ok(
      gradeCurrentProductReply(sample, fixture, productActions()).some(
        (failure) => /through navigation/.test(failure),
      ),
    );
    if (sample.name.endsWith("-name")) {
      const refreshed = await fixture.execute("refresh", "get_product", {
        id: currentProduct.id,
      });
      parseCatalogResult(refreshed, currentProductOrigin);
    }
    const result = await fixture.execute("select", "navigate", {
      path: currentProductPath,
    });
    parseNavigationResult(result);
    assert.deepEqual(
      gradeCurrentProductReply(sample, fixture, productActions()),
      [],
    );
    const spoken = productActions();
    spoken.text = spoken.questionPresentation.question;
    assert.deepEqual(
      gradeCurrentProductReply(sample, fixture, spoken, "voice"),
      [],
    );
    spoken.text = `You can order a sample. ${spoken.text}`;
    assert.ok(
      gradeCurrentProductReply(sample, fixture, spoken, "voice").some(
        (failure) => /separate sample announcement/.test(failure),
      ),
    );
    const sampleOnly = productActions();
    sampleOnly.text = "You can order a sample.";
    sampleOnly.questionPresentation.question =
      "What would you like to do next?";
    const sampleOnlyFailures = gradeCurrentProductReply(
      sample,
      fixture,
      sampleOnly,
    );
    assert.ok(
      sampleOnlyFailures.some((failure) =>
        /include measuring and options/.test(failure),
      ),
    );
    assert.ok(
      sampleOnlyFailures.some((failure) =>
        /separate sample announcement/.test(failure),
      ),
    );
    const restarted = productActions();
    restarted.questionPresentation.question = "Which room are the blinds for?";
    assert.ok(
      gradeCurrentProductReply(sample, fixture, restarted).some((failure) =>
        /restarted discovery/.test(failure),
      ),
    );
  }
});

test("declining continues missing discovery context without re-offering or acting on the product", () => {
  const fixture = createCurrentProductFixture(decline);
  const reply = {
    text: "",
    questionPresentation: {
      question: "Which room is this for?",
      answers: ["Living room", "Bedroom", "Kitchen"],
    },
  };
  assert.deepEqual(gradeCurrentProductReply(decline, fixture, reply), []);
  reply.questionPresentation.answers = ["This blind", "Something else"];
  assert.ok(
    gradeCurrentProductReply(decline, fixture, reply).some((failure) =>
      /offered again/.test(failure),
    ),
  );
});

test("unrequested searches, early selection, wrong paths and repeated navigation remain failures after model recovery", async () => {
  for (const [sample, name, input] of [
    [offer, "navigate", { path: currentProductPath }],
    [decline, "search_products", { queries: ["roller blinds"] }],
    [accepted[0], "search_products", { queries: ["Roman blinds"] }],
    [
      accepted[1],
      "navigate",
      { path: "/products/synthetic-woven-ivory-roller" },
    ],
    [accepted[2], "lookup_catalog", { ids: ["gid://shopify/Product/8201"] }],
    [accepted[0], "get_product_guides", { productPath: currentProductPath }],
    [accepted[0], "add_sample_to_cart", { productPath: currentProductPath }],
  ]) {
    const fixture = createCurrentProductFixture(sample);
    await assert.rejects(fixture.execute("forbidden", name, input));
    assert.equal(fixture.violations.length, 1);
    assert.ok(
      gradeCurrentProductReply(sample, fixture, productActions()).includes(
        fixture.violations[0],
      ),
    );
  }
  const fixture = createCurrentProductFixture(accepted[0]);
  await fixture.execute("select", "navigate", { path: currentProductPath });
  await assert.rejects(
    fixture.execute("repeat", "navigate", { path: currentProductPath }),
    /once/,
  );
});

test("Explore more blinds searches under retained requirements without replacing or configuring the active blind", async () => {
  const sample = currentProductCases.find(({ name }) => name === "selected-product-explore-more");
  assert.equal(sample.history.at(-1).text, "Explore more blinds");
  const fixture = createCurrentProductFixture(sample);
  const result = await fixture.execute("alternatives", "search_products", {
    queries: ["light neutral privacy roller blinds for standard window recess", "ivory privacy Venetian blinds for standard window recess"],
  });
  parseCatalogResult(result, currentProductOrigin);
  const reply = {
    text: "These give you different ways to balance daylight and privacy.",
    presentation: { productIds: result.products.map(({ id }) => id) },
    questionPresentation: { question: "Which style appeals to you?", answers: ["Roller", "Venetian", "More styles"] },
  };
  assert.deepEqual(gradeCurrentProductReply(sample, fixture, reply), []);
  assert.deepEqual(gradeCurrentProductReply(sample, fixture, { ...reply, text: reply.text + " " + reply.questionPresentation.question }, "voice"), []);
  const lostContext = { ...fixture, operations: [{ name: "search_products", input: { queries: ["roller blinds"] } }] };
  assert.ok(gradeCurrentProductReply(sample, lostContext, reply).some((failure) => /retained opening/.test(failure)));
  const restarted = { ...reply, questionPresentation: { question: "Which room is this for?", answers: ["Bedroom", "Kitchen"] } };
  assert.ok(gradeCurrentProductReply(sample, fixture, restarted).some((failure) => /restarted settled intake/.test(failure)));
  await assert.rejects(fixture.execute("wrong-flow", "get_product_configuration", { productPath: currentProductPath }));
  assert.ok(gradeCurrentProductReply(sample, fixture, reply).includes(fixture.violations[0]));
});

test("explicit and natural option requests read and explain selected-product choices without mutations or rediscovery", async () => {
  for (const sample of currentProductCases.filter(({ currentProductFlow }) => currentProductFlow === "explain-options")) {
    const fixture = createCurrentProductFixture(sample);
    const result = await fixture.execute("choices", "get_product_configuration", { productPath: currentProductPath });
    assert.deepEqual(result, currentProductConfiguration);
    parseProductConfigurationResult("get_product_configuration", result);
    const reply = {
      text: "You can choose light-filtering or blackout lining, with the control on the left or right.",
      questionPresentation: { question: "Which lining would you like?", answers: ["Light filtering", "Blackout, +£12"] },
    };
    assert.deepEqual(gradeCurrentProductReply(sample, fixture, reply), []);
    assert.deepEqual(gradeCurrentProductReply(sample, fixture, { ...reply, text: reply.text + " " + reply.questionPresentation.question }, "voice"), []);
    assert.ok(gradeCurrentProductReply(sample, fixture, { ...reply, presentation: { productIds: [currentProduct.id] } }).some((failure) => /show other products/.test(failure)));
    for (const [name, input] of [
      ["search_products", { queries: ["Roman blinds"] }],
      ["configure_product", { productPath: currentProductPath, configurationId: result.configurationId, controlId: "c0", optionId: "o1" }],
      ["get_product_configuration", { productPath: "/products/another-blind" }],
    ]) {
      const forbidden = createCurrentProductFixture(sample);
      await assert.rejects(forbidden.execute("wrong-flow", name, input));
      assert.ok(gradeCurrentProductReply(sample, forbidden, reply).includes(forbidden.violations[0]));
    }
  }
});
