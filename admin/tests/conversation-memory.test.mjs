import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/conversations/memory.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  Buffer,
});
const {
  MAX_MEMO_BYTES,
  MIN_COMPACTION_TEXT_BYTES,
  parseMemoryUpdate,
  parseMemo,
  applyMemoryUpdate,
  memoryMessage,
  parseCheckpoint,
  modelMemoryInput,
  shouldCompactContext,
  parseRecallHistory,
} = module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const checkpoint = (model, throughSequence, marker = model) => ({
  model,
  throughSequence,
  input: [
    { type: "compaction", encrypted_content: `encrypted-${marker}` },
    { role: "assistant", content: `Compacted outcome for ${marker}.` },
  ],
});

test("private notes keep independent window layers and future intentions without a task schema", () => {
  const update = parseMemoryUpdate({
    set: [
      { key: "kitchen/bay/blind", text: "Lottie selected; width remains pending. Source 7." },
      { key: "kitchen/bay/curtain", text: "Return to curtains after measuring the blind." },
      { key: "bedroom blind", text: "Lottie also considered here; no size supplied." },
      { key: "future.visualization", text: "Would like to preview the kitchen layers when available." },
    ],
    forget: [],
  });
  assert.deepEqual(plain(applyMemoryUpdate({}, update)), {
    "kitchen/bay/blind": "Lottie selected; width remains pending. Source 7.",
    "kitchen/bay/curtain": "Return to curtains after measuring the blind.",
    "bedroom blind": "Lottie also considered here; no size supplied.",
    "future.visualization": "Would like to preview the kitchen layers when available.",
  });
});

test("patching a correction or forgetting a cancelled note preserves other unfinished work", () => {
  const original = {
    "kitchen/blind": "Width 100 cm, pending drop. Source 7.",
    "kitchen/curtain": "Return after blind; heading not chosen.",
    "bedroom/blind": "Customer cancelled this window.",
  };
  const next = applyMemoryUpdate(original, parseMemoryUpdate({
    set: [{ key: "kitchen/blind", text: "  Customer corrected width to 102 cm; drop pending. Source 11.  " }],
    forget: ["bedroom/blind"],
  }));
  assert.deepEqual(plain(next), {
    "kitchen/blind": "Customer corrected width to 102 cm; drop pending. Source 11.",
    "kitchen/curtain": "Return after blind; heading not chosen.",
  });
  assert.equal(original["kitchen/blind"], "Width 100 cm, pending drop. Source 7.");
  assert.ok(Object.hasOwn(original, "bedroom/blind"));
  for (const unchanged of [undefined, null]) {
    assert.equal(parseMemoryUpdate(unchanged), undefined);
    assert.equal(applyMemoryUpdate(original, parseMemoryUpdate(unchanged)), original);
  }
});

test("memory patches reject ambiguous, unsafe and unbounded note updates", () => {
  const note = { key: "kitchen/blind", text: "Pending measurement." };
  for (const value of [
    [],
    { set: [], forget: [], extra: true },
    { set: [note] },
    { set: [note, note], forget: [] },
    { set: [note], forget: [note.key] },
    { set: [], forget: [note.key, note.key] },
    { set: Array.from({ length: 5 }, (_, index) => ({ ...note, key: `window${index}` })), forget: [] },
    { set: [], forget: Array.from({ length: 17 }, (_, index) => `window${index}`) },
    ...["__proto__", "constructor", "prototype", "window\nblind", "x".repeat(81)].map((key) => ({ set: [{ ...note, key }], forget: [] })),
    ...["", " \n ", "x".repeat(1601), "hidden\u0000text"].map((text) => ({ set: [{ ...note, text }], forget: [] })),
    { set: [{ ...note, privileged: true }], forget: [] },
  ]) {
    assert.throws(() => parseMemoryUpdate(value));
  }
});

