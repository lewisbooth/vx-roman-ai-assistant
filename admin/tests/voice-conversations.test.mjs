import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * as conversation from './admin/conversations/repository.server';
    export * as voice from './admin/voice/repository.server';
    export { latestQuestion } from './shared/questions';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
let directory;
let database;
let conversation;
let voice;
let id;
let clock = Date.now();
const clientId = randomUUID();
const previousGlobal = global.prismaGlobal;
const previousAppUrl = process.env.SHOPIFY_APP_URL;
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
}
function load() {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "Date",
    bundle.outputFiles[0].text,
  )(require, module, module.exports, Clock);
  return module.exports;
}
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-voice-integration-"));
  database = new PrismaClient({
    datasourceUrl: `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`,
  });
  global.prismaGlobal = database;
  process.env.SHOPIFY_APP_URL = "https://roman.example.test";
  const migrations = (
    await readdir("prisma/migrations", { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(
      `prisma/migrations/${migration}/migration.sql`,
      "utf8",
    );
    for (const statement of sql
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await database.$executeRawUnsafe(statement);
  }
});
beforeEach(async () => {
  await database.conversation.deleteMany();
  clock = Date.now();
  ({ conversation, voice } = load());
  ({ conversationId: id } = await conversation.createConversation(
    "hd-dev-single.myshopify.com",
    "https://hd-dev-single.myshopify.com",
  ));
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
  if (previousAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = previousAppUrl;
});
async function startVoice() {
  return (
    await voice.reserveVoiceSession(id, { voiceId: randomUUID(), clientId })
  ).session;
}
async function caption(session, text, startMs, role = "user") {
  return voice.appendVoiceTranscript(id, session.id, {
    providerEventId: randomUUID(),
    role,
    text,
    startMs,
    endMs: startMs + 100,
  });
}
function textInput(text) {
  return { requestId: randomUUID(), text };
}
async function journey() {
  return conversation.appendJourney(id, {
    requestId: randomUUID(),
    title: "Blackout roller",
    path: "/products/blackout-roller",
    occurredAt: new Date(clock).toISOString(),
  });
}

test("text, exact voice captions and journey observations share one ordered history", async () => {
  const first = await conversation.beginTurn(id, textInput("I want blackout."));
  await conversation.finishTurn(id, first.assistantId, {
    text: "Which window?",
    status: "complete",
  });
  const session = await startVoice();
  const width = await caption(session, "300", 0);
  await caption(session, " x 400", 150);
  let state = await conversation.getSnapshot(id);
  assert.equal(state.messages[2].id, width.id);
  assert.equal(state.messages[2].parts[0].text, "300 x 400");
  await journey();
  await caption(session, " mm", 300);
  await caption(session, "I can help.", 500, "assistant");
  await voice.closeVoiceSession(id, session.id, clientId);
  const next = await conversation.beginTurn(id, textInput("What next?"));
  assert.deepEqual(
    next.history.map((entry) => entry.role),
    ["user", "assistant", "user", "user", "user", "assistant", "user"],
  );
  assert.deepEqual(
    next.history
      .map((entry) => entry.text)
      .filter((text) => !text.startsWith("Untrusted")),
    [
      "I want blackout.",
      "Which window?",
      "300 x 400",
      " mm",
      "I can help.",
      "What next?",
    ],
  );
  assert.match(
    next.history[3].text,
    /Untrusted storefront observations.*Blackout roller/,
  );
  state = await conversation.getSnapshot(id);
  assert.equal(state.messages[2].id, width.id);
  assert.equal(state.messages[3].parts[0].type, "page_view");
  assert.equal(state.messages[4].parts[0].text, " mm");
  assert.equal(await database.voiceTranscript.count(), 4);
  assert.equal(await database.conversationMessage.count(), 5);
  const stored = await database.conversationMessage.findMany();
  assert.ok(
    stored.every(
      (row) => !JSON.parse(row.partsJson).some((part) => part.type === "voice"),
    ),
  );
});

test("late input ASR projects before Roman's reply on reload and in model history without rewriting captions", async () => {
  const session = await startVoice();
  const reply = await caption(session, "Great.", 200, "assistant");
  const customer = await caption(session, "Sure", 0);
  await caption(session, "!", 100);
  await caption(session, " Let's continue.", 500, "assistant");
  const raw = await database.voiceTranscript.findMany({
    orderBy: { sequence: "asc" },
  });
  const expected = [
    { role: "user", text: "Sure!" },
    { role: "assistant", text: "Great. Let's continue." },
  ];
  for (let read = 0; read < 2; read++) {
    const state = await conversation.getSnapshot(id);
    assert.deepEqual(
      state.messages.map((message) => ({
        role: message.role,
        text: message.parts[0].text,
      })),
      expected,
    );
    assert.deepEqual(
      state.messages.map((message) => message.id),
      [customer.id, reply.id],
    );
    assert.deepEqual(await conversation.getModelHistory(id), expected);
    if (read === 0) {
      await voice.closeVoiceSession(id, session.id, clientId);
      ({ conversation, voice } = load());
    }
  }
  assert.deepEqual(
    await database.voiceTranscript.findMany({ orderBy: { sequence: "asc" } }),
    raw,
  );
  assert.deepEqual(
    raw.map((row) => row.text),
    ["Great.", "Sure", "!", " Let's continue."],
  );
  const next = await conversation.beginTurn(id, textInput("What next?"));
  assert.deepEqual(next.history, [
    ...expected,
    { role: "user", text: "What next?" },
  ]);
});

test("voice delegation has one hidden context owner and never fabricates spoken transcript", async () => {
  const session = await startVoice();
  await caption(session, "Show me blackout options", 0);
  const input = textInput("");
  const delegated = await conversation.beginTurn(id, input, session.id);
  assert.equal(delegated.snapshot.busy, true);
  assert.equal(delegated.snapshot.messages.length, 1);
  assert.deepEqual(delegated.history, [
    { role: "user", text: "Show me blackout options" },
  ]);
  const pending = await database.conversationMessage.findUniqueOrThrow({
    where: { id: delegated.assistantId },
  });
  assert.equal(pending.role, "context");
  assert.equal(pending.status, "pending");
  assert.deepEqual(JSON.parse(pending.partsJson), []);
  assert.equal(
    (await conversation.beginTurn(id, input, session.id)).assistantId,
    null,
  );
  await assert.rejects(
    conversation.beginTurn(id, textInput("Concurrent typed message")),
    { status: 409 },
  );
  await assert.rejects(conversation.beginTurn(id, textInput(""), session.id), {
    status: 409,
  });
  await conversation.finishTurn(id, delegated.assistantId, {
    text: "Private delegation result.",
    status: "complete",
  });
  const completed = await conversation.getSnapshot(id);
  assert.equal(completed.busy, false);
  assert.equal(completed.messages.length, 1);
  assert.deepEqual(await conversation.getModelHistory(id), delegated.history);
  assert.equal(await database.voiceTranscript.count(), 1);
});

test("empty delegation bookkeeping does not split a spoken reply during or after completion", async () => {
  const session = await startVoice();
  const first = await caption(session, "Hello", 0, "assistant");
  const delegated = await conversation.beginTurn(id, textInput(""), session.id);
  await caption(session, " there", 1200, "assistant");
  const pending = await conversation.getSnapshot(id);
  assert.equal(pending.busy, true);
  assert.equal(pending.messages.length, 1);
  assert.equal(pending.messages[0].id, first.id);
  assert.equal(pending.messages[0].parts[0].text, "Hello there");
  await conversation.finishTurn(id, delegated.assistantId, {
    text: "Private briefing",
    status: "complete",
  });
  await caption(session, ". How can I help?", 2800, "assistant");
  const completed = await conversation.getSnapshot(id);
  assert.equal(completed.messages.length, 1);
  assert.equal(completed.messages[0].id, first.id);
  assert.equal(
    completed.messages[0].parts[0].text,
    "Hello there. How can I help?",
  );
  assert.equal(await database.voiceTranscript.count(), 3);
  assert.deepEqual(await conversation.getModelHistory(id), [
    { role: "assistant", text: "Hello there. How can I help?" },
  ]);
});

for (const entry of [
  {
    label: "confirmed navigation",
    role: "context",
    status: "complete",
    parts: [
      {
        type: "navigation",
        version: 1,
        invocationId: "6dedf5cd-9d29-4c06-bcf6-ce5d3b49b7a9",
        path: "/products/shade",
        title: "Shade",
      },
    ],
  },
  {
    label: "confirmed additions",
    role: "context",
    status: "complete",
    parts: [
      {
        type: "cart_added",
        version: 1,
        invocationId: "6dedf5cd-9d29-4c06-bcf6-ce5d3b49b7a9",
        product: { productPath: "/products/shade", title: "Configured shade" },
      },
    ],
  },
  {
    label: "page visits",
    role: "context",
    status: "complete",
    parts: [
      {
        type: "page_view",
        version: 1,
        title: "Roller blinds",
        path: "/collections/all",
        occurredAt: "2026-09-16T12:00:00.000Z",
      },
    ],
  },
  {
    label: "product widgets",
    role: "context",
    status: "complete",
    parts: [
      {
        type: "products",
        version: 1,
        invocationId: "6dedf5cd-9d29-4c06-bcf6-ce5d3b49b7a9",
        productIds: ["gid://shopify/Product/123"],
      },
    ],
  },
  {
    label: "text messages",
    role: "assistant",
    status: "complete",
    parts: [{ type: "text", text: "A saved text reply" }],
  },
  {
    label: "failed delegation rows",
    role: "context",
    status: "failed",
    parts: [],
  },
]) {
  test(`visible ${entry.label} remain ordered boundaries between voice captions`, async () => {
    const session = await startVoice();
    const first = await caption(session, "Before", 0, "assistant");
    const boundary = await database.conversationMessage.create({
      data: {
        id: randomUUID(),
        conversationId: id,
        requestId: randomUUID(),
        sequence: 1,
        role: entry.role,
        status: entry.status,
        partsJson: JSON.stringify(entry.parts),
        ...(entry.status === "failed"
          ? { error: "Work was interrupted." }
          : {}),
      },
    });
    await database.conversation.update({
      where: { id },
      data: { nextSequence: 2 },
    });
    const last = await caption(session, " after", 400, "assistant");
    const state = await conversation.getSnapshot(id);
    assert.deepEqual(
      state.messages.map((message) => message.id),
      [first.id, boundary.id, last.id],
    );
    assert.equal(state.messages[0].parts[0].text, "Before");
    assert.equal(state.messages[2].parts[0].text, " after");
  });
}

test("voice and text ownership excludes other sessions and newer cancellation tombstones", async () => {
  const session = await startVoice();
  await assert.rejects(
    conversation.beginTurn(id, textInput(""), randomUUID()),
    { status: 409 },
  );
  await assert.rejects(conversation.beginTurn(id, textInput("Typed")), {
    status: 409,
  });
  clock++;
  await voice.cancelVoiceSession(id, randomUUID(), clientId);
  const state = await conversation.getSnapshot(id);
  assert.equal(state.voice.id, session.id);
  await assert.rejects(conversation.beginTurn(id, textInput("Still typed")), {
    status: 409,
  });
  const delegated = await conversation.beginTurn(id, textInput(""), session.id);
  assert.ok(delegated.assistantId);
});

test("a delegated presentation persists only its selected widget beside actual provider captions", async () => {
  const session = await startVoice();
  const first = await caption(session, "Show me a carousel", 0);
  const delegated = await conversation.beginTurn(id, textInput(""), session.id);
  const productId = "gid://shopify/Product/123";
  const tool = await conversation.createToolInvocation(
    id,
    delegated.assistantId,
    {
      providerCallId: "lookup-delegated",
      name: "lookup_catalog",
      arguments: { ids: [productId] },
    },
  );
  const claim = { clientId, claimToken: randomBytes(32).toString("base64url") };
  await conversation.claimToolInvocation(id, tool.id, claim);
  await conversation.completeToolInvocation(id, tool.id, claim, {
    productIds: [productId],
  });
  await conversation.finishTurn(id, delegated.assistantId, {
    status: "complete",
    text: "Not yet spoken.",
    voiceId: session.id,
    presentation: { callId: "cards-delegated", productIds: [productId] },
  });
  const beforeSpeech = await conversation.getSnapshot(id);
  assert.equal(beforeSpeech.messages[1].id, delegated.assistantId);
  assert.deepEqual(beforeSpeech.messages[1].parts[0].voiceReply, {
    voiceId: session.id,
    afterSequence: 2,
  });
  await caption(session, "Here are those blinds.", 200, "assistant");
  const state = await conversation.getSnapshot(id);
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[0].id, first.id);
  assert.equal(state.messages[2].id, delegated.assistantId);
  assert.equal(state.messages[2].role, "context");
  assert.deepEqual(
    state.messages[2].parts.map((part) => part.type),
    ["products"],
  );
  assert.deepEqual(state.messages[2].parts[0].productIds, [productId]);
  assert.equal(state.messages[1].parts[0].text, "Here are those blinds.");
  assert.ok(
    !(await conversation.getModelHistory(id)).some((entry) =>
      entry.text.includes("Not yet spoken"),
    ),
  );
});

for (const widgetKinds of [
  ["products"],
  ["guides"],
  ["question"],
  ["products", "guides", "question"],
])
  test(`voice ${widgetKinds.join(" and ")} follow only their result captions and retain exact durable records`, () => {
    const voiceId = randomUUID();
    const widgetId = randomUUID();
    const widget = {
      id: widgetId,
      sequence: 1,
      role: "context",
      status: "complete",
      createdAt: new Date(),
      partsJson: JSON.stringify(
        widgetKinds.map((type) => ({
          type,
          version: 1,
          invocationId: randomUUID(),
          ...(type === "products"
            ? { productIds: ["gid://shopify/Product/123"] }
            : type === "question"
              ? { question: "Which room?", answers: ["Bedroom", "Kitchen"] }
              : {
                  productPath: "/products/shade",
                  guides: [
                    {
                      kind: "measuring",
                      url: "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring.pdf?v=123",
                    },
                  ],
                }),
          voiceReply: { voiceId, afterSequence: 4 },
        })),
      ),
    };
    const fragment = (sequence, text, role = "assistant", extra = {}) => ({
      id: `caption-${sequence}`,
      voiceId,
      sequence,
      role,
      text,
      startMs: sequence * 300,
      endMs: sequence * 300 + 100,
      createdAt: new Date(),
      ...extra,
    });
    const base = {
      origin: "https://hd-dev-single.myshopify.com",
      messages: [widget],
      voiceTranscripts: [
        fragment(0, "Find blinds", "user"),
        fragment(2, "Let me"),
        fragment(3, " check."),
        fragment(4, "Here are"),
        fragment(5, " the options."),
      ],
    };
    const original = structuredClone(base);
    let rows = conversation.conversationTimeline(base);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["caption-0", "caption-2", "caption-4", widgetId],
    );
    assert.equal(rows[1].parts[0].text, "Let me check.");
    assert.equal(rows[2].parts[0].text, "Here are the options.");
    assert.deepEqual(base, original);
    // The final response fragment can arrive after the customer's next caption.
    // Widget placement must use the projected response end, not that fragment's
    // later arrival sequence, or it crosses the customer's next utterance.
    rows = conversation.conversationTimeline({
      ...base,
      voiceTranscripts: [
        ...base.voiceTranscripts.slice(0, 4),
        fragment(5, "Thanks", "user", { startMs: 1900, endMs: 2000 }),
        fragment(6, " the options.", "assistant", {
          startMs: 1600,
          endMs: 1800,
        }),
        fragment(7, "You're welcome", "assistant", {
          startMs: 2100,
          endMs: 2300,
        }),
      ],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      [
        "caption-0",
        "caption-2",
        "caption-4",
        widgetId,
        "caption-5",
        "caption-7",
      ],
    );
    assert.equal(rows[2].parts[0].text, "Here are the options.");
    for (const barrier of [
      {
        ...widget,
        id: "next-delegation",
        sequence: 6,
        status: "pending",
        partsJson: "[]",
      },
      {
        ...widget,
        id: "page",
        sequence: 6,
        partsJson: JSON.stringify([
          {
            type: "page_view",
            version: 1,
            title: "Blinds",
            path: "/collections/all",
            occurredAt: new Date().toISOString(),
          },
        ]),
      },
      {
        ...widget,
        id: "typed",
        sequence: 6,
        role: "user",
        partsJson: JSON.stringify([{ type: "text", text: "Something else" }]),
      },
    ]) {
      rows = conversation.conversationTimeline({
        ...base,
        messages: [widget, barrier],
        voiceTranscripts: [
          ...base.voiceTranscripts,
          fragment(7, "An unrelated follow-up"),
        ],
      });
      assert.ok(
        rows.findIndex((row) => row.id === widgetId) <
          rows.findIndex((row) => row.id === barrier.id),
      );
      assert.ok(
        rows.findIndex((row) => row.id === barrier.id) <
          rows.findIndex((row) => row.id === "caption-7"),
      );
    }
    for (const extra of [{ role: "user" }, { voiceId: randomUUID() }]) {
      rows = conversation.conversationTimeline({
        ...base,
        voiceTranscripts: [
          ...base.voiceTranscripts,
          fragment(6, "New turn", "assistant", extra),
          fragment(7, "Later reply"),
        ],
      });
      assert.ok(
        rows.findIndex((row) => row.id === widgetId) <
          rows.findIndex((row) => row.id === "caption-6"),
      );
    }
  });

test("combined voice products, guides and question persist after captions without crossing later customer replies", async () => {
  const session = await startVoice();
  await caption(session, "Show this blind and its guides.", 0);
  const turn = await conversation.beginTurn(id, textInput(""), session.id);
  const productIds = ["gid://shopify/Product/123"];
  const productPath = "/products/shade";
  const guides = [
    {
      kind: "fitting",
      url: "https://hd-dev-single.myshopify.com/cdn/shop/files/fitting.pdf?v=123",
    },
  ];
  for (const [providerCallId, name, args, result] of [
    ["lookup", "lookup_catalog", { ids: productIds }, { productIds }],
    [
      "guides",
      "get_product_guides",
      { productPath },
      { productIds: [], outcome: { status: "found", productPath, guides } },
    ],
  ]) {
    const tool = await conversation.createToolInvocation(id, turn.assistantId, {
      providerCallId,
      name,
      arguments: args,
    });
    const claim = {
      clientId,
      claimToken: randomBytes(32).toString("base64url"),
    };
    await conversation.claimToolInvocation(id, tool.id, claim);
    await conversation.completeToolInvocation(id, tool.id, claim, result);
  }
  await conversation.finishTurn(id, turn.assistantId, {
    status: "complete",
    text: "UNSPOKEN_BRIEFING",
    voiceId: session.id,
    presentation: { callId: "show-products", productIds },
    guidePresentation: {
      callId: "show-guides",
      sourceCallId: "guides",
      productPath,
      kinds: ["fitting"],
    },
    questionPresentation: {
      callId: "ask-question",
      question: "Which room?",
      answers: ["Bedroom", "Kitchen"],
    },
  });
  const spoken = await caption(
    session,
    "Here is the blind and its fitting guide link.",
    200,
    "assistant",
  );
  const snapshot = await conversation.getSnapshot(id);
  const widget = snapshot.messages.at(-1);
  assert.equal(snapshot.messages.at(-2).id, spoken.id);
  assert.equal(widget.id, turn.assistantId);
  assert.deepEqual(
    widget.parts.map((part) => part.type),
    ["products", "guides", "question"],
  );
  assert.deepEqual(widget.parts[1].guides, guides);
  assert.deepEqual(widget.parts[0].voiceReply, widget.parts[1].voiceReply);
  assert.deepEqual(widget.parts[0].voiceReply, widget.parts[2].voiceReply);
  const history = await conversation.getModelHistory(id);
  assert.match(history.at(-2).text, /"type":"guides"/);
  assert.deepEqual(history.at(-1), {
    role: "assistant",
    text: 'Which room?\nSuggested answers: ["Bedroom","Kitchen"]',
  });
  assert.doesNotMatch(JSON.stringify(history), /UNSPOKEN_BRIEFING/);
  const pending = await conversation.beginTurn(id, textInput(""), session.id);
  await conversation.finishTurn(id, pending.assistantId, {
    status: "failed",
    text: "",
    error: "Cancelled.",
  });
  await voice.closeVoiceSession(id, session.id, clientId);
  const next = await startVoice();
  await caption(next, "A different question.", 0);
  const after = await conversation.getSnapshot(id);
  assert.deepEqual(
    after.messages.find((message) => message.id === widget.id),
    widget,
  );
  assert.ok(
    after.messages.findIndex((message) => message.id === widget.id) <
      after.messages.findIndex((message) => message.id === pending.assistantId),
  );
  assert.ok(
    after.messages.findIndex((message) => message.id === widget.id) <
      after.messages.length - 1,
  );
});

test("ending chat closes voice and delegated work atomically while retaining captions", async () => {
  const session = await startVoice();
  await caption(session, "My kitchen", 0);
  const delegated = await conversation.beginTurn(id, textInput(""), session.id);
  const ended = await conversation.endConversation(id);
  assert.equal(ended.status, "ended");
  assert.equal(ended.voice.status, "closed");
  assert.equal(ended.busy, false);
  assert.equal(ended.messages[0].parts[0].text, "My kitchen");
  await assert.rejects(caption(session, "Late audio", 200), { status: 409 });
  await conversation.finishTurn(id, delegated.assistantId, {
    text: "Late answer",
    status: "complete",
  });
  assert.deepEqual(await conversation.getSnapshot(id), ended);
});

test("restart recovery fails hidden delegation ownership and voice without duplicating captions", async () => {
  const session = await startVoice();
  await caption(session, "Find a blind", 0);
  const delegated = await conversation.beginTurn(id, textInput(""), session.id);
  clock++;
  const restarted = load();
  await restarted.conversation.failPending(id);
  const state = await restarted.conversation.getSnapshot(id);
  assert.equal(state.voice.status, "failed");
  assert.equal(state.busy, false);
  assert.equal(state.messages[0].parts[0].text, "Find a blind");
  assert.equal(state.messages[1].id, delegated.assistantId);
  assert.equal(state.messages[1].status, "failed");
  assert.deepEqual(await restarted.conversation.getModelHistory(id), [
    { role: "user", text: "Find a blind" },
  ]);
});

async function questionDuringVoice() {
  const session = await startVoice();
  await voice.activateVoiceSession(
    id,
    session.id,
    clientId,
    "live-question-fixture",
  );
  const turn = await conversation.beginTurn(id, textInput(""), session.id);
  // The triggering caption can arrive after the reserved delegation row. The
  // completed widget must still follow it in the canonical timeline.
  await caption(session, "Help me choose", 0);
  await conversation.finishTurn(id, turn.assistantId, {
    status: "complete",
    text: "Which room?",
    voiceId: session.id,
    questionPresentation: {
      callId: "question-fixture",
      question: "Which room?",
      answers: ["Bedroom", "Kitchen"],
    },
  });
  const question = load().latestQuestion(
    (await conversation.getSnapshot(id)).messages,
  );
  assert.ok(question);
  const input = {
    clientId,
    requestId: randomUUID(),
    questionId: question.invocationId,
    answer: "Bedroom",
  };
  return { session, input, question };
}

test("a selected voice answer saves customer text, retires its question and leaves voice connected without a Terra turn", async () => {
  const { session, input } = await questionDuringVoice();
  await journey();
  const before = await database.conversation.findUniqueOrThrow({
    where: { id },
  });
  const messagesBefore = await database.conversationMessage.count();
  const captionsBefore = await database.voiceTranscript.count();
  assert.equal(
    await conversation.findVoiceQuestionAnswer(id, session.id, input),
    null,
  );
  const saved = await conversation.appendVoiceQuestionAnswer(
    id,
    session.id,
    input,
  );
  assert.deepEqual(saved, {
    created: true,
    messageId: input.requestId,
    sequence: before.nextSequence,
    question: "Which room?",
    answer: "Bedroom",
  });
  const snapshot = await conversation.getSnapshot(id);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.voice.id, session.id);
  assert.equal(snapshot.voice.status, "active");
  assert.equal(load().latestQuestion(snapshot.messages), undefined);
  assert.deepEqual(snapshot.messages.at(-1).parts, [
    {
      type: "text",
      text: "Bedroom",
      questionAnswer: { questionId: input.questionId, voiceId: session.id },
    },
  ]);
  assert.equal(snapshot.messages.at(-1).id, input.requestId);
  assert.deepEqual((await conversation.getModelHistory(id)).at(-1), {
    role: "user",
    text: "Bedroom",
  });
  const after = await database.conversation.findUniqueOrThrow({
    where: { id },
  });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.nextSequence, before.nextSequence + 1);
  assert.equal(after.turnCount, before.turnCount);
  assert.equal(after.pendingRequestId, null);
  assert.equal(await database.conversationMessage.count(), messagesBefore + 1);
  assert.equal(await database.voiceTranscript.count(), captionsBefore);
});

