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
    export * as voice from './admin/voice/repository.server';`,
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

test("voice cards follow only their result captions and retain exact durable records", () => {
  const voiceId = randomUUID();
  const widgetId = randomUUID();
  const widget = {
    id: widgetId,
    sequence: 1,
    role: "context",
    status: "complete",
    createdAt: new Date(),
    partsJson: JSON.stringify([
      {
        type: "products",
        version: 1,
        invocationId: randomUUID(),
        productIds: ["gid://shopify/Product/123"],
        voiceReply: { voiceId, afterSequence: 4 },
      },
    ]),
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