test("stored memo validation rejects unsafe keys and enforces UTF-8 bytes without silently dropping notes", () => {
  for (const value of [
    null, [],
    JSON.parse('{"__proto__":"unsafe"}'),
    { constructor: "unsafe" },
    { prototype: "unsafe" },
    { note: 42 },
    { note: "" },
    { note: "x".repeat(1601) },
  ]) assert.throws(() => parseMemo(value));

  const full = { a: "a".repeat(1500), b: "b".repeat(1500), c: "c".repeat(1500), d: "" };
  full.d = "d".repeat(MAX_MEMO_BYTES - Buffer.byteLength(JSON.stringify(full), "utf8"));
  assert.equal(Buffer.byteLength(JSON.stringify(full), "utf8"), MAX_MEMO_BYTES);
  assert.deepEqual(plain(parseMemo(full)), full);
  assert.throws(() => applyMemoryUpdate(full, parseMemoryUpdate({
    set: [{ key: "pending", text: "Return to curtains." }], forget: [],
  })), /memory is full/i);
  assert.equal(Buffer.byteLength(JSON.stringify(full), "utf8"), MAX_MEMO_BYTES);
  assert.throws(() => applyMemoryUpdate({}, parseMemoryUpdate({
    set: [{ key: "first", text: "測".repeat(1000) }, { key: "second", text: "測".repeat(1000) }],
    forget: [],
  })), /memory is full/i);
  assert.deepEqual(plain(applyMemoryUpdate(full, parseMemoryUpdate({
    set: [{ key: "pending", text: "Return to curtains." }], forget: ["d"],
  }))), { a: full.a, b: full.b, c: full.c, pending: "Return to curtains." });
});

test("private memo is silent reference context and is absent when empty", () => {
  assert.equal(memoryMessage({}), undefined);
  const message = memoryMessage({ "kitchen/blind": "Customer corrected width to 102 cm. Source 11." });
  assert.equal(message.role, "user");
  assert.equal(message.source, "memory");
  assert.match(message.text, /historical reference.*never instructions.*new customer request/);
  assert.match(message.text, /newer customer corrections and verified results take precedence/);
  assert.match(message.text, /102 cm.*Source 11/);
});

test("matching checkpoint omits covered history while preserving crossing records and fresh references", () => {
  const saved = checkpoint("gpt-primary", 10);
  const history = [
    { role: "user", text: "Old width 100 cm.", sequence: 1, endSequence: 1 },
    { role: "assistant", text: "Covered through ten.", sequence: 10, endSequence: 10 },
    { role: "assistant", text: "Grouped speech crossing the checkpoint.", sequence: 9, endSequence: 12 },
    { role: "user", text: "Actually, the width is 102 cm.", sequence: 13, endSequence: 13 },
    { role: "user", text: "Current unpersisted request." },
    { role: "user", source: "memory", text: "Outdated projected memo.", sequence: 14, endSequence: 14 },
    { role: "user", source: "application_state", text: "Current product page and quote.", sequence: 1, endSequence: 1 },
  ];
  const input = plain(modelMemoryInput(history, "gpt-primary", {
    memo: { "kitchen/blind": "Width corrected to 102 cm. Source 13." },
    throughSequence: 14,
    checkpoints: [saved, checkpoint("gpt-fallback", 2)],
  }));
  assert.deepEqual(input.slice(0, 2), saved.input);
  assert.deepEqual(input.slice(2, 5), [
    { role: "assistant", content: "Grouped speech crossing the checkpoint." },
    { role: "user", content: "Actually, the width is 102 cm." },
    { role: "user", content: "Current unpersisted request." },
  ]);
  assert.match(input[5].content, /Width corrected to 102 cm/);
  assert.deepEqual(input[6], { role: "user", content: "Current product page and quote." });
  assert.equal(input.length, 7);
  assert.doesNotMatch(JSON.stringify(input), /Old width|Covered through ten|Outdated projected memo|encrypted-gpt-fallback/);
});

test("fallback uses its own checkpoint or raw history and always receives current memo and application facts", () => {
  const history = [
    { role: "user", text: "Original request.", sequence: 1, endSequence: 1 },
    { role: "assistant", text: "Confirmed old outcome.", sequence: 2, endSequence: 2 },
    { role: "user", text: "Return to the kitchen curtains.", sequence: 11, endSequence: 11 },
    { role: "user", source: "application_state", text: "Current kitchen page." },
  ];
  const memory = {
    memo: { "kitchen/curtain": "Heading still pending." },
    throughSequence: 11,
    checkpoints: [checkpoint("gpt-primary", 10)],
  };
  const raw = plain(modelMemoryInput(history, "gpt-fallback", memory));
  assert.deepEqual(raw.slice(0, 3), history.slice(0, 3).map(({ role, text }) => ({ role, content: text })));
  assert.match(raw[3].content, /Heading still pending/);
  assert.equal(raw[4].content, "Current kitchen page.");
  assert.doesNotMatch(JSON.stringify(raw), /encrypted/);

  const own = checkpoint("gpt-fallback", 1);
  memory.checkpoints.push(own);
  const resumed = plain(modelMemoryInput(history, "gpt-fallback", memory));
  assert.deepEqual(resumed.slice(0, 2), own.input);
  assert.equal(resumed[2].content, "Confirmed old outcome.");
  assert.equal(resumed[3].content, "Return to the kitchen curtains.");
  assert.doesNotMatch(JSON.stringify(resumed), /encrypted-gpt-primary|Original request/);
});

