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

test("carousel choices display friendly text from structured metadata without rewriting actual customer text", (t) => {
  const ctx = setup(t);
  const text = "Choose Lottie Roman blind (/products/lottie).";
  const choice = {
    carouselId: "carousel-1",
    productId: "gid://shopify/Product/123",
    title: "Lottie Roman blind",
    productPath: "/products/lottie",
  };
  const messages = [
    message("user", { type: "text", text, productChoice: choice }),
    message("user", {
      type: "text",
      text,
      productChoice: { ...choice, voiceId: "voice-1" },
    }),
    message("user", { type: "text", text }),
  ];
  const original = structuredClone(messages);
  ctx.render({ messages });
  assert.deepEqual(
    [...ctx.container.querySelectorAll(".roman-message-user p")].map(
      (node) => node.textContent,
    ),
    [
      "I'd like the Lottie Roman blind.",
      "I'd like the Lottie Roman blind.",
      text,
    ],
  );
  assert.deepEqual(
    messages,
    original,
    "Rendering must preserve source context",
  );
});

test("answering a voice question retires its controls without adding a second transcript message", async (t) => {
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
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  assert.equal(ctx.container.querySelectorAll(".roman-message").length, 2);
  assert.equal(
    ctx.container.querySelectorAll(".roman-message-assistant").length,
    1,
  );
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
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
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

test("one structured text question stays in history while its active answer panel comes and goes", (t) => {
  const ctx = setup(t);
  const offered = question({ voiceReply: undefined });
  const messages = [
    message(
      "assistant",
      { type: "text", text: "The sample is available." },
      offered,
    ),
  ];
  ctx.render({
    messages,
    activeQuestionId: offered.invocationId,
    onAnswer: async () => {},
  });
  const history = ctx.container.querySelectorAll(".roman-message-assistant")[1];
  const questionText = history.querySelector(".roman-message-text");
  assert.equal(questionText.textContent, offered.question);
  assert.equal(history.hidden, false);
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 2);
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    2,
  );
  const answered = [
    ...messages,
    message("user", { type: "text", text: "Keep browsing" }),
  ];
  ctx.render({ messages: answered, voice: true });
  assert.equal(
    ctx.container.querySelectorAll(".roman-message-assistant")[1],
    history,
  );
  assert.equal(history.querySelector(".roman-message-text"), questionText);
  assert.equal(ctx.container.querySelector(".roman-question"), null);
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
  assert.equal(
    ctx.container.querySelectorAll(".roman-message-assistant").length,
    2,
  );

  const restored = setup(t);
  restored.render({ messages: structuredClone(answered), voice: true });
  assert.equal(restored.container.textContent, ctx.container.textContent);
});

test("numeric history keeps the short question and answer while instructions and input units belong only to active controls", (t) => {
  const ctx = setup(t);
  const offered = question({
    voiceReply: undefined,
    question: "What is the width including brackets?",
    answers: [],
    measurement: {
      productPath: "/products/example",
      label: "Width",
      unit: "mm",
      instructions: "Measure the full width, including brackets.",
    },
  });
  const messages = [message("assistant", offered)];
  ctx.render({
    messages,
    activeQuestionId: offered.invocationId,
    onAnswer: async () => {},
  });
  assert.ok(
    ctx.container
      .querySelector('input[type="text"]')
      .getAttribute("aria-describedby")
      .includes("instructions"),
  );
  for (const active of [true, false]) {
    if (!active)
      ctx.render({
        messages: [
          ...messages,
          message("user", { type: "text", text: "Width: 500 mm" }),
        ],
      });
    assert.equal(
      ctx.container.textContent.split(offered.question).length - 1,
      active ? 2 : 1,
    );
    assert.equal(
      ctx.container.textContent.split(offered.measurement.instructions).length -
        1,
      active ? 1 : 0,
    );
    assert.equal(ctx.container.textContent.includes("Width (mm)"), false);
    assert.equal(
      !!ctx.container.querySelector(".roman-measurement-field span"),
      active,
    );
    if (!active) assert.match(ctx.container.textContent, /Width: 500 mm/);
  }
  assert.equal(ctx.container.querySelector('input[type="text"]'), null);
});

test("voice question history uses provenance across reloads and mode switches, without inventing interrupted speech", (t) => {
  const offered = question();
  for (const spoken of [undefined, caption("Yes, we can. Would you")]) {
    const messages = [
      ...(spoken ? [message("assistant", spoken)] : []),
      message("context", offered),
      message("user", { type: "text", text: "Keep browsing" }),
    ];
    for (const voice of [false, true]) {
      const ctx = setup(t);
      ctx.render({ messages: structuredClone(messages), voice });
      assert.equal(ctx.container.querySelector(".roman-question"), null);
      assert.equal(ctx.container.textContent.includes(offered.question), false);
      assert.equal(
        ctx.container.querySelectorAll(".roman-message").length,
        spoken ? 2 : 1,
      );
      assert.equal(
        ctx.container.querySelectorAll(".roman-message-assistant").length,
        spoken ? 1 : 0,
      );
      if (spoken)
        assert.equal(
          ctx.container.querySelector(".roman-voice-caption p").textContent,
          spoken.text,
        );
    }
  }
});

test("an unaccepted optimistic voice answer restores the same pending control without replaying or historical duplication", (t) => {
  const ctx = setup(t);
  const offered = question();
  const messages = [message("context", offered)];
  const onAnswer = async () =>
    assert.fail("Rendering must not replay an answer");
  const pendingProps = {
    messages,
    activeQuestionId: offered.invocationId,
    onAnswer,
  };
  ctx.render(pendingProps);
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);

  const optimistic = {
    ...message("user", { type: "text", text: "Keep browsing" }),
    status: "pending",
  };
  ctx.render({ messages: [...messages, optimistic], onAnswer });
  assert.equal(ctx.container.querySelector(".roman-question"), null);
  assert.equal(ctx.container.querySelectorAll(".roman-message").length, 1);

  ctx.render(pendingProps);
  assert.equal(
    ctx.container.querySelectorAll(".roman-question button").length,
    2,
  );
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
});
