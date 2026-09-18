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
    createdAt: "2026-09-18T12:00:00.000Z",
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
  return { container, render: view.render };
}

test("spoken questions remain in the transcript alongside clickable answers and answered history", async (t) => {
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
    spoken.text,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
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
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
});

test("widget arrival does not erase complete or split captions", (t) => {
  const ctx = setup(t);
  const offered = question();
  for (const texts of [
    [offered.question],
    ["That is available. Would you", "like a sample?"],
  ]) {
    const speech = texts.map((text) => message("assistant", caption(text)));
    ctx.render({ messages: speech });
    const before = [
      ...ctx.container.querySelectorAll(".roman-voice-caption p"),
    ].map((node) => node.textContent);
    for (const questionFirst of [false, true]) {
      const row = message("context", offered);
      ctx.render({
        messages: questionFirst ? [row, ...speech] : [...speech, row],
        activeQuestionId: offered.invocationId,
        onAnswer: async () => {},
      });
      assert.deepEqual(
        [...ctx.container.querySelectorAll(".roman-voice-caption p")].map(
          (node) => node.textContent,
        ),
        before,
      );
      assert.equal(
        ctx.container.querySelector(".roman-question p").textContent,
        offered.question,
      );
    }
  }
});

test("voice cue cleanup still applies without removing questions or mutating saved captions", (t) => {
  const ctx = setup(t);
  const offered = question();
  const spoken = caption(`[breath] . ${offered.question} [chuckle]`);
  const messages = [
    message("assistant", spoken),
    message("assistant", caption("[breath]")),
    message("context", offered),
  ];
  const original = structuredClone(messages);
  ctx.render({ messages });
  assert.equal(
    ctx.container.querySelectorAll(".roman-voice-caption").length,
    1,
  );
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    offered.question,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
  assert.deepEqual(messages, original);
});

test("a resumed pending question remains visible in new voice captions and its widget", (t) => {
  const ctx = setup(t);
  const offered = question();
  const spoken = caption(`Let's pick up here. ${offered.question}`, "voice-2");
  ctx.render({
    messages: [
      message("context", offered),
      message("context", {
        type: "voice_event",
        version: 1,
        event: "ended",
        voiceId: "voice-1",
      }),
      message("context", {
        type: "voice_event",
        version: 1,
        event: "started",
        voiceId: "voice-2",
      }),
      message("assistant", spoken),
    ],
    activeQuestionId: offered.invocationId,
    voice: true,
    onAnswer: async () => {},
  });
  assert.equal(
    ctx.container.querySelector(".roman-voice-caption p").textContent,
    spoken.text,
  );
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    2,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
});

test("written and numeric questions retain their prose alongside the input widget", (t) => {
  const ctx = setup(t);
  const offered = question({
    question: "What is the width including brackets?",
    answers: [],
    measurement: {
      productPath: "/products/example",
      label: "Width",
      unit: "mm",
      instructions: "Measure the full width, including brackets.",
    },
  });
  for (const part of [
    caption(`${offered.measurement.instructions} ${offered.question}`),
    {
      type: "text",
      text: `${offered.measurement.instructions} ${offered.question}`,
    },
  ]) {
    ctx.render({
      messages: [message("assistant", part), message("context", offered)],
      activeQuestionId: offered.invocationId,
      onAnswer: async () => {},
    });
    assert.equal(
      ctx.container.textContent.split(offered.question).length - 1,
      2,
    );
    assert.equal(
      ctx.container.textContent.split(offered.measurement.instructions).length -
        1,
      2,
    );
    assert.ok(
      ctx.container
        .querySelector('input[type="number"]')
        .getAttribute("aria-describedby")
        .includes("instructions"),
    );
  }
});
