import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `export * from "./frontend/src/session/history"; export * from "./frontend/src/chat/history-scroll"; export * from "./shared/conversation-timeline";`,
    resolveDir: process.cwd(),
  },
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
  createConversationHistory,
  projectConversationTimeline,
  captureHistoryAnchor,
  restoreHistoryAnchor,
} = module.exports;

function message(sequence, text = `Message ${sequence}`, extra = {}) {
  return {
    sequence,
    message: {
      id: `message-${sequence}`,
      role: "assistant",
      status: "complete",
      createdAt: "2026-10-02T10:00:00Z",
      parts: [{ type: "text", text }],
      ...extra,
    },
  };
}
function caption(sequence, text, role = "assistant", extra = {}) {
  return {
    sequence,
    caption: {
      id: `caption-${sequence}`,
      voiceId: "11111111-1111-4111-8111-111111111111",
      sequence,
      role,
      text,
      startMs: sequence * 100,
      endMs: sequence * 100 + 50,
      createdAt: "2026-10-02T10:00:00Z",
      ...extra,
    },
  };
}
function page(entries, start, end) {
  return { start, end, before: start || null, entries };
}

test("late ASR changes display order without rewriting exact source provenance", () => {
  const rows = projectConversationTimeline([
    caption(0, "Assistant begins", "assistant", { startMs: 2000, endMs: 2050 }),
    caption(1, "Earlier customer", "user", { startMs: 1000, endMs: 1050 }),
    caption(2, " words", "user", { startMs: 1100, endMs: 1150 }),
    caption(3, " reply", "assistant", { startMs: 2100, endMs: 2150 }),
  ]);
  assert.deepEqual(rows.map(row => [row.role, row.sequence, row.endSequence, row.sourceSequence, row.sourceEndSequence]), [
    ["user", 0, 1, 1, 2],
    ["assistant", 2, 3, 0, 3],
  ]);
});

test("history anchors prefer message identity when caption display ranges overlap", () => {
  const dom = new JSDOM('<div id="scroll"><div data-history-id="target" data-history-sequence="12" data-history-end="15"></div></div>');
  const scroll = dom.window.document.querySelector("#scroll");
  scroll.getBoundingClientRect = () => ({ top: 0 });
  scroll.scrollTop = 20;
  const target = scroll.firstElementChild;
  target.getBoundingClientRect = () => ({ top: 5, bottom: 25 });
  const anchor = captureHistoryAnchor(scroll);
  const other = dom.window.document.createElement("div");
  other.dataset.historyId = "other";
  other.dataset.historySequence = "10";
  other.dataset.historyEnd = "16";
  other.getBoundingClientRect = () => ({ top: 100, bottom: 180 });
  scroll.prepend(other);
  target.getBoundingClientRect = () => ({ top: 205, bottom: 225 });
  restoreHistoryAnchor(scroll, anchor);
  assert.equal(scroll.scrollTop, 220);
  dom.window.close();
});

test("upward pages retain every historical row with no lifetime limit or duplicate", () => {
  const history = createConversationHistory();
  const rows = Array.from({ length: 4096 }, (_, sequence) => message(sequence));
  for (let end = rows.length; end > 0; end -= 256) {
    const start = Math.max(0, end - 256);
    history.merge(page(rows.slice(start, end), start, end), {
      revision: 10,
      streamRevision: 0,
    });
  }
  history.merge(page(rows.slice(-256), 3840, 4096), {
    revision: 10,
    streamRevision: 0,
  });
  assert.equal(history.before, null);
  assert.equal(history.messages().length, 4096);
  assert.deepEqual(
    history.messages().map((row) => row.id),
    rows.map((row) => row.message.id),
  );
});