test("concurrent retries persist one answer receipt and a second choice cannot answer the same question", async () => {
  const { session, input } = await questionDuringVoice();
  const receipts = await Promise.all([
    conversation.appendVoiceQuestionAnswer(id, session.id, input),
    conversation.appendVoiceQuestionAnswer(id, session.id, input),
  ]);
  assert.deepEqual(receipts.map((receipt) => receipt.created).sort(), [
    false,
    true,
  ]);
  assert.equal(
    await database.conversationMessage.count({ where: { role: "user" } }),
    1,
  );
  await assert.rejects(
    conversation.appendVoiceQuestionAnswer(id, session.id, {
      ...input,
      requestId: randomUUID(),
      answer: "Kitchen",
    }),
    { status: 409 },
  );
  assert.deepEqual(
    await conversation.findVoiceQuestionAnswer(id, session.id, input),
    {
      ...receipts[0],
      created: false,
    },
  );
});

test("selected-answer receipts survive stop, End and process restart without reopening voice", async () => {
  const { session, input } = await questionDuringVoice();
  const original = await conversation.appendVoiceQuestionAnswer(
    id,
    session.id,
    input,
  );
  await voice.closeVoiceSession(id, session.id, clientId);
  await conversation.endConversation(id);
  clock++;
  const restarted = load().conversation;
  const before = await restarted.getSnapshot(id);
  assert.deepEqual(
    await restarted.findVoiceQuestionAnswer(id, session.id, input),
    { ...original, created: false },
  );
  assert.deepEqual(
    await restarted.appendVoiceQuestionAnswer(id, session.id, input),
    { ...original, created: false },
  );
  assert.deepEqual(await restarted.getSnapshot(id), before);
  assert.equal(before.status, "ended");
  assert.equal(before.voice.status, "closed");
});

