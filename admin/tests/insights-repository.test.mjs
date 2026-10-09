import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * from './admin/insights/repository.server'; export * from './admin/insights/costs.server'; export * from './admin/pricing/estimate.server'; export * from './admin/pricing/image-estimate.server'; export * from './admin/pricing/rates.server';`,
    resolveDir: process.cwd(),
  },
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
const queries = [];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-insights-"));
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });
  database.$on("query", (event) => queries.push(event.query));
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
  // Remove the large synthetic usage fixture before parent cascades; cleanup
  // should not benchmark foreign-key deletion instead of reporting reads.
  await database.modelUsage.deleteMany();
  await database.imageGenerationAttempt.deleteMany();
  await database.visualizationJob.deleteMany();
  await database.windowPhoto.deleteMany();
  await database.galleryOwner.deleteMany();
  await database.conversation.deleteMany();
});

test("image attempts are shop-scoped, retain billed failures and unknown coverage, and use pinned rates", async () => {
  const own = await conversation();
  const foreign = await conversation({ shop: otherShop });
  const at = new Date("2026-10-06T12:00:00.000Z");
  const job = await imageJob(own.id, shop, at);
  const otherJob = await imageJob(foreign.id, otherShop, at);
  const sample = {
    model: "gpt-image-2.5-sunburst",
    createdAt: at,
    textInputTokens: 10,
    textCachedInputTokens: null,
    imageInputTokens: 20,
    imageCachedInputTokens: null,
    imageOutputTokens: 100,
    usageValid: true,
  };
  const pinned = repository.imageRateFor(sample.model, at);
  const estimate = repository.estimateImageUsage(sample, pinned);
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: own.id,
      ordinal: 1,
      ...sample,
      status: "storage_failed",
      rateSnapshotJson: JSON.stringify(pinned),
      costUsd: estimate.usd,
      costEvidence: estimate.evidence,
      costReason: estimate.reason,
      errorCode: "storage_unavailable",
    },
  });
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: own.id,
      ordinal: 2,
      ...sample,
      model: "gpt-image-2.5-flare",
      imageOutputTokens: null,
      status: "unknown_outcome",
      rateSnapshotJson: JSON.stringify(
        repository.imageRateFor("gpt-image-2.5-flare", at),
      ),
      costUsd: null,
      costEvidence: "unknown",
      costReason: "missing_usage",
    },
  });
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: otherJob.id,
      conversationId: foreign.id,
      ordinal: 1,
      ...sample,
      status: "completed",
      rateSnapshotJson: JSON.stringify(pinned),
      costUsd: 999,
      costEvidence: "estimated",
    },
  });
  const inspection = await repository.getConversationInspection(shop, own.id);
  assert.equal(inspection.imageAttempts.length, 2);
  assert.equal(inspection.cost.pricedImageAttempts, 1);
  assert.equal(inspection.cost.unpricedImageAttempts, 1);
  assert.equal(inspection.cost.estimatedImageAttempts, 1);
  assert.equal(inspection.cost.imageUsd, estimate.usd);
  assert.equal(inspection.imageAttempts.find((attempt) => attempt.ordinal === 1).errorCode, "storage_unavailable");
  assert.doesNotMatch(
    JSON.stringify(inspection),
    /PRIVATE|rateSnapshotJson|credentialHash|providerRequestId/,
  );
  assert.equal(
    await repository.getConversationInspection(shop, foreign.id),
    null,
  );
  const overview = await repository.getShopCostSummary(shop);
  assert.equal(overview.imageUsd, estimate.usd);
  assert.equal(overview.pricedImageAttempts, 1);
  assert.equal(overview.unpricedImageAttempts, 1);
  assert.equal(overview.estimatedImageAttempts, 1);
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

async function imageJob(conversationId, jobShop, at = pricedAt) {
  const owner = await database.galleryOwner.create({
    data: {
      id: randomUUID(),
      shop: jobShop,
      origin: `https://${jobShop}`,
      tokenHash: `PRIVATE-${randomUUID()}`,
    },
  });
  const window = await database.windowPhoto.create({
    data: {
      id: randomUUID(),
      ownerId: owner.id,
      title: "Nursery",
      assetKey: "PRIVATE-IMAGE-KEY",
      sha256: randomUUID(),
      width: 1024,
      height: 1024,
      bytes: 100,
      consentVersion: "v1",
      consentAt: at,
      conversationId,
      requestId: randomUUID(),
      requestHash: randomUUID(),
    },
  });
  return database.visualizationJob.create({
    data: {
      id: randomUUID(),
      ownerId: owner.id,
      windowId: window.id,
      conversationId,
      requestId: randomUUID(),
      requestHash: randomUUID(),
      windowRevision: 1,
      windowTitle: window.title,
      sourceAssetKey: "PRIVATE-SOURCE",
      productPath: "/products/blackout",
      productTitle: "Blackout",
      cleanup: true,
      promptVersion: "test",
      width: 1024,
      height: 1024,
      deadlineAt: at,
      deletedAt: at,
    },
  });
}

