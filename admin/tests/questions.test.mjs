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
  parseQuestionCall,
  parseQuestionPart,
  askQuestionToolDefinition,
  parseMeasurementQuestionCall,
  askMeasurementToolDefinition,
  formatMeasurementAnswer,
  isQuestionAnswer,
  latestQuestion,
  MAX_QUESTION_ANSWER_LENGTH,
} = module.exports;
const selection = { question: "Which room?", answers: ["Bedroom", "Kitchen"] };

test("Cart navigation survives choice, measurement and historical part parsing without becoming a measurement answer", () => {
  const navigationActions = [{label: "View Cart", view: "cart"}];
  assert.deepEqual(parseQuestionCall({message: "Sample added.", productIds: [], ...selection, navigationActions}).navigationActions, navigationActions);
  const parsed = parseMeasurementQuestionCall({...measurementCall, navigationActions});
  assert.deepEqual(parsed.navigationActions, navigationActions);
  assert.equal(isQuestionAnswer(parsed, "View Cart"), false);
  const part = {type: "question", version: 1, invocationId: randomUUID(), ...parsed};
  delete part.message; delete part.productIds;
  assert.deepEqual(parseQuestionPart(part), part);
  assert.equal(parseQuestionSelection(selection).navigationActions, undefined);
  for (const invalid of [[{label: "View Cart", view: "checkout"}], [{label: "Buy", view: "cart"}], [...navigationActions, ...navigationActions], [{...navigationActions[0], extra: true}], null])
    assert.throws(() => parseQuestionSelection({...selection, navigationActions: invalid}));
});

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
    { ...selection, message: "A living room can need glare control." },
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
});

test("terminal question calls own context and question separately without changing stored question data", () => {
  assert.deepEqual(parseQuestionCall({ productIds: [], message: "", ...selection }), {
    message: "",
    productIds: [],
    ...selection,
  });
  assert.deepEqual(
    parseQuestionCall({
      productIds: [],
      message: "  **No-drill blinds** can help.\n\nLet's narrow it down.  ",
      ...selection,
    }),
    {
      message: "**No-drill blinds** can help.\n\nLet's narrow it down.",
      productIds: [],
      ...selection,
    },
  );
  assert.deepEqual(parseQuestionCall({ productIds: [], message: " \n\t ", ...selection }), {
    message: "",
    productIds: [],
    ...selection,
  });
  assert.equal(
    parseQuestionCall({ productIds: [], message: "x".repeat(2000), ...selection }).message
      .length,
    2000,
  );
  for (const input of [
    selection,
    { message: null, ...selection },
    { message: 1, ...selection },
    { message: "x".repeat(2001), ...selection },
    { message: "a\u0000b", ...selection },
    { message: "a\u007fb", ...selection },
    { message: "", ...selection, extra: true },
    ...[
      selection.question,
      `Let's choose. ${selection.question}`,
      "WHICH ROOM?",
      "Which\n\troom?",
      "Ｗｈｉｃｈ room?",
      `**${selection.question}**`,
    ].map((message) => ({ message, ...selection })),
  ])
    assert.throws(() => parseQuestionCall({ productIds: [], ...input }));
  assert.deepEqual(parseQuestionSelection(selection), selection);
});

test("both terminal tools require a bounded context message and prohibit unknown fields", () => {
  for (const definition of [
    askQuestionToolDefinition,
    askMeasurementToolDefinition,
  ]) {
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(definition.parameters.properties.message.type, "string");
    assert.equal(definition.parameters.properties.message.maxLength, 2000);
    assert.equal(definition.parameters.properties.message.minLength, undefined);
    assert.deepEqual(
      definition.parameters.required.toSorted(),
      Object.keys(definition.parameters.properties).toSorted(),
    );
    assert.match(definition.description, /call this alone/);
    assert.match(definition.description, /no prose response afterward/);
    assert.match(definition.description, /Put the question only in question/);
    assert.doesNotMatch(
      definition.description,
      /duplication .*allowed|supplies fallback/,
    );
  }
});

