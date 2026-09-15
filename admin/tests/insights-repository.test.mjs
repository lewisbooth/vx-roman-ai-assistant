import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/insights/repository.server.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
const shop = "hd-dev-single.myshopify.com";
const otherShop = "hd-dev-multi.myshopify.com";
const pricedAt = new Date("2026-09-16T12:00:00.000Z");
const previousGlobal = global.prismaGlobal;
let directory;
let database;
let repository;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-insights-"));
  database = new PrismaClient({
    datasourceUrl: `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`,
  });
  global.prismaGlobal = database;
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
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  repository = module.exports;
});

beforeEach(async () => {
  await database.conversation.deleteMany();
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});

async function conversation(overrides = {}) {
  return database.conversation.create({
    data: {
      id: randomUUID(),
      shop,
      origin: `https://${shop}`,
      credentialHash: `PRIVATE-CREDENTIAL-${randomUUID()}`,
      credentialExpiresAt: new Date(0),
      ...overrides,
    },
  });
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
      ...overrides,
    },
  });
}

async function voice(conversationId, overrides = {}) {
  return database.voiceSession.create({
    data: {
      id: randomUUID(),
      conversationId,
      clientId: "PRIVATE-CLIENT",
      providerId: "PRIVATE-PROVIDER",
      status: "closed",
      leaseExpiresAt: new Date(0),
      closedAt: new Date(),
      createdAt: pricedAt,
      ...overrides,
    },
  });
}

async function usage(conversationId, assistantId, overrides = {}) {
  return database.modelUsage.create({
    data: {
      id: randomUUID(),
      conversationId,
      assistantId,
      model: "gpt-5.6-luna",
      status: "completed",
      serviceTier: "priority",
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
      completedAt: new Date(),
      createdAt: pricedAt,
      ...overrides,
    },
  });
}

test("overview scopes every count, page and usage aggregate to the merchant", async () => {
  const own = await conversation({ turnCount: 1 });
  const second = await conversation({ status: "ended" });
  const foreign = await conversation({
    shop: otherShop,
    origin: `https://${otherShop}`,
  });
  const ownReply = await message(own.id);
  await message(second.id, { status: "failed" });
  const foreignReply = await message(foreign.id, { status: "failed" });
  await usage(own.id, ownReply.id);
  await usage(foreign.id, foreignReply.id, {
    inputTokens: 10000,
    outputTokens: 1000,
    totalTokens: 11000,
  });
  await voice(own.id, { model: "gpt-live-1", usageSeconds: 12.5 });
  await voice(second.id);
  await voice(foreign.id, { model: "gpt-live-1", usageSeconds: 9999 });
  const result = await repository.getConversationOverview(shop);
  assert.equal(result.summary.conversations, 2);
  assert.equal(result.summary.endedConversations, 1);
  assert.equal(result.summary.failedReplies, 1);
  assert.equal(result.conversations.length, 2);
  assert.ok(result.conversations.every((row) => row.id !== foreign.id));
  assert.deepEqual(result.summary.usage, {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
    modelCalls: 1,
    reportedModelCalls: 1,
    voiceSeconds: 12.5,
    voiceSessions: 2,
    reportedVoiceSessions: 1,
  });
  assert.ok(Math.abs(result.summary.cost.modelUsd - 0.0000736) < 1e-12);
  assert.ok(
    Math.abs(result.summary.cost.voiceUsd - 0.010416666666666668) < 1e-12,
  );
  assert.ok(
    Math.abs(result.summary.cost.totalUsd - 0.010490266666666668) < 1e-12,
  );
  assert.deepEqual(
    [
      result.summary.cost.pricedModelCalls,
      result.summary.cost.unpricedModelCalls,
      result.summary.cost.pricedVoiceSessions,
      result.summary.cost.unpricedVoiceSessions,
    ],
    [1, 0, 1, 1],
  );
  assert.ok(result.prices.some((price) => price.id === "luna-fast-2026-09-15"));
  assert.ok(result.prices.some((price) => price.id === "live-2026-09-15"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|credential|providerId|clientId/,
  );
});

test("pagination is bounded and stable for conversations with identical creation times", async () => {
  const createdAt = new Date("2026-09-15T12:00:00Z");
  for (let index = 0; index < 27; index++) await conversation({ createdAt });
  const expected = await database.conversation.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const first = await repository.getConversationOverview(shop);
  const second = await repository.getConversationOverview(shop, 2);
  assert.equal(first.conversations.length, 25);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.conversations.length, 2);
  assert.equal(second.hasNextPage, false);
  assert.deepEqual(
    [...first.conversations, ...second.conversations].map((row) => row.id),
    expected.map((row) => row.id),
  );
  for (const page of [0, -1, 1.5, Infinity, NaN, 10001])
    await assert.rejects(
      repository.getConversationOverview(shop, page),
      RangeError,
    );
});

