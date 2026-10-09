import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: "export * from './admin/insights/session-metrics.server';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
const shop = "metrics.myshopify.com";
const range = { from: "2026-10-01", to: "2026-10-09" };
const at = new Date("2026-10-09T12:00:00.000Z");
const empty = {
  sessions: 0,
  voiceSessions: 0,
  textSessions: 0,
  visualizerSessions: 0,
  sampleCartSessions: 0,
  productCartSessions: 0,
};
const previousGlobal = global.prismaGlobal;
let directory;
let database;
let repository;
const queries = [];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-session-metrics-"));
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });
  database.$on("query", (event) => queries.push(event));
  global.prismaGlobal = database;
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  repository = module.exports;
});

beforeEach(async () => {
  await database.toolInvocation.deleteMany();
  await database.voiceTranscript.deleteMany();
  await database.visualizationJob.deleteMany();
  await database.windowPhoto.deleteMany();
  await database.galleryOwner.deleteMany();
  await database.conversationMessage.deleteMany();
  await database.voiceSession.deleteMany();
  await database.conversation.deleteMany();
  queries.length = 0;
});

after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});

function conversationData(overrides = {}) {
  const id = randomUUID();
  return {
    id,
    shop,
    origin: `https://${shop}`,
    credentialHash: `synthetic-${id}`,
    credentialExpiresAt: new Date(0),
    createdAt: at,
    ...overrides,
  };
}

async function conversation(overrides = {}) {
  return database.conversation.create({ data: conversationData(overrides) });
}

async function message(conversationId, overrides = {}) {
  return database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId,
      requestId: randomUUID(),
      sequence: 1,
      role: "assistant",
      status: "complete",
      createdAt: at,
      ...overrides,
    },
  });
}

async function voice(conversationId, overrides = {}) {
  return database.voiceSession.create({
    data: {
      id: randomUUID(),
      conversationId,
      clientId: "synthetic-client",
      status: "closed",
      leaseExpiresAt: at,
      createdAt: at,
      ...overrides,
    },
  });
}

async function cartTool(conversationId, assistantId, overrides = {}) {
  return database.toolInvocation.create({
    data: {
      id: randomUUID(),
      conversationId,
      assistantId,
      providerCallId: randomUUID(),
      name: "add_to_cart",
      argumentsJson: "{}",
      resultJson: '{"status":"added","message":"Added."}',
      status: "complete",
      completedAt: at,
      ...overrides,
    },
  });
}

async function photo(conversationId) {
  const owner = await database.galleryOwner.create({
    data: {
      id: randomUUID(),
      shop,
      origin: `https://${shop}`,
      tokenHash: randomUUID(),
    },
  });
  return database.windowPhoto.create({
    data: {
      id: randomUUID(),
      ownerId: owner.id,
      conversationId,
      requestId: randomUUID(),
      requestHash: "synthetic-hash",
      title: "Room",
      assetKey: "synthetic.jpg",
      sha256: "synthetic-hash",
      width: 100,
      height: 100,
      bytes: 100,
      consentVersion: "v2",
      consentAt: at,
      uploadStatus: "ready",
    },
  });
}

function jobData(room, overrides = {}) {
  return {
    id: randomUUID(),
    ownerId: room.ownerId,
    windowId: room.id,
    conversationId: room.conversationId,
    requestId: randomUUID(),
    requestHash: "synthetic-hash",
    windowRevision: 1,
    windowTitle: room.title,
    sourceAssetKey: room.assetKey,
    productPath: "/products/synthetic",
    productTitle: "Synthetic blind",
    cleanup: true,
    promptVersion: "synthetic",
    width: 100,
    height: 100,
    deadlineAt: at,
    ...overrides,
  };
}

test("empty and invalid ranges require no history scan", async () => {
  assert.deepEqual(await repository.getSessionMetrics(shop, range), empty);
  queries.length = 0;
  await assert.rejects(
    repository.getSessionMetrics(shop, { from: "2026-02-30", to: range.to }),
    RangeError,
  );
  assert.equal(queries.length, 0);
});

test("creation cohorts include both UTC boundaries and exclude other merchants", async () => {
  for (const createdAt of [
    new Date("2026-10-01T00:00:00.000Z"),
    new Date("2026-10-09T23:59:59.999Z"),
    new Date("2026-09-30T23:59:59.999Z"),
    new Date("2026-10-10T00:00:00.000Z"),
  ])
    await conversation({ createdAt });
  await conversation({ shop: "other.myshopify.com" });
  queries.length = 0;
  assert.deepEqual(await repository.getSessionMetrics(shop, range), {
    ...empty,
    sessions: 2,
    textSessions: 2,
  });
  assert.equal(queries.length, 1);
});

