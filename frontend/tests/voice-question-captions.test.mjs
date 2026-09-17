import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Timeline } from './frontend/src/chat/Timeline';
      export { voiceQuestionCaptions } from './frontend/src/chat/voice-question-captions';
      export function mount(container) {
        const root = createRoot(container);
        return {
          render(props) { flushSync(() => root.render(<Timeline session={{}} navigation={{}}
            onContentChange={() => {}} {...props} />)); },
          dispose() { flushSync(() => root.unmount()); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "CaptionTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

let nextId = 0;
function message(role, ...parts) {
  return {
    id: `message-${++nextId}`,
    role,
    status: "complete",
    parts,
    createdAt: "2026-09-17T12:00:00.000Z",
  };
}
function caption(text, voiceId = "voice-1") {
  return { type: "voice", version: 1, voiceId, text, startMs: 0, endMs: 1000 };
}
function question(extra = {}) {
  return {
    type: "question",
    version: 1,
    invocationId: `question-${++nextId}`,
    question: "Would you like a sample?",
    answers: ["Yes, a sample", "Keep browsing"],
    voiceReply: { voiceId: "voice-1", afterSequence: 1 },
    ...extra,
  };
}
function voiceEvent(event, voiceId) {
  return { type: "voice_event", version: 1, event, voiceId };
}

function setup(t) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    runScripts: "outside-only",
  });
  const errors = [];
  dom.window.console.error = (...args) => errors.push(args);
  dom.window.fetch = () =>
    assert.fail("Caption display must not make requests.");
  dom.window.eval(`${bundle.outputFiles[0].text};window.api=CaptionTest;`);
  const container = dom.window.document.querySelector("#root");
  const view = dom.window.api.mount(container);
  t.after(() => {
    view.dispose();
    dom.window.close();
    assert.deepEqual(errors, []);
  });
  return {
    container,
    render: view.render,
    project: dom.window.api.voiceQuestionCaptions,
  };
}

test("the widget owns one displayed question while speech and answer state remain unchanged", async (t) => {
  const ctx = setup(t);
  const spoken = caption("Yes, we can. Would you like a sample?");
  const offered = question();
  const messages = [message("assistant", spoken), message("context", offered)];
  const original = structuredClone(messages);
  const answers = [];
  ctx.render({
    messages,
    activeQuestionId: offered.invocationId,
    voice: true,
    onAnswer: async (...args) => answers.push(args),
  });
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    "Yes, we can.",
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    2,
  );
  ctx.container.querySelector(".roman-question button").click();
  await delay(0);
  assert.equal(answers.length, 1);
  assert.equal(answers[0][0], offered);
  assert.equal(answers[0][1], "Yes, a sample");
  assert.deepEqual(messages, original);

  ctx.render({
    messages: [
      ...messages,
      message("user", { type: "text", text: "Yes, a sample" }),
    ],
  });
  assert.equal(ctx.container.querySelector(".roman-question"), null);
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
});

test("partial and interrupted captions stay visible until the complete matching question arrives", (t) => {
  const ctx = setup(t);
  const offered = question();
  for (const text of [
    "Would you like a",
    "Would you like a sample or keep browsing?",
    "Would you prefer a sample?",
  ]) {
    const spoken = caption(text);
    const messages = [
      message("context", offered),
      message("assistant", spoken),
    ];
    assert.equal(ctx.project(messages).get(spoken), text);
  }
  const spoken = caption("[breath] would you LIKE   a sample.");
  const messages = [message("context", offered), message("assistant", spoken)];
  ctx.render({
    messages,
    activeQuestionId: offered.invocationId,
    onAnswer: async () => {},
  });
  assert.equal(ctx.container.querySelector(".roman-voice-caption"), null);
  assert.equal(
    ctx.container.querySelector(".roman-question p").textContent,
    offered.question,
  );
  assert.equal(spoken.text, "[breath] would you LIKE   a sample.");
});

test("question display handles either arrival order and captions split across display groups", (t) => {
  const ctx = setup(t);
  for (const questionFirst of [false, true]) {
    const offered = question();
    const first = caption("That is available. Would you");
    const second = caption("like a sample?");
    const speech = [message("assistant", first), message("assistant", second)];
    const row = message("context", offered);
    const messages = questionFirst ? [row, ...speech] : [...speech, row];
    const projected = ctx.project(messages);
    assert.equal(projected.get(first), "That is available.");
    assert.equal(projected.get(second), "");
    ctx.render({
      messages,
      activeQuestionId: offered.invocationId,
      onAnswer: async () => {},
    });
    assert.equal(
      ctx.container.querySelectorAll(".roman-voice-caption").length,
      1,
    );
    assert.equal(
      ctx.container.textContent.split(offered.question).length - 1,
      1,
    );
  }
});

test("text questions, customer speech and unrelated turns are never deduplicated", (t) => {
  const ctx = setup(t);
  const offered = question();
  for (const messages of [
    [
      message("assistant", caption(offered.question)),
      message("context", { ...offered, voiceReply: undefined }),
    ],
    [message("user", caption(offered.question)), message("context", offered)],
    [
      message("assistant", caption(offered.question)),
      message("user", { type: "text", text: "Another window" }),
      message("context", offered),
    ],
    [
      message("assistant", caption(offered.question, "old-voice")),
      message("context", offered),
    ],
    [
      message("context", offered),
      message("context", question({ question: "Which room?" })),
      message("assistant", caption(offered.question)),
    ],
    [
      message("context", offered),
      message("context", {
        type: "page_view",
        path: "/",
        title: "Home",
        occurredAt: "2026-09-17T12:00:00.000Z",
      }),
      message("assistant", caption(offered.question)),
    ],
  ]) {
    const spoken = messages
      .flatMap((row) => row.parts)
      .find((part) => part.type === "voice");
    assert.equal(ctx.project(messages).get(spoken), spoken.text);
  }
  const messages = [
    message("assistant", { type: "text", text: offered.question }),
    message("context", offered),
  ];
  ctx.render({ messages });
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
});

test("a pending question resumed in a new voice session remains clickable and survives answered history", (t) => {
  const ctx = setup(t);
  const offered = question();
  const spoken = caption(
    "Let's pick up here. Would you like a sample?",
    "voice-2",
  );
  const messages = [
    message("context", offered),
    message("context", voiceEvent("ended", "voice-1")),
    message("context", voiceEvent("started", "voice-2")),
    message("assistant", spoken),
  ];
  ctx.render({
    messages,
    activeQuestionId: offered.invocationId,
    voice: true,
    onAnswer: async () => {},
  });
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    "Let's pick up here.",
  );
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    2,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  ctx.render({
    messages: [
      ...messages,
      message("user", caption("Keep browsing", "voice-2")),
    ],
  });
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  assert.equal(ctx.container.querySelector(".roman-question"), null);
});

test("numeric questions retain measuring instructions and use escaped literal text", (t) => {
  const ctx = setup(t);
  const offered = question({
    question: "Is the width 300.5 mm (including brackets)?",
    answers: [],
    measurement: {
      productPath: "/products/example",
      label: "Width",
      unit: "mm",
      instructions: "Measure the full width, including brackets.",
    },
  });
  const spoken = caption(
    `${offered.measurement.instructions} ${offered.question}`,
  );
  ctx.render({
    messages: [message("assistant", spoken), message("context", offered)],
    activeQuestionId: offered.invocationId,
    onAnswer: async () => {},
  });
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    offered.measurement.instructions,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  assert.equal(
    ctx.container
      .querySelector('input[type="number"]')
      .getAttribute("aria-describedby")
      .includes("instructions"),
    true,
  );
});
