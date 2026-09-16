import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["shared/voice-transcript.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const { groupVoiceTranscript, voiceCaptionText } = module.exports;

test("caption display removes only known cues and orphan leading punctuation while preserving paragraphs", () => {
  for (const [raw, expected] of [
    [" [ChUcKlE] . Hello [BREATH] there. [breath] ", "Hello there."],
    ["[breath][chuckle]", ""],
    [
      "First paragraph.\n\n[breath] Second paragraph.",
      "First paragraph.\n\n Second paragraph.",
    ],
    ["[laugh] Take [300] millimetres.", "[laugh] Take [300] millimetres."],
    [".5 metres is 500 mm.", ".5 metres is 500 mm."],
    ["... Let me think.", "... Let me think."],
    ['"Yes," she said.', '"Yes," she said.'],
    ["- Keep this dash.", "- Keep this dash."],
    ["300.5, then 400; correct?", "300.5, then 400; correct?"],
  ])
    assert.equal(voiceCaptionText(raw), expected);
});

test("cleaning grouped captions leaves exact provider fragments and group text unchanged", () => {
  const captions = [
    fragment(1, " [chuckle] . Hello", 0, 100),
    fragment(2, " [breath] there.", 200, 300),
  ];
  const original = structuredClone(captions);
  const [group] = groupVoiceTranscript(captions);
  const exact = group.text;
  assert.equal(voiceCaptionText(group.text), "Hello there.");
  assert.equal(group.text, exact);
  assert.deepEqual(group.fragments, original);
  assert.deepEqual(captions, original);
});

function fragment(sequence, text, startMs, endMs, extra = {}) {
  return {
    id: `fragment-${sequence}`,
    voiceId: "voice-1",
    providerEventId: `event-${sequence}`,
    sequence,
    role: "assistant",
    text,
    startMs,
    endMs,
    createdAt: "2026-09-16T12:00:00.000Z",
    ...extra,
  };
}

test("normal pauses in a greeting retain one stable bubble and exact provider text", () => {
  // Timings reproduce the 0.8–1.8 second pauses seen in native caption metadata.
  const captions = [
    fragment(1, "Roman", 0, 200),
    fragment(2, " here.", 1000, 1400),
    fragment(3, " I can help", 2600, 3000),
    fragment(4, " with your kitchen.", 4800, 5200),
  ];
  const original = structuredClone(captions);
  for (let count = 1; count <= captions.length; count++) {
    const result = groupVoiceTranscript(captions.slice(0, count));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, captions[0].id);
    assert.equal(result[0].sequence, 1);
    assert.equal(
      result[0].text,
      captions
        .slice(0, count)
        .map((row) => row.text)
        .join(""),
    );
    assert.deepEqual(result[0].fragments, captions.slice(0, count));
  }
  const group = groupVoiceTranscript([...captions].reverse())[0];
  assert.equal(group.startMs, 0);
  assert.equal(group.endMs, 5200);
  assert.deepEqual(captions, original);
});

test("long pauses still separate speech without inferring words or complete turns", () => {
  const captions = [
    fragment(1, "black", 0, 100),
    fragment(2, "out", 3100, 3200),
    fragment(3, " Another thought.", 6201, 6500),
  ];
  const groups = groupVoiceTranscript(captions);
  assert.deepEqual(
    groups.map((group) => group.text),
    ["blackout", " Another thought."],
  );
  assert.deepEqual(
    groups.map((group) => group.id),
    [captions[0].id, captions[2].id],
  );
});

test("only explicitly hidden rows can be crossed and unknown sequence gaps remain boundaries", () => {
  const captions = [
    fragment(1, "Hello", 0, 200),
    fragment(4, " there", 600, 800),
  ];
  assert.equal(groupVoiceTranscript(captions).length, 2);
  assert.equal(groupVoiceTranscript(captions, [2]).length, 2);
  assert.equal(groupVoiceTranscript(captions, [3]).length, 2);
  const groups = groupVoiceTranscript(captions, [3, 2, 2, 99]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text, "Hello there");
  assert.equal(groups[0].id, captions[0].id);
});

test("speaker and voice-session boundaries remain even when surrounding rows are hidden", () => {
  const captions = [
    fragment(1, "Hello", 0, 200),
    fragment(3, "Hi", 300, 500, { role: "user" }),
    fragment(5, "Welcome back", 0, 300, { role: "user", voiceId: "voice-2" }),
  ];
  const groups = groupVoiceTranscript(captions, [2, 4]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((group) => group.sequence),
    [1, 3, 5],
  );
});

test("a caption older than the group's interval is kept in order as a separate row", () => {
  const captions = [
    fragment(1, "Later", 2000, 2200),
    fragment(2, " earlier", 500, 600),
  ];
  const groups = groupVoiceTranscript(captions);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.id),
    captions.map((row) => row.id),
  );
});

test("late input captions precede Roman's reply without changing either speaker's exact deltas", () => {
  const captions = [
    fragment(1, "G", 1100, 1150),
    fragment(2, "Su", 1000, 1050, { role: "user" }),
    fragment(3, "reat.", 1150, 1200),
    fragment(4, "re", 1050, 1100, { role: "user" }),
  ];
  const original = structuredClone(captions);
  assert.equal(
    groupVoiceTranscript(captions.slice(0, 1))[0].id,
    captions[0].id,
  );
  const groups = groupVoiceTranscript(captions);
  assert.deepEqual(
    groups.map(({ role, text, sequence, endSequence }) => ({
      role,
      text,
      sequence,
      endSequence,
    })),
    [
      { role: "user", text: "Sure", sequence: 1, endSequence: 2 },
      { role: "assistant", text: "Great.", sequence: 3, endSequence: 4 },
    ],
  );
  assert.deepEqual(
    groups.map((group) => group.id),
    [captions[1].id, captions[0].id],
  );
  assert.deepEqual(groups[0].fragments, [captions[1], captions[3]]);
  assert.deepEqual(groups[1].fragments, [captions[0], captions[2]]);
  assert.deepEqual(captions, original);
});

test("equal cross-speaker timestamps retain arrival order", () => {
  for (const role of ["user", "assistant"]) {
    const captions = [
      fragment(1, "First", 1000, 1050, { role }),
      fragment(2, "Second", 1000, 1050, {
        role: role === "user" ? "assistant" : "user",
      }),
    ];
    assert.deepEqual(
      groupVoiceTranscript(captions).map((group) => group.id),
      captions.map((row) => row.id),
    );
  }
});

test("late captions cross hidden bookkeeping but never visible, completion, or connection boundaries", () => {
  const captions = [
    fragment(1, "Great.", 2000, 2200),
    fragment(3, "Sure", 1000, 1200, { role: "user" }),
  ];
  assert.deepEqual(
    groupVoiceTranscript(captions, [2]).map((group) => group.text),
    ["Sure", "Great."],
  );
  for (const [hidden, breaks] of [
    [[], []],
    [[2], [2]],
    [[2], [3]],
  ]) {
    assert.deepEqual(
      groupVoiceTranscript(captions, hidden, breaks).map((group) => group.text),
      ["Great.", "Sure"],
    );
  }
  assert.deepEqual(
    groupVoiceTranscript(
      [captions[0], { ...captions[1], voiceId: "voice-2" }],
      [2],
    ).map((group) => group.text),
    ["Great.", "Sure"],
  );
});