test("only started voice and confirmed activities count once, including later activity and deleted previews", async () => {
  const textOnly = await conversation();
  const started = await conversation();
  const historical = await conversation();
  const uploaded = await conversation();
  const rejected = await conversation();
  // A provider connected before the browser is ready does not prove voice use.
  await voice(textOnly.id, {
    providerId: "provider-before-ready",
    status: "failed",
  });
  const firstVoice = await voice(started.id, { providerId: "connected" });
  await voice(started.id, { status: "failed" });
  await message(started.id, {
    requestId: `voice:${firstVoice.id}:started`,
    role: "context",
  });
  const oldVoice = await voice(historical.id);
  await database.voiceTranscript.create({
    data: {
      id: randomUUID(),
      voiceId: oldVoice.id,
      conversationId: historical.id,
      providerEventId: "synthetic",
      sequence: 1,
      role: "user",
      text: "A historical spoken request",
      startMs: 0,
      endMs: 100,
    },
  });
  await photo(uploaded.id);
  const room = await photo(started.id);
  await database.visualizationJob.createMany({
    data: [
      jobData(room, { status: "failed", deletedAt: at }),
      jobData(room, { status: "awaiting_product" }),
    ],
  });
  const assistant = await message(started.id, {
    sequence: 2,
    status: "failed",
  });
  const later = new Date("2026-10-12T12:00:00.000Z");
  await cartTool(started.id, assistant.id, { completedAt: later });
  await cartTool(started.id, assistant.id, { completedAt: later });
  await cartTool(started.id, assistant.id, {
    name: "add_sample_to_cart",
    resultJson:
      '{"status":"added","message":"Added.","addedSample":{"productPath":"/products/synthetic","title":"Synthetic blind"}}',
    completedAt: later,
  });
  const failedAssistant = await message(rejected.id, {
    partsJson: '[{"type":"text","text":"Your blind was added."}]',
  });
  for (const overrides of [
    { status: "running" },
    { status: "failed" },
    { error: "Not confirmed" },
    { resultJson: '{"status":"uncertain"}' },
    { resultJson: '{"status":"already_in_cart"}', name: "add_sample_to_cart" },
    { resultJson: "invalid JSON" },
    { resultJson: null },
    { name: "set_cart_quantity" },
  ])
    await cartTool(rejected.id, failedAssistant.id, overrides);
  const before = await database.conversation.findMany({
    orderBy: { id: "asc" },
  });
  queries.length = 0;
  assert.deepEqual(await repository.getSessionMetrics(shop, range), {
    sessions: 5,
    voiceSessions: 2,
    textSessions: 3,
    visualizerSessions: 1,
    sampleCartSessions: 1,
    productCartSessions: 1,
  });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].query, /partsJson/);
  assert.deepEqual(
    await database.conversation.findMany({ orderBy: { id: "asc" } }),
    before,
  );
});

test("10,000 sessions use one indexed aggregate over 200,000 unrelated tools", async (context) => {
  const sessions = 10_000;
  const timestamp = at.getTime();
  await database.$executeRawUnsafe(
    `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO Conversation (id,shop,origin,credentialHash,credentialExpiresAt,createdAt,updatedAt)
    SELECT printf('session-%05d',i),?,?,'synthetic-'||i,0,?,? FROM seq`,
    sessions,
    shop,
    `https://${shop}`,
    timestamp,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `INSERT INTO ConversationMessage (id,conversationId,requestId,sequence,role,status,createdAt)
    SELECT id,id,'synthetic-assistant',1,'assistant','complete',? FROM Conversation`,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO ToolInvocation (id,conversationId,assistantId,providerCallId,name,argumentsJson,resultJson,status,createdAt)
    SELECT 'tool-'||i,printf('session-%05d',1+((i-1)/20)),printf('session-%05d',1+((i-1)/20)),
    'call-'||i,'get_product','{}','{"status":"available"}','complete',? FROM seq`,
    200_000,
    timestamp,
  );
  // A customer's Gallery photo can be reused in subsequent conversations.
  const room = await photo("session-00001");
  const jobs = Array.from({ length: 2000 }, (_, index) =>
    jobData(room, {
      conversationId: `session-${String(1 + index * 5).padStart(5, "0")}`,
    }),
  );
  for (let offset = 0; offset < jobs.length; offset += 500)
    await database.visualizationJob.createMany({
      data: jobs.slice(offset, offset + 500),
    });
  await database.$executeRawUnsafe(
    `INSERT INTO ToolInvocation (id,conversationId,assistantId,providerCallId,name,argumentsJson,resultJson,status,createdAt)
    SELECT 'added-'||id,id,id,'synthetic-added','add_to_cart','{}',
    '{"status":"added","message":"Added."}','complete',? FROM Conversation
    WHERE (CAST(substr(id,9) AS INTEGER)-1)%10=0`,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `INSERT INTO VoiceSession (id,conversationId,clientId,providerId,leaseExpiresAt,status,createdAt)
    SELECT 'voice-'||id,id,'synthetic-client','synthetic-provider',?,'closed',? FROM Conversation
    WHERE (CAST(substr(id,9) AS INTEGER)-1)%3=0`,
    timestamp,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `INSERT INTO ConversationMessage (id,conversationId,requestId,sequence,role,status,createdAt)
    SELECT 'started-'||id,conversationId,'voice:'||id||':started',2,'context','complete',? FROM VoiceSession`,
    timestamp,
  );
  queries.length = 0;
  const start = performance.now();
  const metrics = await repository.getSessionMetrics(shop, range);
  const duration = performance.now() - start;
  assert.deepEqual(metrics, {
    ...empty,
    sessions: 10_000,
    voiceSessions: 3334,
    textSessions: 6666,
    visualizerSessions: 2000,
    productCartSessions: 1000,
  });
  assert.equal(queries.length, 1);
  const reportQuery = queries[0];
  const plan = await database.$queryRawUnsafe(
    `EXPLAIN QUERY PLAN ${reportQuery.query}`,
    ...JSON.parse(reportQuery.params),
  );
  const details = plan.map((row) => row.detail).join("\n");
  assert.match(details, /Conversation_shop_createdAt_idx/);
  assert.match(details, /VisualizationJob_conversationId_idx/);
  assert.equal(
    (details.match(/ToolInvocation_conversationId_name_status_idx/g) ?? [])
      .length,
    2,
  );
  assert.match(
    details,
    /ConversationMessage_conversationId_requestId_role_key/,
  );
  assert.match(details, /VoiceTranscript_voiceId_providerEventId_key/);
  assert.doesNotMatch(details, /SCAN [jtmxv]\b/);
  context.diagnostic(
    `10,000 sessions and 201,000 tools: ${duration.toFixed(1)} ms, one database aggregate and indexed activity lookups. Synthetic local timing, not a production guarantee.`,
  );
});