test("selected-answer retries reject altered content, question, voice owner and request namespace collisions", async () => {
  const { session, input } = await questionDuringVoice();
  await conversation.appendVoiceQuestionAnswer(id, session.id, input);
  for (const changed of [{ answer: "Kitchen" }, { questionId: randomUUID() }]) {
    await assert.rejects(
      conversation.findVoiceQuestionAnswer(id, session.id, {
        ...input,
        ...changed,
      }),
      { status: 400 },
    );
    await assert.rejects(
      conversation.appendVoiceQuestionAnswer(id, session.id, {
        ...input,
        ...changed,
      }),
      { status: 400 },
    );
  }
  await assert.rejects(
    conversation.findVoiceQuestionAnswer(id, session.id, {
      ...input,
      clientId: randomUUID(),
    }),
    { status: 404 },
  );
  await assert.rejects(
    conversation.findVoiceQuestionAnswer(id, randomUUID(), input),
    { status: 404 },
  );
  const ordinary = await database.conversationMessage.findFirstOrThrow({
    where: { role: "context" },
  });
  await assert.rejects(
    conversation.findVoiceQuestionAnswer(id, session.id, {
      ...input,
      requestId: ordinary.requestId,
    }),
    { status: 400 },
  );
  const { conversationId: otherId } = await conversation.createConversation(
    "hd-dev-single.myshopify.com",
    "https://hd-dev-single.myshopify.com",
  );
  const otherSession = (
    await voice.reserveVoiceSession(otherId, {
      voiceId: randomUUID(),
      clientId,
    })
  ).session;
  await assert.rejects(
    conversation.findVoiceQuestionAnswer(otherId, otherSession.id, input),
    { status: 400 },
  );
});