test("captions recombine across a page boundary, including delayed customer speech and voice widgets", () => {
  const rows = [
    caption(0, "Find green blinds", "user"),
    caption(1, "Let me"),
    caption(2, " check."),
    message(3, "", {
      role: "context",
      parts: [
        {
          type: "products",
          version: 1,
          invocationId: "result",
          productIds: ["gid://shopify/Product/1"],
          voiceReply: {
            voiceId: "11111111-1111-4111-8111-111111111111",
            afterSequence: 4,
          },
        },
      ],
    }),
    caption(4, "These are"),
    caption(5, " the options."),
    caption(6, "Thank you", "user", { startMs: 575 }),
    caption(7, "You're welcome."),
  ];
  const history = createConversationHistory();
  history.merge(page(rows.slice(4), 4, 8), { revision: 8, streamRevision: 0 });
  history.merge(page(rows.slice(0, 4), 0, 4), {
    revision: 8,
    streamRevision: 0,
  });
  assert.deepEqual(history.messages(), projectConversationTimeline(rows));
  assert.equal(
    history.messages().filter((row) => row.id === "caption-1").length,
    1,
  );
  assert.equal(
    history.messages().find((row) => row.id === "caption-1").parts[0].text,
    "Let me check. These are the options.",
  );
});

test("late history cannot overwrite live text or current reserved-row results", () => {
  const history = createConversationHistory();
  const old = message(1, "Partial", { status: "pending" });
  history.merge(
    page([message(300)], 256, 301),
    { revision: 5, streamRevision: 2 },
    [message(1, "Finished")],
  );
  history.merge(page([old], 0, 256), { revision: 4, streamRevision: 0 });
  assert.equal(history.messages()[0].parts[0].text, "Finished");
  history.merge(page([message(300, "Newest")], 256, 301), {
    revision: 5,
    streamRevision: 3,
  });
  history.merge(page([message(300, "Stale")], 256, 301), {
    revision: 5,
    streamRevision: 0,
  });
  assert.equal(history.messages().at(-1).parts[0].text, "Newest");
});

test("missed polling intervals are filled before the oldest history cursor advances", () => {
  const history = createConversationHistory();
  history.merge(page([message(255)], 0, 256), {
    revision: 1,
    streamRevision: 0,
  });
  history.merge(page([message(899)], 644, 900), {
    revision: 2,
    streamRevision: 0,
  });
  assert.equal(history.hasGap, true);
  assert.equal(history.before, 644);
  history.merge(page([message(500)], 388, 644), {
    revision: 2,
    streamRevision: 0,
  });
  assert.equal(history.before, 388);
  history.merge(page([message(300)], 132, 388), {
    revision: 2,
    streamRevision: 0,
  });
  assert.equal(history.hasGap, false);
  assert.equal(history.before, null);
  assert.deepEqual(
    history.messages().map((row) => row.sequence),
    [255, 300, 500, 899],
  );
});

test("prepending preserves the visible row instead of jumping to bottom, including merged captions", () => {
  const dom = new JSDOM(
    '<div id="scroll"><div data-history-sequence="256" data-history-end="300"></div></div>',
  );
  try {
    const scroll = dom.window.document.getElementById("scroll");
    const row = scroll.firstElementChild;
    scroll.scrollTop = 40;
    scroll.getBoundingClientRect = () => ({ top: 100 });
    row.getBoundingClientRect = () => ({ top: 115, bottom: 180 });
    const anchor = captureHistoryAnchor(scroll);
    row.dataset.historySequence = "200";
    row.getBoundingClientRect = () => ({ top: 515, bottom: 580 });
    restoreHistoryAnchor(scroll, anchor);
    assert.equal(scroll.scrollTop, 440);
  } finally {
    dom.window.close();
  }
});

test("an earlier caption prefix preserves the already visible end of the merged speech bubble", () => {
  const dom = new JSDOM('<div id="scroll"><div data-history-sequence="256" data-history-end="300"></div></div>');
  try {
    const scroll = dom.window.document.getElementById("scroll");
    const row = scroll.firstElementChild;
    scroll.scrollTop = 40;
    scroll.getBoundingClientRect = () => ({ top: 100 });
    row.getBoundingClientRect = () => ({ top: 115, bottom: 180 });
    const anchor = captureHistoryAnchor(scroll);
    row.dataset.historySequence = "200";
    row.getBoundingClientRect = () => ({ top: 115, bottom: 380 });
    restoreHistoryAnchor(scroll, anchor);
    assert.equal(scroll.scrollTop, 240);
  } finally { dom.window.close(); }
});
