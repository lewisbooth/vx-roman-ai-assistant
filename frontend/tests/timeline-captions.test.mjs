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
      export { latestQuestion } from './shared/questions';
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
  return { container, render: view.render, latestQuestion: dom.window.api.latestQuestion };
}

test("an upload-started preview follows the saved-image reply and precedes its quick answers", (t) => {
  const ctx = setup(t);
  const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const offered = question({voiceReply: undefined, question: "What shall we do while your preview prepares?"});
  const uploaded = message("context", {type: "media", version: 1, kind: "window", windowId: "photo", title: "Kitchen window", customerIntent: true});
  const accepted = message("context", {type: "media", version: 1, kind: "visualization", jobId: "preview", customerIntent: true, continuationRequestId: requestId});
  const saved = {...message("user", {type: "text", text: "My image Kitchen window is saved."}), requestId};
  const reply = message("assistant", {type: "text", text: "Soft neutral tones. Your preview is preparing."}, offered);
  const messages = [uploaded, accepted, saved, reply];
  const original = structuredClone(messages);
  ctx.render({messages, activeQuestionId: offered.invocationId, onAnswer: async () => {}, renderMedia: (part) => `CARD:${part.kind}`});
  const text = ctx.container.textContent;
  assert.ok(text.indexOf("CARD:window") < text.indexOf("My image Kitchen window is saved."));
  assert.ok(text.indexOf("My image Kitchen window is saved.") < text.indexOf("Soft neutral tones."));
  assert.ok(text.indexOf("Soft neutral tones.") < text.indexOf("CARD:visualization"));
  assert.ok(text.indexOf("CARD:visualization") < text.indexOf(offered.question));
  assert.equal(text.split("CARD:visualization").length - 1, 1);
  assert.deepEqual(messages, original, "Presentation must not rewrite stored history");
});

test("upload preview placement also follows spoken captions without repeating the photo", (t) => {
  const ctx = setup(t);
  const requestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const offered = question();
  const messages = [
    message("context", {type: "media", version: 1, kind: "window", windowId: "photo", title: "Kitchen window", customerIntent: true}),
    message("context", {type: "media", version: 1, kind: "visualization", jobId: "preview", customerIntent: true, continuationRequestId: requestId}),
    {...message("user", {type: "text", text: "My image is saved."}), requestId},
    message("assistant", caption("Your preview is preparing.")),
    message("context", offered),
  ];
  ctx.render({messages, activeQuestionId: offered.invocationId, voice: true, onAnswer: async () => {}, renderMedia: (part) => `CARD:${part.kind}`});
  const text = ctx.container.textContent;
  assert.ok(text.indexOf("Your preview is preparing.") < text.indexOf("CARD:visualization"));
  assert.ok(text.indexOf("CARD:visualization") < text.indexOf(offered.question));
  assert.equal(text.split("CARD:window").length - 1, 1);
});

test("preview placement preserves standalone events and does not attach an upload to a later conversation turn", (t) => {
  const ctx = setup(t);
  const accepted = message("context", {type: "media", version: 1, kind: "visualization", jobId: "preview", customerIntent: true, continuationRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"});
  for (const prefix of [[], [message("context", {type: "media", version: 1, kind: "window", windowId: "photo", title: "Kitchen", customerIntent: true})]]) {
    const messages = [...prefix, accepted,
      message("user", {type: "text", text: "My image is saved."}),
      message("user", {type: "text", text: "Help with another room instead."}),
      message("assistant", {type: "text", text: "Let's choose your next room."}),
    ];
    ctx.render({messages, renderMedia: (part) => `CARD:${part.kind}`});
    assert.ok(ctx.container.textContent.indexOf("CARD:visualization") < ctx.container.textContent.indexOf("My image is saved."));
  }
});

test("a suppressed upload continuation cannot place its preview beneath an unrelated single turn", (t) => {
  const ctx = setup(t);
  const messages = [
    message("context", {type: "media", version: 1, kind: "window", windowId: "photo", title: "Kitchen", customerIntent: true}),
    message("context", {type: "media", version: 1, kind: "visualization", jobId: "preview", customerIntent: true, continuationRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}),
    {...message("user", {type: "text", text: "Help with another room instead."}), requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff"},
    message("assistant", {type: "text", text: "Which room would you like to choose next?"}),
  ];
  ctx.render({messages, renderMedia: (part) => `CARD:${part.kind}`});
  assert.ok(ctx.container.textContent.indexOf("CARD:visualization") < ctx.container.textContent.indexOf("Help with another room instead."));
});

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

test("incidental input captions keep the offered voice answers visible and clickable", async (t) => {
  const ctx = setup(t);
  const offered = question();
  const messages = [
    message("context", offered),
    message("assistant", caption("Would you like a sample?")),
  ];
  const answers = [];
  const render = () => ctx.render({
    messages,
    activeQuestionId: ctx.latestQuestion(messages)?.invocationId,
    voice: true,
    onAnswer: async (...args) => answers.push(args),
  });
  render();
  const originalPanel = ctx.container.querySelector(".roman-question");
  for (const text of [" Hmm", " Mm", " Need to"]) {
    messages.push(message("user", caption(text)));
    render();
    assert.equal(ctx.container.querySelector(".roman-question"), originalPanel);
    assert.equal(originalPanel.querySelectorAll("button:not(:disabled)").length, 2);
  }
  ctx.container.querySelector(".roman-question button").click();
  await delay(0);
  assert.equal(answers.length, 1);
  assert.equal(answers[0][0], offered);
  assert.equal(answers[0][1], "Yes, a sample");
});

test("an accepted voice marker retires old controls without a visible transcript entry", (t) => {
  const ctx = setup(t);
  const offered = question();
  const marker = {
    type: "voice_turn",
    version: 1,
    voiceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    throughSequence: 3,
    offsetMs: 43600,
  };
  const messages = [
    message("context", offered),
    message("user", caption("Yes, a sample")),
  ];
  for (const status of ["pending", "complete"]) {
    const accepted = [...messages, { ...message("context", marker), status }];
    ctx.render({
      messages: accepted,
      activeQuestionId: ctx.latestQuestion(accepted)?.invocationId,
      voice: true,
      onAnswer: async () => assert.fail("An accepted answer cannot be submitted again."),
    });
    assert.equal(ctx.container.querySelector(".roman-question"), null);
    assert.equal(ctx.container.querySelectorAll(".roman-message").length, 1);
    assert.equal(ctx.container.querySelector(".roman-message-user p").textContent,
      "Yes, a sample");
    assert.doesNotMatch(ctx.container.textContent, /voice_turn|43600|eeeeeeee/);
  }
  const next = question({ question: "Would you like help measuring?", answers: ["Help me measure", "Keep browsing"] });
  const completed = [...messages, message("context", marker, next)];
  ctx.render({
    messages: completed,
    activeQuestionId: ctx.latestQuestion(completed)?.invocationId,
    voice: true,
    onAnswer: async () => {},
  });
  assert.equal(ctx.container.querySelector(".roman-question p").textContent, next.question);
  assert.deepEqual([...ctx.container.querySelectorAll(".roman-question button")].map((button) => button.textContent), next.answers);
  assert.doesNotMatch(ctx.container.textContent, /voice_turn|43600|eeeeeeee/);
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

test("one structured text question moves from its active card into plain history", (t) => {
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
  assert.equal(ctx.container.textContent.split(offered.question).length - 1, 1);
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
  assert.equal(history.querySelector(".roman-message-text").textContent, offered.question);
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
      1,
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