test("only an exact offered answer to the current question can become durable customer text", async () => {
  const { session, input } = await questionDuringVoice();
  for (const changed of [
    { answer: "Buy everything" },
    { answer: " Bedroom " },
    { questionId: randomUUID() },
  ])
    await assert.rejects(
      conversation.appendVoiceQuestionAnswer(id, session.id, {
        ...input,
        ...changed,
      }),
      { status: 409 },
    );
  for (const changed of [
    { answer: "" },
    { answer: "x".repeat(81) },
    { requestId: "invalid" },
    { clientId: [clientId] },
    { extra: true },
  ])
    await assert.rejects(
      conversation.appendVoiceQuestionAnswer(id, session.id, {
        ...input,
        ...changed,
      }),
      { status: 400 },
    );
  await caption(session, "Actually, another room", 500);
  await assert.rejects(
    conversation.appendVoiceQuestionAnswer(id, session.id, input),
    { status: 409 },
  );
  assert.equal(
    await database.conversationMessage.count({ where: { role: "user" } }),
    0,
  );
});

for (const invalidState of [
  "starting",
  "closed",
  "expired",
  "duration",
  "restarted",
  "ended",
  "busy",
  "superseded",
]) {
  test(`a fresh selected answer rejects ${invalidState} state without persisting an answer`, async () => {
    const { session, input } = await questionDuringVoice();
    if (invalidState === "starting" || invalidState === "closed")
      await database.voiceSession.update({
        where: { id: session.id },
        data: { status: invalidState },
      });
    if (invalidState === "expired") clock += voice.VOICE_LEASE_MS;
    if (invalidState === "duration") {
      clock += voice.MAX_VOICE_DURATION_MS;
      await database.voiceSession.update({
        where: { id: session.id },
        data: { leaseExpiresAt: new Date(clock + 1000) },
      });
    }
    let repository = conversation;
    if (invalidState === "restarted") {
      clock++;
      repository = load().conversation;
    }
    if (invalidState === "ended") await conversation.endConversation(id);
    if (invalidState === "busy" || invalidState === "superseded") {
      const turn = await conversation.beginTurn(id, textInput(""), session.id);
      if (invalidState === "superseded")
        await conversation.finishTurn(id, turn.assistantId, {
          text: "Another question",
          status: "complete",
          voiceId: session.id,
          questionPresentation: {
            callId: "new-question",
            question: "Which colour?",
            answers: ["White", "Grey"],
          },
        });
    }
    await assert.rejects(
      repository.appendVoiceQuestionAnswer(id, session.id, input),
      { status: 409 },
    );
    assert.equal(
      await database.conversationMessage.count({ where: { role: "user" } }),
      0,
    );
  });
}