test("conversation totals include text, voice and image costs without mixing sessions", async () => {
  const first = await conversation();
  const second = await conversation();
  const firstReply = await message(first.id);
  const secondReply = await message(second.id);
  await usage(first.id, firstReply.id);
  await usage(second.id, secondReply.id, {
    inputTokens: 800,
    outputTokens: 300,
    totalTokens: 1100,
  });
  await usage(second.id, secondReply.id, { model: "unpriced-model" });
  await voice(first.id, { model: "gpt-live-1", usageSeconds: 60 });
  await voice(second.id, { model: "gpt-live-1", usageSeconds: 120 });
  await voice(second.id);
  const imageAt = new Date("2026-10-06T12:00:00.000Z");
  const job = await imageJob(first.id, shop, imageAt);
  const sample = {
    model: "gpt-image-2.5-sunburst",
    createdAt: imageAt,
    textInputTokens: 10,
    textCachedInputTokens: null,
    imageInputTokens: 20,
    imageCachedInputTokens: null,
    imageOutputTokens: 100,
    usageValid: true,
  };
  const pinned = repository.imageRateFor(sample.model, imageAt);
  const estimate = repository.estimateImageUsage(sample, pinned);
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: first.id,
      ordinal: 1,
      ...sample,
      status: "storage_failed",
      rateSnapshotJson: JSON.stringify(pinned),
      costUsd: estimate.usd,
      costEvidence: estimate.evidence,
    },
  });
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: first.id,
      ordinal: 2,
      ...sample,
      imageOutputTokens: null,
      status: "unknown_outcome",
      rateSnapshotJson: JSON.stringify(pinned),
      costUsd: null,
      costEvidence: "unknown",
    },
  });
  const grouped = await repository.getConversationCostSummaries(shop, [
    first.id,
    second.id,
  ]);
  assert.equal(grouped.size, 2);
  const overview = await repository.getConversationOverview(shop);
  for (const id of [first.id, second.id]) {
    const detail = await repository.getConversationInspection(shop, id);
    assertCostsEqual(grouped.get(id), detail.cost);
    assertCostsEqual(
      overview.conversations.find((row) => row.id === id).cost,
      detail.cost,
    );
  }
  assert.equal(grouped.get(first.id).pricedImageAttempts, 1);
  assert.equal(grouped.get(first.id).estimatedImageAttempts, 1);
  assert.equal(grouped.get(first.id).unpricedImageAttempts, 1);
  assert.equal(grouped.get(first.id).imageUsd, estimate.usd);
  assert.equal(grouped.get(second.id).imageUsd, null);
  assert.equal(grouped.get(second.id).unpricedModelCalls, 1);
  assert.equal(grouped.get(second.id).unpricedVoiceSessions, 1);
  assert.notEqual(
    grouped.get(first.id).totalUsd,
    grouped.get(second.id).totalUsd,
  );
});