test("unknown usage remains null while measured zero remains zero", async () => {
  const own = await conversation();
  const reply = await message(own.id);
  await voice(own.id);
  let result = await repository.getConversationInspection(shop, own.id);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.voiceSeconds, null);
  assert.equal(result.usage.reportedModelCalls, 0);
  assert.equal(result.cost.totalUsd, null);
  assert.equal(result.cost.unpricedVoiceSessions, 1);
  await usage(own.id, reply.id, {
    status: "unavailable",
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  });
  result = await repository.getConversationInspection(shop, own.id);
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.reportedModelCalls, 0);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.cacheWriteInputTokens, null);
  assert.equal(result.cost.totalUsd, null);
  assert.equal(result.cost.unpricedModelCalls, 1);
  await usage(own.id, reply.id, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  });
  await voice(own.id, { model: "gpt-live-1", usageSeconds: 0 });
  result = await repository.getConversationInspection(shop, own.id);
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(result.usage.reportedModelCalls, 1);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.voiceSeconds, 0);
  assert.equal(result.usage.cacheWriteInputTokens, 0);
  assert.deepEqual(result.cost, {
    modelUsd: 0,
    voiceUsd: 0,
    totalUsd: 0,
    pricedModelCalls: 1,
    unpricedModelCalls: 1,
    pricedVoiceSessions: 1,
    unpricedVoiceSessions: 1,
  });
});

test("per-call prices use recorded start dates and leave historical or unknown rates unpriced", async () => {
  const own = await conversation();
  const reply = await message(own.id);
  const previousDate = new Date("2026-09-14T23:59:59.999Z");
  const boundaryDate = new Date("2026-09-15T00:00:00.000Z");
  const oldCall = await usage(own.id, reply.id, {
    createdAt: previousDate,
    completedAt: pricedAt,
  });
  const pricedCall = await usage(own.id, reply.id, {
    createdAt: boundaryDate,
    cacheWriteInputTokens: 10,
  });
  const unknownModel = await usage(own.id, reply.id, {
    model: "unconfigured-model",
  });
  const unknownTier = await usage(own.id, reply.id, { serviceTier: null });
  const historicalCounts = await usage(own.id, reply.id, {
    cacheWriteInputTokens: null,
  });
  const oldVoice = await voice(own.id, {
    model: "gpt-live-1",
    usageSeconds: 60,
    createdAt: previousDate,
    closedAt: pricedAt,
  });
  const pricedVoice = await voice(own.id, {
    model: "gpt-live-1",
    usageSeconds: 60,
    createdAt: boundaryDate,
  });
  const inspection = await repository.getConversationInspection(shop, own.id);
  const calls = new Map(inspection.modelUsage.map((call) => [call.id, call]));
  const voices = new Map(
    inspection.voiceSessions.map((session) => [session.id, session]),
  );
  assert.deepEqual(calls.get(oldCall.id).cost, {
    usd: null,
    rateId: null,
    reason: "missing_rate",
  });
  assert.equal(calls.get(pricedCall.id).cost.rateId, "luna-fast-2026-09-15");
  assert.ok(Math.abs(calls.get(pricedCall.id).cost.usd - 0.0000746) < 1e-12);
  assert.equal(calls.get(pricedCall.id).cacheWriteInputTokens, 10);
  assert.equal(calls.get(unknownModel.id).cost.reason, "missing_rate");
  assert.equal(calls.get(unknownTier.id).cost.reason, "missing_rate");
  assert.equal(calls.get(historicalCounts.id).cost.reason, "missing_usage");
  assert.equal(calls.get(historicalCounts.id).cacheWriteInputTokens, null);
  assert.equal(voices.get(oldVoice.id).cost.reason, "missing_rate");
  assert.deepEqual(voices.get(pricedVoice.id).cost, {
    usd: 0.05,
    rateId: "live-2026-09-15",
    reason: null,
  });
  assert.deepEqual(
    [
      inspection.cost.pricedModelCalls,
      inspection.cost.unpricedModelCalls,
      inspection.cost.pricedVoiceSessions,
      inspection.cost.unpricedVoiceSessions,
    ],
    [1, 4, 1, 1],
  );
  assert.ok(Math.abs(inspection.cost.totalUsd - 0.0500746) < 1e-12);
  const overview = await repository.getConversationOverview(shop);
  assert.deepEqual(overview.summary.cost, inspection.cost);
  assert.equal(overview.summary.usage.cacheWriteInputTokens, 10);
});

