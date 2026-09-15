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
    presentation: { callId: "cards-delegated", productIds: [productId] },
  });
  await caption(session, "Here are those blinds.", 200, "assistant");
  const state = await conversation.getSnapshot(id);
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[0].id, first.id);
  assert.equal(state.messages[1].id, delegated.assistantId);
  assert.equal(state.messages[1].role, "context");
  assert.deepEqual(
    state.messages[1].parts.map((part) => part.type),
    ["products"],
  );
  assert.deepEqual(state.messages[1].parts[0].productIds, [productId]);
  assert.equal(state.messages[2].parts[0].text, "Here are those blinds.");
  assert.ok(
    !(await conversation.getModelHistory(id)).some((entry) =>
      entry.text.includes("Not yet spoken"),
    ),
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
