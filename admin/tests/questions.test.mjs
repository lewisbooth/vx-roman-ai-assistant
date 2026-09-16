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
const { parseQuestionSelection, parseQuestionPart, askQuestionToolDefinition } =
  module.exports;
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
    /When this tool succeeds, keep the text reply to its concise overview and do not end it with a question/,
  );
  assert.match(
    askQuestionToolDefinition.description,
    /Only end with a direct question when you do not call this tool/,
  );
  assert.equal(
    askQuestionToolDefinition.parameters.additionalProperties,
    false,
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