test("shop estimates scan all cost metadata in bounded batches without repeating rows", async () => {
  const own = await conversation();
  const reply = await message(own.id);
  const foreign = await conversation({ shop: otherShop });
  const foreignReply = await message(foreign.id);
  const count = 503;
  await database.modelUsage.createMany({
    data: Array.from({ length: count }, () => ({
      id: randomUUID(),
      conversationId: own.id,
      assistantId: reply.id,
      model: "gpt-5.6-luna",
      status: "completed",
      serviceTier: "priority",
      createdAt: pricedAt,
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    })),
  });
  await database.voiceSession.createMany({
    data: Array.from({ length: count }, () => ({
      id: randomUUID(),
      conversationId: own.id,
      clientId: randomUUID(),
      status: "closed",
      createdAt: pricedAt,
      closedAt: pricedAt,
      leaseExpiresAt: pricedAt,
      model: "gpt-live-1",
      usageSeconds: 1,
    })),
  });
  await usage(foreign.id, foreignReply.id, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  await voice(foreign.id, { model: "gpt-live-1", usageSeconds: 9999 });
  const overview = await repository.getConversationOverview(shop);
  assert.equal(overview.summary.cost.pricedModelCalls, count);
  assert.equal(overview.summary.cost.pricedVoiceSessions, count);
  assert.equal(overview.summary.cost.unpricedModelCalls, 0);
  assert.equal(overview.summary.cost.unpricedVoiceSessions, 0);
  assert.ok(
    Math.abs(overview.summary.cost.modelUsd - count * 0.0000736) < 1e-12,
  );
  assert.ok(
    Math.abs(overview.summary.cost.voiceUsd - count * (0.05 / 60)) < 1e-12,
  );
  assert.equal(overview.summary.usage.modelCalls, count);
  assert.equal(overview.summary.usage.voiceSessions, count);
  const detail = await repository.getConversationInspection(shop, own.id);
  assert.deepEqual(detail.cost, overview.summary.cost);
});

test("detail refuses a foreign conversation and exposes only the ordered inspection projection", async () => {
  const own = await conversation({ pendingRequestId: "PRIVATE-PENDING" });
  const foreign = await conversation({
    shop: otherShop,
    origin: `https://${otherShop}`,
  });
  await message(own.id, {
    sequence: 1,
    role: "user",
    partsJson: JSON.stringify([{ type: "text", text: "My kitchen" }]),
  });
  const reply = await message(own.id, {
    sequence: 4,
    partsJson: JSON.stringify([
      { type: "text", text: "Let's look at some blinds." },
    ]),
  });
  await message(own.id, { sequence: 5, status: "pending" });
  const live = await voice(own.id, { status: "active", closedAt: null });
  await database.voiceTranscript.create({
    data: {
      id: randomUUID(),
      voiceId: live.id,
      conversationId: own.id,
      providerEventId: "PRIVATE-EVENT",
      sequence: 2,
      role: "user",
      text: "I need privacy",
      startMs: 0,
      endMs: 200,
    },
  });
  await message(own.id, {
    sequence: 3,
    role: "context",
    partsJson: JSON.stringify([
      {
        type: "page_view",
        version: 1,
        title: "Roller blinds",
        path: "/collections/all",
        occurredAt: new Date().toISOString(),
      },
    ]),
  });
  await database.toolInvocation.create({
    data: {
      id: randomUUID(),
      conversationId: own.id,
      assistantId: reply.id,
      providerCallId: "PRIVATE-CALL",
      name: "search_products",
      argumentsJson: '{"query":"PRIVATE-QUERY"}',
      status: "running",
      claimClientId: "PRIVATE-CLIENT",
      claimTokenHash: "PRIVATE-CLAIM",
    },
  });
  await usage(own.id, reply.id);
  const before = {
    conversation: await database.conversation.findUnique({
      where: { id: own.id },
    }),
    voices: await database.voiceSession.findMany({
      where: { conversationId: own.id },
    }),
    messages: await database.conversationMessage.findMany({
      where: { conversationId: own.id },
    }),
  };
  assert.equal(
    await repository.getConversationInspection(shop, foreign.id),
    null,
  );
  assert.equal(
    await repository.getConversationInspection(shop, randomUUID()),
    null,
  );
  assert.equal(
    await repository.getConversationInspection(shop, "not-an-id"),
    null,
  );
  const result = await repository.getConversationInspection(shop, own.id);
  assert.deepEqual(
    result.messages.map((row) => row.parts[0]?.type),
    ["text", "voice", "page_view", "text"],
  );
  assert.equal(result.messages[1].parts[0].text, "I need privacy");
  assert.equal(result.tools[0].status, "running");
  assert.equal(result.modelUsage[0].serviceTier, "priority");
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|credentialHash|providerId|providerEventId|claimTokenHash|argumentsJson|pendingRequestId/,
  );
  assert.deepEqual(
    {
      conversation: await database.conversation.findUnique({
        where: { id: own.id },
      }),
      voices: await database.voiceSession.findMany({
        where: { conversationId: own.id },
      }),
      messages: await database.conversationMessage.findMany({
        where: { conversationId: own.id },
      }),
    },
    before,
    "Merchant inspection must not expire voice, fail a pending reply, or mutate chat",
  );
});