test("selected answers have an independent bounded write allowance and preserve exact retry receipts at the limit", async () => {
  const { session, input, question } = await questionDuringVoice();
  const first = await conversation.appendVoiceQuestionAnswer(
    id,
    session.id,
    input,
  );
  const rows = Array.from({ length: 39 }, (_, index) => {
    const requestId = randomUUID();
    return {
      id: requestId,
      conversationId: id,
      requestId,
      sequence: 100 + index,
      role: "user",
      status: "complete",
      partsJson: JSON.stringify([
        {
          type: "text",
          text: "Bedroom",
          questionAnswer: {
            questionId: question.invocationId,
            voiceId: session.id,
          },
        },
      ]),
    };
  });
  await database.conversationMessage.createMany({ data: rows });
  const nextQuestion = { ...question, invocationId: randomUUID() };
  delete nextQuestion.voiceReply;
  await database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId: id,
      requestId: randomUUID(),
      sequence: 139,
      role: "assistant",
      status: "complete",
      partsJson: JSON.stringify([nextQuestion]),
    },
  });
  await database.conversation.update({
    where: { id },
    data: { nextSequence: 140 },
  });
  await assert.rejects(
    conversation.appendVoiceQuestionAnswer(id, session.id, {
      ...input,
      requestId: randomUUID(),
      questionId: nextQuestion.invocationId,
    }),
    { status: 429 },
  );
  assert.deepEqual(
    await conversation.appendVoiceQuestionAnswer(id, session.id, input),
    { ...first, created: false },
  );
  assert.equal(
    await database.conversationMessage.count({ where: { role: "user" } }),
    40,
  );
});