const measurementCall = {
  productIds: [],
  message: "",
  question: "What is the width?",
  instructions: "Measure across the top of the recess without deductions.",
  productPath: "/products/roller-blind",
  label: "Width",
  unit: "mm",
};
const numeric = () => {
  const { message, productIds, ...selection } =
    parseMeasurementQuestionCall(measurementCall);
  assert.equal(message, "");
  assert.deepEqual(productIds, []);
  return selection;
};

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
  assert.deepEqual(
    parseMeasurementQuestionCall({
      ...measurementCall,
      message: "Let's walk through the measuring guide.",
    }),
    {
      message: "Let's walk through the measuring guide.",
      productIds: [],
      ...expected,
    },
  );
  for (const unit of ["cm", "mm", "in", null])
    assert.equal(
      parseMeasurementQuestionCall({ ...measurementCall, unit }).measurement
        .unit,
      unit,
    );
  for (const invalid of [
    { ...measurementCall, unit: "m" },
    { ...measurementCall, unit: undefined },
    { ...measurementCall, instructions: null },
    { ...measurementCall, productPath: "/products/blind?variant=1" },
    { ...measurementCall, productPath: "https://other.test/products/blind" },
    { ...measurementCall, label: "x".repeat(41) },
    { ...measurementCall, label: "" },
    { ...measurementCall, instructions: "x".repeat(601) },
    { ...measurementCall, instructions: "**Measure** here" },
    { ...measurementCall, instructions: measurementCall.question },
    {
      ...measurementCall,
      instructions: `Measure without deductions. ${measurementCall.question.toUpperCase()}`,
    },
    { ...measurementCall, instructions: "What is the   width?" },
    {
      ...measurementCall,
      instructions: "What is the \uFF57\uFF49\uFF44\uFF54\uFF48?",
    },
    { ...measurementCall, min: 30 },
    { ...measurementCall, sourceCallId: randomUUID() },
    { ...measurementCall, message: undefined },
    { ...measurementCall, message: measurementCall.question },
    {
      ...measurementCall,
      message: `Measure carefully. ${measurementCall.question.toUpperCase()}`,
    },
    { ...measurementCall, message: "x".repeat(2001) },
  ])
    assert.throws(() => parseMeasurementQuestionCall(invalid));
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

test("measurement answers preserve bounded customer text without inferring units or numeric values", () => {
  for (const unit of ["mm", "cm", "in", null]) {
    const value = {
      ...numeric(),
      measurement: { ...numeric().measurement, unit },
    };
    for (const raw of [
      "500",
      "500.25",
      ".5",
      "1 1/2 in",
      "500 mm by 40 cm",
      "actually 3/4 inch",
      "Not sure",
      "-1",
      "1e3",
      "1,000",
    ]) {
      const answer = formatMeasurementAnswer(value, raw);
      assert.equal(answer, "Width: " + raw);
      assert.equal(isQuestionAnswer(value, answer), true);
    }
    assert.equal(formatMeasurementAnswer(value, " 500 "), "Width: 500");
  }
  for (const raw of ["", " ", "x".repeat(241), "500\nmm", "500\u0000mm"])
    assert.throws(() => formatMeasurementAnswer(numeric(), raw));
  for (const answer of [
    "Drop: 500 mm",
    "Width:  500 mm",
    "Width: 500 mm ",
    "500",
    "Width: ",
    "Width: " + "x".repeat(241),
  ])
    assert.equal(isQuestionAnswer(numeric(), answer), false);
  for (const answer of [
    "Change units",
    "Stop measuring",
    "Actually cm",
    "Stop",
  ])
    assert.equal(isQuestionAnswer(numeric(), answer), false);
  assert.equal(isQuestionAnswer(selection, "Bedroom"), true);
  assert.equal(isQuestionAnswer(selection, "Width: 500 mm"), false);
  assert.throws(() => formatMeasurementAnswer(selection, "500"));
  const exact = "x".repeat(MAX_QUESTION_ANSWER_LENGTH - "Width: ".length);
  assert.equal(
    formatMeasurementAnswer(numeric(), exact).length,
    MAX_QUESTION_ANSWER_LENGTH,
  );
  assert.equal(isQuestionAnswer(numeric(), "Width: " + exact), true);
  assert.throws(() => formatMeasurementAnswer(numeric(), exact + "x"));
});

