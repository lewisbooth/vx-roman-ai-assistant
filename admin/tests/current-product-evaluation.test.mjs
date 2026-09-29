import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  currentProduct,
  currentProductCases,
  currentProductOrigin,
  currentProductPath,
  createCurrentProductFixture,
  gradeCurrentProductReply,
} from "../evals/current-product.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export {parseCatalogResult} from "./shared/catalog.ts"; export {parseNavigationResult} from "./shared/navigation-tool.ts";',
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
const { parseCatalogResult, parseNavigationResult } = module.exports;
const offer = currentProductCases.find(
  ({ currentProductFlow }) => currentProductFlow === "offer",
);
const accepted = currentProductCases.filter(
  ({ currentProductFlow }) => currentProductFlow === "accept",
);
const decline = currentProductCases.find(
  ({ currentProductFlow }) => currentProductFlow === "decline",
);

function productActions() {
  return {
    text: "",
    questionPresentation: {
      question: "What would you like to do with this blind?",
      answers: ["Help me measure", "Explore its options", "Add sample to cart"],
    },
  };
}

test("current-product histories preserve actual card/question/selection provenance without an active blind", () => {
  assert.equal(currentProductCases.length, 5);
  assert.equal(accepted.length, 3);
  for (const sample of currentProductCases) {
    const fixture = createCurrentProductFixture(sample);
    const state = JSON.parse(
      fixture.history.at(-1).text.slice("Application state: ".length),
    );
    assert.equal(state.activeBlind, null);
    assert.equal(state.backgroundPage.path, currentProductPath);
    assert.equal(state.pendingQuestion, null);
    if (sample.currentProductFlow !== "offer") {
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