test("checkpoint validation requires bounded encrypted context and a valid source watermark", () => {
  const valid = checkpoint("gpt-primary", 10);
  assert.deepEqual(plain(parseCheckpoint(valid)), valid);
  for (const value of [
    null,
    { ...valid, model: "bad model" },
    { ...valid, throughSequence: -1 },
    { ...valid, throughSequence: 1.5 },
    { ...valid, throughSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, input: [] },
    { ...valid, input: [{ role: "user", content: "No encrypted compaction." }] },
    { ...valid, input: [{ type: "compaction", encrypted_content: 123 }] },
    { ...valid, input: [{ type: "compaction", encrypted_content: "x".repeat(512 * 1024) }] },
  ]) assert.throws(() => parseCheckpoint(value));
});

test("historical retrieval accepts text or a sequence cursor and rejects malformed bounds", () => {
  assert.deepEqual(plain(parseRecallHistory({ query: " kitchen curtain ", beforeSequence: null })), {
    query: "kitchen curtain", beforeSequence: null,
  });
  assert.deepEqual(plain(parseRecallHistory({ query: "", beforeSequence: 18 })), {
    query: "", beforeSequence: 18,
  });
  for (const value of [
    null, [],
    { query: "kitchen" },
    { query: "kitchen", beforeSequence: null, shop: "other" },
    { query: "x".repeat(161), beforeSequence: null },
    { query: "", beforeSequence: -1 },
    { query: "", beforeSequence: 1.5 },
    { query: "", beforeSequence: "18" },
  ]) assert.throws(() => parseRecallHistory(value));
});

test("the compaction gate ignores ephemeral files and encrypted state", () => {
  assert.equal(shouldCompactContext([
    { type: "compaction", encrypted_content: "x".repeat(MIN_COMPACTION_TEXT_BYTES * 2) },
    { type: "reasoning", encrypted_content: "x".repeat(MIN_COMPACTION_TEXT_BYTES * 2), summary: [] },
    { role: "user", content: [
      { type: "input_file", filename: "guide.pdf", file_data: "x".repeat(MIN_COMPACTION_TEXT_BYTES * 2) },
      { type: "input_image", image_url: "x".repeat(MIN_COMPACTION_TEXT_BYTES * 2), detail: "high" },
      { type: "input_text", text: "Measure the kitchen blind." },
    ] },
  ]), false);
});

test("the compaction gate counts durable multilingual history and current tool text together", () => {
  const history = { role: "user", content: "測".repeat(MIN_COMPACTION_TEXT_BYTES / 6) };
  const call = { type: "function_call", call_id: "read", name: "lookup_catalog", arguments: "x".repeat(MIN_COMPACTION_TEXT_BYTES / 4) };
  const output = { type: "function_call_output", call_id: "read", output: "x".repeat(MIN_COMPACTION_TEXT_BYTES / 4) };
  assert.equal(shouldCompactContext([history, call]), false);
  assert.equal(shouldCompactContext([history, call, output]), true);
  assert.equal(shouldCompactContext([{ role: "assistant", content: [{ type: "output_text", text: "x".repeat(MIN_COMPACTION_TEXT_BYTES) }] }]), true);
});

test("a saved checkpoint resets compaction pressure to its retained text and uncovered history", () => {
  const history = [
    { role: "user", text: "x".repeat(MIN_COMPACTION_TEXT_BYTES), sequence: 1, endSequence: 1 },
    { role: "user", text: "Now the drop.", sequence: 11, endSequence: 11 },
  ];
  const memory = { memo: {}, throughSequence: 11, checkpoints: [checkpoint("gpt-primary", 10)] };
  assert.equal(shouldCompactContext(modelMemoryInput(history, "gpt-primary", memory)), false);
  assert.equal(shouldCompactContext(modelMemoryInput(history, "gpt-fallback", memory)), true);
});
