import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  configurationCases,
  createConfigurationFixture,
  gradeConfigurationReply,
} from "../evals/configuration.mjs";

const bundle = await build({
  stdin: {
    contents: `
      export { parseProductConfigurationResult } from "./shared/product-configuration.ts";
      export { parseApplyMeasurementsResult, parseMeasurementToolResult } from "./shared/measurements.ts";
      export { StorefrontTurn, parseStorefrontCall } from "./admin/conversations/storefront-turn.server.ts";
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module, module.exports);
const {
  parseProductConfigurationResult,
  parseApplyMeasurementsResult,
  parseMeasurementToolResult,
  StorefrontTurn,
  parseStorefrontCall,
} = module.exports;

const byName = (name) => configurationCases.find((sample) => sample.name === name);
const completion = {
  text: "I entered 120cm × 180cm. The configured blind price is GBP 93.60.",
  questionPresentation: { question: "What would you like to do next?", answers: ["Explain blind options", "Change measurements"] },
};

async function enterPair(sample) {
  const fixture = createConfigurationFixture(sample);
  const productPath = fixture.productPath;
  const turn = new StorefrontTurn();
  for (const message of fixture.history) {
    if (!message.text.startsWith("Storefront action: ")) continue;
    const action = JSON.parse(message.text.slice("Storefront action: ".length));
    parseProductConfigurationResult(action.name, action.outcome);
  }
  const execute = async (callId, name, input) => {
    const call = parseStorefrontCall(name, input);
    turn.before(call);
    const raw = await fixture.execute(callId, name, call.arguments);
    const result = name === "get_product_configuration"
      ? parseProductConfigurationResult(name, raw)
      : name === "apply_measurements"
        ? parseApplyMeasurementsResult(raw)
        : parseMeasurementToolResult(raw);
    turn.after(call, result);
    return result;
  };
  const current = await execute("current", "get_product_configuration", { productPath });
  assert.deepEqual(current.controls.map(({ id }) => id), ["c0", "c1"]);
  assert.equal(turn.allows("configure_product"), true);
  await execute("save", "set_measurements", {
    productPath, ...sample.expected, kind: "order", mount: "recess",
  });
  const applied = await execute("enter", "apply_measurements", { productPath });
  assert.equal(applied.configuration.measurements.width, 120);
  assert.equal(applied.configuration.measurements.height, 180);
  assert.equal(applied.configuration.configuredPrice, "GBP 93.60");
  assert.equal(turn.isConfigurationCompletion("add_to_cart"), true,
    "the embedded post-state establishes fresh native configuration without another read");
  assert.doesNotThrow(() => turn.before(parseStorefrontCall("configure_product", {
    productPath,
    configurationId: applied.configuration.configurationId,
    controlId: "c1",
    optionId: "o1",
  })), "the post-state's canonical control IDs establish the next change capability");
  return fixture;
}

test("guarantee continuation fixtures reject malformed control IDs in reads and applied post-state", async () => {
  for (const name of ["memo-declined-guarantee-after-dimension-change", "changed-guarantee-fee-needs-new-decision"]) {
    const fixture = await enterPair(byName(name));
    const current = structuredClone(fixture.operations.find(({ name }) => name === "get_product_configuration").result);
    const applied = structuredClone(fixture.operations.find(({ name }) => name === "apply_measurements").result);
    current.controls[1].id = "c4";
    applied.configuration.controls[1].id = "c4";
    assert.throws(() => parseProductConfigurationResult("get_product_configuration", current), /Invalid product configuration control/);
    assert.throws(() => parseApplyMeasurementsResult(applied), /Invalid product configuration control/);
    for (const [toolName, outcome] of [["get_product_configuration", current], ["apply_measurements", applied]]) {
      const turn = new StorefrontTurn();
      const call = parseStorefrontCall(toolName, { productPath: fixture.productPath });
      turn.before(call);
      assert.throws(() => turn.after(call, outcome), /Invalid product configuration control/,
        `${toolName} must not accept a malformed fixture capability`);
    }
  }
});

test("a memo-only scoped guarantee decline survives later size entry without a new consent question", async () => {
  const sample = byName("memo-declined-guarantee-after-dimension-change");
  for (const mode of ["text", "voice"]) {
    const fixture = await enterPair(sample);
    assert.match(Object.values(fixture.memo)[0], /declined.*120\.00.*per blind/);
    assert.ok(fixture.history.every(({ text }) => !/declined|do not want measurement insurance/.test(text)));
    assert.deepEqual(gradeConfigurationReply({ ...sample, mode }, fixture, completion), []);
    const reopened = { ...completion, questionPresentation: {
      question: "Would you like to insure these measurements?",
      answers: ["Add guarantee (+GBP 120.00)", "No guarantee"],
    } };
    assert.ok(gradeConfigurationReply(sample, fixture, reopened).some((failure) => /decline was reopened/.test(failure)));
  }
});

test("the retained decline is scoped to disclosed terms and does not suppress a materially changed fee", async () => {
  const sample = byName("changed-guarantee-fee-needs-new-decision");
  const fixture = await enterPair(sample);
  const changed = { ...completion, questionPresentation: {
    question: "The guarantee fee is now GBP 130.00. Would you like it on these terms?",
    answers: ["Add guarantee (+GBP 130.00)", "No guarantee"],
  } };
  assert.deepEqual(gradeConfigurationReply(sample, fixture, changed), []);
  assert.ok(gradeConfigurationReply(sample, fixture, completion).some((failure) => /old scoped decline/.test(failure)));
  assert.ok(gradeConfigurationReply(sample, fixture, {
    ...changed, questionPresentation: { question: "Would you like the guarantee?", answers: ["Yes", "No"] },
  }).some((failure) => /current native fee/.test(failure)));
});

test("one clearance question combines the source threshold and unresolved obstructions in either channel", () => {
  for (const mode of ["text", "voice"]) {
    const sample = { ...byName("clearance-threshold-once"), mode };
    const fixture = createConfigurationFixture(sample);
    assert.match(fixture.history[0].text, /not checked.*depth.*handles.*obstructions/);
    assert.doesNotMatch(fixture.history[0].text, /\bno\b.*(?:handles|obstructions)/);
    assert.match(fixture.history.find(({ source }) => source === "guide_context").text,
      /75mm.*clear depth.*in front of.*handles.*obstructions/);
    const question = { question: "At the fitting point, is there at least 75mm of clear recess depth in front of any handles or other obstructions?", answers: ["Yes", "No", "Not sure"] };
    const reply = { text: mode === "voice" ? question.question : "", questionPresentation: question };
    assert.deepEqual(gradeConfigurationReply(sample, fixture, reply), []);
    const repeated = { ...reply, text: "This blind requires 75mm of clear depth. " + reply.text };
    assert.ok(gradeConfigurationReply(sample, fixture, repeated).some((failure) => /threshold.*repeated/.test(failure)));
    const introduction = { ...reply, text: "Let's walk through the measuring guide. " + reply.text };
    assert.ok(gradeConfigurationReply(sample, fixture, introduction).some((failure) => /introduced again/.test(failure)));
    for (const text of ["Do you have any window handles or obstructions?", "Is there at least 75mm of clear depth at the fitting point?"]) {
      const separate = { text: mode === "voice" ? text : "", questionPresentation: { ...question, question: text } };
      assert.ok(gradeConfigurationReply(sample, fixture, separate).some((failure) => /combine clear fitting depth/.test(failure)));
    }
    const splitQuestion = "Are there window handles or obstructions? Is there at least 75mm of clear depth at the fitting point?";
    const split = { text: mode === "voice" ? splitQuestion : "", questionPresentation: { ...question, question: splitQuestion } };
    assert.ok(gradeConfigurationReply(sample, fixture, split).some((failure) => /split into separate/.test(failure)));
    const thresholdInProse = { text: "The guide requires 75mm of clear depth.", questionPresentation: { ...question, question: "Is there clear fitting space in front of the handles or obstructions?" } };
    assert.ok(gradeConfigurationReply(sample, fixture, thresholdInProse).some((failure) => /threshold was missing from its decision/.test(failure)));
  }
});

test("a latest informational request overrides its pending reading and explains dimension-dependent choices", async () => {
  const sample = byName("explain-prerequisite-options-during-reading");
  const fixture = createConfigurationFixture(sample);
  const snapshot = await fixture.execute("read", "get_product_configuration", {
    productPath: "/products/synthetic-ivory-roman",
  });
  assert.equal(snapshot.controls[1].options.find(({ label }) => label === "Thermal interlining").available, false);
  const reply = {
    text: "Blackout lining blocks light; thermal interlining adds insulation. Both need measurements entered before they become selectable, and their charges are unknown until that quote is calculated.",
    questionPresentation: { question: "Would you like to continue measuring?", answers: ["Continue measuring", "Explain another option"] },
  };
  assert.deepEqual(gradeConfigurationReply(sample, fixture, reply), []);
  assert.ok(gradeConfigurationReply(sample, fixture, {
    text: "", questionPresentation: JSON.parse(fixture.history.at(-1).text.slice("Application state: ".length)).pendingQuestion,
  }).some((failure) => /paused physical reading/.test(failure)));
  assert.ok(gradeConfigurationReply(sample, fixture, {
    ...reply, text: "Blackout and thermal lining are unavailable.",
  }).some((failure) => /prerequisites/.test(failure)));
});
