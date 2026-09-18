import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/questions.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const {
  parseQuestionSelection,
  parseQuestionPart,
  askQuestionToolDefinition,
  parseMeasurementQuestionSelection,
  askMeasurementToolDefinition,
  formatMeasurementAnswer,
  isQuestionAnswer,
  latestQuestion,
  MEASUREMENT_CHANGE_UNITS,
  MEASUREMENT_STOP,
} = module.exports;
const selection = { question: "Which room?", answers: ["Bedroom", "Kitchen"] };

test("question selection is bounded, normalized and plain text with distinct answers", () => {
  assert.deepEqual(
    parseQuestionSelection({
      question: " Which room? ",
      answers: [" Bedroom ", "Kitchen"],
    }),
    selection,
  );
  for (const count of [1, 2, 3, 4])
    assert.equal(
      parseQuestionSelection({
        question: "Which?",
        answers: Array.from({ length: count }, (_, i) => `Choice ${i}`),
      }).answers.length,
      count,
    );
  for (const invalid of [
    null,
    [],
    { ...selection, extra: true },
    { question: "Which?" },
    { ...selection, question: " " },
    { ...selection, question: "x".repeat(301) },
    { ...selection, answers: [] },
    { ...selection, answers: ["a", "b", "c", "d", "e"] },
    { ...selection, answers: ["Bedroom", " bedroom "] },
    { ...selection, answers: [""] },
    { ...selection, answers: ["x".repeat(81)] },
    ...[
      "<b>Bedroom</b>",
      "**Bedroom**",
      "[Buy](https://shop.test)",
      "https://shop.test",
      "Hello\nagain",
      "a\u0000b",
    ].map((answer) => ({ ...selection, answers: [answer] })),
  ])
    assert.throws(() => parseQuestionSelection(invalid));
  assert.equal(askQuestionToolDefinition.name, "ask_question");
  assert.match(
    askQuestionToolDefinition.description,
    /Roman may also include its exact question in the written reply; duplication with the quick-answer widget is allowed/,
  );
  assert.match(
    askQuestionToolDefinition.description,
    /the application supplies fallback choices without another written question/,
  );
  assert.match(
    askQuestionToolDefinition.description,
    /In a voice briefing, provide this exact question once after the overview for Roman to say aloud/,
  );
  assert.equal(
    askQuestionToolDefinition.parameters.additionalProperties,
    false,
  );
});

const measurementCall = {
  question: "What is the width?",
  instructions: "Measure across the top of the recess without deductions.",
  productPath: "/products/roller-blind",
  label: "Width",
  unit: "mm",
};
const numeric = () => parseMeasurementQuestionSelection(measurementCall);

test("numeric questions preserve guide instructions, units and product without accepting arbitrary fields", () => {
  const expected = {
    question: measurementCall.question,
    answers: [],
    measurement: {
      instructions: measurementCall.instructions,
      productPath: measurementCall.productPath,
      label: "Width",
      unit: "mm",
    },
  };
  assert.deepEqual(numeric(), expected);
  for (const unit of ["cm", "mm", "in"])
    assert.equal(
      parseMeasurementQuestionSelection({ ...measurementCall, unit })
        .measurement.unit,
      unit,
    );
  for (const invalid of [
    { ...measurementCall, unit: "m" },
    { ...measurementCall, unit: null },
    { ...measurementCall, productPath: "/products/blind?variant=1" },
    { ...measurementCall, productPath: "https://other.test/products/blind" },
    { ...measurementCall, label: "x".repeat(41) },
    { ...measurementCall, label: "" },
    { ...measurementCall, instructions: "x".repeat(601) },
    { ...measurementCall, instructions: "**Measure** here" },
    { ...measurementCall, instructions: "" },
    { ...measurementCall, min: 30 },
    { ...measurementCall, sourceCallId: randomUUID() },
  ])
    assert.throws(() => parseMeasurementQuestionSelection(invalid));
  for (const invalid of [
    { ...expected, answers: ["Yes"] },
    { ...expected, measurement: null },
    { ...expected, measurement: { ...expected.measurement, max: 500 } },
    { ...expected, measurement: { ...expected.measurement, unit: "inch" } },
  ])
    assert.throws(() => parseQuestionSelection(invalid));
  const part = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...expected,
  };
  assert.deepEqual(parseQuestionPart(part), part);
  assert.deepEqual(
    parseQuestionPart({
      ...part,
      voiceReply: { voiceId: randomUUID(), afterSequence: 1 },
    }).measurement,
    expected.measurement,
  );
  assert.equal(
    askMeasurementToolDefinition.parameters.additionalProperties,
    false,
  );
  assert.deepEqual(
    askMeasurementToolDefinition.parameters.required.toSorted(),
    Object.keys(askMeasurementToolDefinition.parameters.properties).toSorted(),
  );
});