test("unknown units and an empty instruction body are valid while saved established units remain readable", () => {
  const call = parseMeasurementQuestionCall({
    ...measurementCall,
    unit: null,
    instructions: "",
  });
  assert.equal(call.measurement.unit, null);
  assert.equal(call.measurement.instructions, "");
  const selection = {
    question: call.question,
    answers: call.answers,
    measurement: call.measurement,
  };
  const part = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...selection,
  };
  assert.deepEqual(parseQuestionPart(part), part);
  for (const unit of ["mm", "cm", "in"])
    assert.equal(
      parseQuestionPart({ ...part, measurement: { ...part.measurement, unit } })
        .measurement.unit,
      unit,
    );
  const schema = askMeasurementToolDefinition.parameters.properties;
  assert.ok(schema.unit.enum.includes(null));
  assert.equal(schema.instructions.minLength, undefined);
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

test("raw voice captions preserve offered answers until a real customer turn is accepted", () => {
  const offered = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...selection,
    voiceReply: { voiceId: randomUUID(), afterSequence: 3 },
  };
  const messages = [questionMessage(offered)];
  const rawCaption = (text) => ({
    type: "voice",
    version: 1,
    voiceId: offered.voiceReply.voiceId,
    text,
    startMs: 18000,
    endMs: 19000,
  });
  for (const text of [" Hmm", "Yes", "180", "Hello", " Please repeat that"]) {
    messages.push({ role: "user", status: "complete", parts: [rawCaption(text)] });
    assert.equal(latestQuestion(messages), offered);
  }
  const original = structuredClone(messages);
  assert.equal(latestQuestion([
    ...messages,
    { role: "assistant", status: "complete", parts: [rawCaption("Which room?")] },
  ]), offered);
  for (const parts of [
    [{ type: "text", text: "Bedroom" }],
    [rawCaption("Bedroom"), { type: "text", text: "Bedroom" }],
    [],
  ]) {
    assert.equal(latestQuestion([
      ...messages,
      { role: "user", status: "pending", parts },
    ]), undefined);
  }
  assert.deepEqual(messages, original);
});

test("an accepted voice turn retires its prior question even while pending or failed", () => {
  const offered = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    ...selection,
  };
  const accepted = {
    type: "voice_turn",
    version: 1,
    voiceId: randomUUID(),
    throughSequence: 9,
    offsetMs: 43600,
  };
  for (const status of ["pending", "failed", "complete"]) {
    assert.equal(latestQuestion([
      questionMessage(offered),
      { role: "context", status, parts: [accepted] },
    ]), undefined);
  }
  const next = {
    ...offered,
    invocationId: randomUUID(),
    question: "Does avoiding drilling matter?",
    answers: ["Yes", "Regular fitting is fine"],
  };
  assert.equal(latestQuestion([
    questionMessage(offered),
    { role: "context", status: "complete", parts: [accepted, next] },
  ]), next);
  for (const status of ["pending", "failed"]) {
    assert.equal(latestQuestion([
      questionMessage(offered),
      { role: "context", status, parts: [accepted, next] },
    ]), undefined);
  }
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


test("terminal responses carry bounded ordered selections without weakening question or measurement validation", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `gid://shopify/Product/${index + 1}`);
  for (const [parse, input] of [
    [parseQuestionCall, { message: "A range of styles.", ...selection }],
    [parseMeasurementQuestionCall, measurementCall],
  ]) {
    assert.deepEqual(parse({ ...input, productIds: [] }).productIds, []);
    assert.deepEqual(parse({ ...input, productIds: ids }).productIds, ids);
    for (const productIds of [undefined, null, ids.concat("gid://shopify/Product/11"), [ids[0], ids[0]], ["gid://shopify/ProductVariant/1"], ["https://store.test/products/blind"], [123]])
      assert.throws(() => parse({ ...input, productIds }));
  }
});