test("page cost queries are shop-scoped, bounded to requested IDs and skipped for an empty page", async () => {
  const selected = await conversation();
  const offPage = await conversation();
  const foreign = await conversation({ shop: otherShop });
  for (const row of [selected, offPage, foreign]) {
    const reply = await message(row.id);
    await usage(row.id, reply.id);
    await voice(row.id, { model: "gpt-live-1", usageSeconds: 10 });
  }
  queries.length = 0;
  const result = await repository.getConversationCostSummaries(shop, [
    selected.id,
    selected.id,
    foreign.id,
    randomUUID(),
    "' OR 1=1 --",
  ]);
  assert.deepEqual([...result.keys()], [selected.id]);
  assert.equal(result.get(selected.id).pricedModelCalls, 1);
  assert.equal(result.get(selected.id).pricedVoiceSessions, 1);
  assert.equal(queries.length, 3);
  assert.ok(
    queries.every(
      (query) =>
        /c\."shop" = \?/.test(query) &&
        /c\."id" IN \(\?/.test(query) &&
        /GROUP BY conversationId,/.test(query),
    ),
  );
  queries.length = 0;
  assert.deepEqual(
    await repository.getConversationCostSummaries(shop, []),
    new Map(),
  );
  assert.equal(queries.length, 0);
});

test("conversation totals keep unavailable, partial, measured zero and unused costs distinct", async () => {
  const unused = await conversation();
  const unknown = await conversation();
  const zero = await conversation();
  const partial = await conversation();
  const unknownReply = await message(unknown.id);
  await usage(unknown.id, unknownReply.id, { model: "unconfigured-model" });
  await voice(unknown.id);
  const zeroReply = await message(zero.id);
  await usage(zero.id, zeroReply.id, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  await voice(zero.id, { model: "gpt-live-1", usageSeconds: 0 });
  const partialReply = await message(partial.id);
  await usage(partial.id, partialReply.id);
  await usage(partial.id, partialReply.id, { cacheWriteInputTokens: null });
  const result = await repository.getConversationCostSummaries(shop, [
    unused.id,
    unknown.id,
    zero.id,
    partial.id,
  ]);
  assert.equal(result.has(unused.id), false);
  assert.equal(result.get(unknown.id).totalUsd, null);
  assert.equal(result.get(unknown.id).unpricedModelCalls, 1);
  assert.equal(result.get(unknown.id).unpricedVoiceSessions, 1);
  assert.equal(result.get(zero.id).totalUsd, 0);
  assert.equal(result.get(zero.id).pricedModelCalls, 1);
  assert.equal(result.get(zero.id).pricedVoiceSessions, 1);
  assert.equal(result.get(partial.id).pricedModelCalls, 1);
  assert.equal(result.get(partial.id).unpricedModelCalls, 1);
  assert.ok(Math.abs(result.get(partial.id).totalUsd - 0.0000736) < 1e-12);
  const overview = await repository.getConversationOverview(shop);
  for (const row of overview.conversations) {
    const detail = await repository.getConversationInspection(shop, row.id);
    assertCostsEqual(row.cost, detail.cost);
  }
  assert.equal(
    overview.conversations.find((row) => row.id === unused.id).cost.totalUsd,
    null,
  );
});

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
    imageUsd: null,
    totalUsd: 0,
    pricedModelCalls: 1,
    unpricedModelCalls: 1,
    pricedVoiceSessions: 1,
    unpricedVoiceSessions: 1,
    pricedImageAttempts: 0,
    unpricedImageAttempts: 0,
    estimatedImageAttempts: 0,
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

test("Sol Ultrafast costs agree between inspection and grouped overview without repricing other tiers", async () => {
  const own = await conversation();
  const reply = await message(own.id);
  const rows = [];
  const at = new Date("2026-10-09T00:00:00.000Z");
  for (const overrides of [
    { serviceTier: "ultrafast" },
    { serviceTier: "ultrafast", inputTokens: 272000 },
    { serviceTier: "ultrafast", inputTokens: 272001, cacheWriteInputTokens: 10 },
    { serviceTier: "priority" },
    { serviceTier: "fast" },
    { serviceTier: "default" },
    { serviceTier: "ultrafast", createdAt: new Date("2026-10-08T23:59:59.999Z") },
    { serviceTier: null },
    { serviceTier: "unknown" },
  ])
    rows.push(await usage(own.id, reply.id, {
      model: "gpt-6.1-sol",
      createdAt: at,
      ...overrides,
    }));
  const foreign = await conversation({ shop: otherShop });
  const foreignReply = await message(foreign.id);
  await usage(foreign.id, foreignReply.id, {
    model: "gpt-6.1-sol",
    serviceTier: "ultrafast",
    createdAt: at,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const expected = repository.emptyCostSummary();
  for (const row of rows)
    repository.addCost(expected, "model", repository.estimateModelUsage(row));
  assert.equal(expected.pricedModelCalls, 6);
  assert.equal(expected.unpricedModelCalls, 3);
  assertCostsEqual(await repository.getShopCostSummary(shop), expected);
  const inspection = await repository.getConversationInspection(shop, own.id);
  assertCostsEqual(inspection.cost, expected);
  assert.equal(
    inspection.modelUsage.find((call) => call.id === rows[0].id).cost.rateId,
    "gpt-6.1-sol-ultrafast-2026-10-09",
  );
  assert.equal(
    inspection.modelUsage.find((call) => call.id === rows[3].id).cost.rateId,
    "gpt-6.1-sol-fast-2026-10-07",
  );
});

test("shop estimates aggregate all cost metadata without repeating individual calls", async () => {
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
  assertCostsEqual(detail.cost, overview.summary.cost);
});

function assertCostsEqual(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (key.endsWith("Usd") && value !== null) {
      assert.ok(
        Math.abs(actual[key] - value) <= Math.max(1, Math.abs(value)) * 1e-12,
        `${key} differs: ${actual[key]} versus ${value}`,
      );
    } else assert.equal(actual[key], value, key);
  }
}

test("database cost groups match per-call pricing across UTC boundaries, tiers and context bands", async () => {
  const own = await conversation();
  const reply = await message(own.id);
  const tokenPrice = repository.MODEL_PRICES.find(
    (price) => price.kind === "tokens" && price.serviceTier === "priority",
  );
  const voicePrice = repository.MODEL_PRICES.find(
    (price) => price.kind === "voice",
  );
  const prices = [
    { ...tokenPrice, id: "first", effectiveTo: "2026-09-16T00:00:00.000Z" },
    {
      ...tokenPrice,
      id: "second",
      effectiveFrom: "2026-09-16T00:00:00.000Z",
      effectiveTo: "2026-09-17T00:00:00.000Z",
      prices: {
        inputPerMillion: 1,
        cachedInputPerMillion: 0.1,
        cacheWriteInputPerMillion: 1.5,
        outputPerMillion: 5,
      },
    },
    {
      ...tokenPrice,
      id: "after-gap",
      effectiveFrom: "2026-09-18T00:00:00.000Z",
    },
    {
      ...voicePrice,
      id: "voice-first",
      effectiveTo: "2026-09-16T00:00:00.000Z",
    },
    {
      ...voicePrice,
      id: "voice-second",
      effectiveFrom: "2026-09-16T00:00:00.000Z",
      perMinute: 0.1,
    },
  ];
  const modelRows = [];
  for (const overrides of [
    { createdAt: new Date("2026-09-14T23:59:59.999Z") },
    { createdAt: new Date("2026-09-15T00:00:00.000Z"), inputTokens: 272000 },
    {
      createdAt: new Date("2026-09-15T23:59:59.999Z"),
      inputTokens: 272001,
      cacheWriteInputTokens: 10,
    },
    { createdAt: new Date("2026-09-16T00:00:00.000Z"), serviceTier: "fast" },
    { createdAt: new Date("2026-09-17T00:00:00.000Z") },
    {
      createdAt: new Date("2026-09-18T00:00:00.000Z"),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    { serviceTier: "unknown" },
    { model: "unknown" },
    { cacheWriteInputTokens: null },
    { inputTokens: -1 },
    { cachedInputTokens: 100, cacheWriteInputTokens: 1 },
  ])
    modelRows.push(await usage(own.id, reply.id, overrides));
  const voiceRows = [];
  for (const overrides of [
    { createdAt: new Date("2026-09-14T23:59:59.999Z"), usageSeconds: 10 },
    { createdAt: new Date("2026-09-15T23:59:59.999Z"), usageSeconds: 12.5 },
    { createdAt: new Date("2026-09-16T00:00:00.000Z"), usageSeconds: 60 },
    { usageSeconds: 0 },
    { usageSeconds: -1 },
    { usageSeconds: null },
    { usageSeconds: 50, model: "unknown" },
  ])
    voiceRows.push(await voice(own.id, { model: "gpt-live-1", ...overrides }));
  const expected = repository.emptyCostSummary();
  for (const row of modelRows)
    repository.addCost(
      expected,
      "model",
      repository.estimateModelUsage(row, prices),
    );
  for (const row of voiceRows)
    repository.addCost(
      expected,
      "voice",
      repository.estimateVoiceUsage(row, prices),
    );
  assertCostsEqual(await repository.getShopCostSummary(shop, prices), expected);
  assertCostsEqual(
    (await repository.getConversationCostSummaries(shop, [own.id], prices)).get(
      own.id,
    ),
    expected,
  );
  const unpriced = await repository.getShopCostSummary(shop, []);
  assert.equal(unpriced.totalUsd, null);
  assert.equal(unpriced.unpricedModelCalls, modelRows.length);
  assert.equal(unpriced.unpricedVoiceSessions, voiceRows.length);
});

test("large retained history uses a fixed number of read statements while another connection writes", async (t) => {
  const count = 100_000;
  const conversations = count / 40;
  const timestamp = pricedAt.getTime();
  await database.$executeRawUnsafe(
    `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO Conversation (id,shop,origin,credentialHash,credentialExpiresAt,createdAt,updatedAt)
    SELECT printf('00000000-0000-4000-a000-%012x',i),?,?,'synthetic-'||i,0,?,? FROM seq`,
    conversations,
    shop,
    `https://${shop}`,
    timestamp,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `INSERT INTO ConversationMessage (id,conversationId,requestId,sequence,role,status,createdAt)
    SELECT id,id,id,1,'assistant','complete',? FROM Conversation`,
    timestamp,
  );
  await database.$executeRawUnsafe(
    `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO ModelUsage (id,conversationId,assistantId,model,serviceTier,status,inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,totalTokens,createdAt,completedAt)
    SELECT printf('10000000-0000-4000-a000-%012x',i),printf('00000000-0000-4000-a000-%012x',1+((i-1)/40)),printf('00000000-0000-4000-a000-%012x',1+((i-1)/40)),
    'gpt-5.6-luna','priority','completed',1000,200,0,200,1200,?,? FROM seq`,
    count,
    timestamp,
    timestamp,
  );
  const writer = new PrismaClient({
    datasourceUrl: `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`,
  });
  await writer.$connect();
  try {
    queries.length = 0;
    const started = performance.now();
    const overview = repository.getConversationOverview(shop);
    await delay(5);
    const writeStarted = performance.now();
    const write = writer.$transaction(async (transaction) => {
      await transaction.conversation.update({
        where: { id: "00000000-0000-4000-a000-000000000001" },
        data: { revision: { increment: 1 } },
      });
      return performance.now() - writeStarted;
    });
    const [result, writeMs] = await Promise.all([overview, write]);
    const elapsedMs = performance.now() - started;
    assert.equal(result.summary.cost.pricedModelCalls, count);
    assert.equal(result.summary.usage.modelCalls, count);
    assert.equal(result.conversations.length, 25);
    assert.equal(
      queries.some((query) => /^BEGIN|^COMMIT|^ROLLBACK/.test(query)),
      false,
      "overview must not acquire an interactive transaction",
    );
    assert.ok(
      queries.length <= 15,
      `overview emitted ${queries.length} queries`,
    );
    assert.equal(
      queries.filter((query) => /GROUP BY\s+band/.test(query)).length,
      2,
    );
    const pageQueries = queries.filter((query) =>
      /GROUP BY conversationId,/.test(query),
    );
    assert.equal(pageQueries.length, 3);
    assert.ok(
      pageQueries.every((query) => /c\."id" IN \((?:\?,){24}\?\)/.test(query)),
    );
    assert.ok(
      result.conversations.every((row) => row.cost.pricedModelCalls === 40),
    );
    t.diagnostic(
      `100000 usage rows: overview plus concurrent write ${elapsedMs.toFixed(1)} ms; write ${writeMs.toFixed(1)} ms; ${queries.length} reporting statements. Synthetic local timing, not a production latency guarantee.`,
    );
  } finally {
    await writer.$disconnect();
  }
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