test("numeric answers validate exact label/unit and remain ordinary bounded customer messages", () => {
  for (const raw of ["0", "500", "500.25", ".5", "0.0001", "000.50"]) {
    const answer = formatMeasurementAnswer(numeric(), raw);
    assert.equal(answer, `Width: ${raw} mm`);
    assert.equal(isQuestionAnswer(numeric(), answer), true);
  }
  assert.equal(formatMeasurementAnswer(numeric(), " 500 "), "Width: 500 mm");
  for (const raw of [
    "",
    " ",
    "-1",
    "+1",
    "1e3",
    "1,000",
    "NaN",
    "Infinity",
    "1 2",
    "1.",
    "9007199254740992",
    "0".repeat(25),
  ])
    assert.throws(() => formatMeasurementAnswer(numeric(), raw));
  for (const answer of [
    "Width: 500 cm",
    "Drop: 500 mm",
    "Width:  500 mm",
    "Width: 500 mm ",
    "500",
    "Width: -1 mm",
    "Width: 1e3 mm",
  ])
    assert.equal(isQuestionAnswer(numeric(), answer), false);
  for (const answer of [MEASUREMENT_CHANGE_UNITS, MEASUREMENT_STOP])
    assert.equal(isQuestionAnswer(numeric(), answer), true);
  assert.equal(isQuestionAnswer(selection, "Bedroom"), true);
  assert.equal(isQuestionAnswer(selection, "Width: 500 mm"), false);
  assert.throws(() => formatMeasurementAnswer(selection, "500"));
  const longest = parseMeasurementQuestionSelection({
    ...measurementCall,
    label: "x".repeat(40),
  });
  assert.ok(
    formatMeasurementAnswer(longest, "0.1234567890123456789012").length <= 80,
  );
});

const questionMessage = (part) => ({
  role: "assistant",
  status: "complete",
  parts: [part],
});
const journey = (path, type = "page_view") => ({
  role: "context",
  status: "complete",
  parts: [{ type, path }],
});
test("measurement questions retire on replies or leaving their product, but retain same-product variant navigation", () => {
  const part = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...numeric(),
  };
  const messages = [questionMessage(part)];
  assert.equal(latestQuestion(messages), part);
  for (const path of [
    "/products/roller-blind",
    "/products/roller-blind?variant=123",
    "/en-gb/products/roller-blind/",
    "/collections/all/products/roller-blind",
    "https://shop.test/products/roller-blind",
  ])
    assert.equal(latestQuestion(messages, path), part);
  for (const path of [
    "/",
    "/cart",
    "/products/another-blind",
    "/collections/roller-blind",
  ])
    assert.equal(latestQuestion(messages, path), undefined);
  assert.equal(
    latestQuestion([...messages, journey("/products/another-blind")]),
    undefined,
  );
  assert.equal(
    latestQuestion([...messages, journey("/cart", "navigation")]),
    undefined,
  );
  assert.equal(
    latestQuestion([
      ...messages,
      journey("/cart"),
      journey("/products/roller-blind"),
    ]),
    undefined,
  );
  assert.equal(latestQuestion([journey("/cart"), ...messages]), part);
  assert.equal(
    latestQuestion([...messages, questionMessage({ type: "voice_event" })]),
    part,
  );
  assert.equal(
    latestQuestion([
      ...messages,
      { role: "user", status: "pending", parts: [] },
    ]),
    undefined,
  );
  const choice = { ...part, ...selection, measurement: undefined };
  assert.equal(
    latestQuestion([questionMessage(choice), journey("/cart")], "/"),
    choice,
  );
});

test("persisted questions reject malformed ownership and voice associations", () => {
  const part = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...selection,
  };
  assert.deepEqual(parseQuestionPart(part), part);
  const voiceReply = { voiceId: randomUUID(), afterSequence: 3 };
  assert.deepEqual(parseQuestionPart({ ...part, voiceReply }), {
    ...part,
    voiceReply,
  });
  for (const value of [
    { ...part, version: 2 },
    { ...part, invocationId: "bad" },
    { ...part, approved: true },
    ...[
      null,
      {},
      { ...voiceReply, voiceId: "bad" },
      { ...voiceReply, afterSequence: -1 },
      { ...voiceReply, afterSequence: 1.5 },
      { ...voiceReply, extra: true },
    ].map((voiceReply) => ({ ...part, voiceReply })),
  ])
    assert.throws(() => parseQuestionPart(value));
});
