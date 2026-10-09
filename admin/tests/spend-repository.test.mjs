import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * from './admin/insights/spend.server'; export * from './admin/insights/costs.server'; export * from './admin/pricing/estimate.server'; export * from './admin/pricing/image-estimate.server'; export * from './admin/pricing/rates.server';`,
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
const previousGlobal = global.prismaGlobal;
let directory;
let database;
let repository;
const queries = [];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-spend-"));
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
  await database.modelUsage.deleteMany();
  await database.imageGenerationAttempt.deleteMany();
  await database.visualizationJob.deleteMany();
  await database.windowPhoto.deleteMany();
  await database.galleryOwner.deleteMany();
  await database.conversation.deleteMany();
});

after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});

async function conversation(merchant = shop) {
  const row = await database.conversation.create({
    data: {
      id: randomUUID(),
      shop: merchant,
      origin: `https://${merchant}`,
      credentialHash: `PRIVATE-CREDENTIAL-${randomUUID()}`,
      credentialExpiresAt: new Date(0),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const reply = await database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId: row.id,
      requestId: randomUUID(),
      sequence: 1,
      role: "assistant",
      status: "complete",
    },
  });
  return { ...row, assistantId: reply.id };
}

async function usage(owner, at, overrides = {}) {
  return database.modelUsage.create({
    data: {
      id: randomUUID(),
      conversationId: owner.id,
      assistantId: owner.assistantId,
      model: "gpt-5.6-luna",
      status: "completed",
      serviceTier: "priority",
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      createdAt: new Date(at),
      completedAt: new Date("2026-11-01T00:00:00.000Z"),
      ...overrides,
    },
  });
}

async function voice(owner, at, overrides = {}) {
  return database.voiceSession.create({
    data: {
      id: randomUUID(),
      conversationId: owner.id,
      clientId: randomUUID(),
      status: "closed",
      model: "gpt-live-1",
      usageSeconds: 60,
      createdAt: new Date(at),
      closedAt: new Date("2026-11-01T00:00:00.000Z"),
      leaseExpiresAt: new Date(0),
      ...overrides,
    },
  });
}

async function image(owner, at, overrides = {}) {
  const gallery = await database.galleryOwner.create({
    data: {
      id: randomUUID(),
      shop: owner.shop,
      origin: owner.origin,
      tokenHash: `PRIVATE-${randomUUID()}`,
    },
  });
  const photo = await database.windowPhoto.create({
    data: {
      id: randomUUID(),
      ownerId: gallery.id,
      title: "Room",
      assetKey: "PRIVATE-IMAGE-KEY",
      sha256: randomUUID(),
      width: 1024,
      height: 1024,
      bytes: 100,
      consentVersion: "v1",
      consentAt: new Date(at),
      conversationId: owner.id,
      requestId: randomUUID(),
      requestHash: randomUUID(),
    },
  });
  const job = await database.visualizationJob.create({
    data: {
      id: randomUUID(),
      ownerId: gallery.id,
      windowId: photo.id,
      conversationId: owner.id,
      requestId: randomUUID(),
      requestHash: randomUUID(),
      windowRevision: 1,
      windowTitle: photo.title,
      sourceAssetKey: "PRIVATE-SOURCE",
      productPath: "/products/blackout",
      productTitle: "Blackout",
      cleanup: true,
      promptVersion: "test",
      width: 1024,
      height: 1024,
      deadlineAt: new Date(at),
    },
  });
  return database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: owner.id,
      ordinal: 1,
      model: "gpt-image-2.5-sunburst",
      status: "storage_failed",
      rateSnapshotJson: "{}",
      usageValid: true,
      costUsd: 0.125,
      costEvidence: "reported",
      createdAt: new Date(at),
      completedAt: new Date("2026-11-01T00:00:00.000Z"),
      ...overrides,
    },
  });
}

function assertCostsEqual(actual, expected) {
  for (const [key, value] of Object.entries(expected))
    if (key.endsWith("Usd") && value !== null)
      assert.ok(
        Math.abs(actual[key] - value) <= Math.max(1, Math.abs(value)) * 1e-12,
        `${key} differs: ${actual[key]} versus ${value}`,
      );
    else assert.equal(actual[key], value, key);
}

test("daily spend uses UTC request starts with inclusive boundaries and excludes other merchants", async () => {
  const own = await conversation();
  const foreign = await conversation(otherShop);
  for (const at of [
    "2026-10-05T23:59:59.999Z",
    "2026-10-06T00:00:00.000Z",
    "2026-10-08T23:59:59.999Z",
    "2026-10-09T00:00:00.000Z",
  ]) {
    await usage(own, at);
    await voice(own, at);
    await image(own, at);
  }
  await usage(foreign, "2026-10-07T12:00:00.000Z");
  await voice(foreign, "2026-10-07T12:00:00.000Z");
  await image(foreign, "2026-10-07T12:00:00.000Z", { costUsd: 999 });
  const report = await repository.getDailySpendReport(shop, {
    from: "2026-10-06",
    to: "2026-10-08",
  });
  assert.deepEqual(report.days.map((row) => row.day), [
    "2026-10-06", "2026-10-07", "2026-10-08",
  ]);
  for (const row of [report.days[0], report.days[2]]) {
    assert.equal(row.cost.pricedModelCalls, 1);
    assert.equal(row.cost.pricedVoiceSessions, 1);
    assert.equal(row.cost.pricedImageAttempts, 1);
    assert.equal(row.cost.imageUsd, 0.125);
  }
  assert.deepEqual(report.days[1].cost, repository.emptyCostSummary());
  assert.equal(report.cost.pricedModelCalls, 2);
  assert.equal(report.cost.pricedVoiceSessions, 2);
  assert.equal(report.cost.pricedImageAttempts, 2);
  assert.equal(report.cost.imageUsd, 0.25);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|conversationId|assistantId/);
});

test("daily pricing matches per-call rate periods, tiers and cache/context bands without rounding", async () => {
  const own = await conversation();
  const token = repository.MODEL_PRICES.find(
    (price) => price.kind === "tokens" && price.serviceTier === "priority",
  );
  const live = repository.MODEL_PRICES.find((price) => price.kind === "voice");
  const prices = [
    { ...token, effectiveTo: "2026-10-07T00:00:00.000Z" },
    {
      ...token,
      effectiveFrom: "2026-10-07T00:00:00.000Z",
      prices: {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.2,
        cacheWriteInputPerMillion: 3,
        outputPerMillion: 10,
      },
    },
    { ...live, effectiveTo: "2026-10-07T00:00:00.000Z" },
    { ...live, effectiveFrom: "2026-10-07T00:00:00.000Z", perMinute: 0.2 },
  ];
  const expected = repository.emptyCostSummary();
  const expectedDays = new Map();
  for (const day of ["2026-10-06", "2026-10-07"]) {
    const daily = repository.emptyCostSummary();
    expectedDays.set(day, daily);
    for (const overrides of [
      { serviceTier: "fast", cacheWriteInputTokens: 10 },
      { inputTokens: 272000 },
      { inputTokens: 272001 },
      { model: "unpriced" },
      { outputTokens: null },
      { cachedInputTokens: 100, cacheWriteInputTokens: 1 },
    ]) {
      const row = await usage(own, `${day}T12:00:00.000Z`, overrides);
      const estimate = repository.estimateModelUsage(row, prices);
      repository.addCost(daily, "model", estimate);
      repository.addCost(expected, "model", estimate);
    }
    const row = await voice(own, `${day}T12:00:00.000Z`, { usageSeconds: 12.5 });
    const estimate = repository.estimateVoiceUsage(row, prices);
    repository.addCost(daily, "voice", estimate);
    repository.addCost(expected, "voice", estimate);
    const imageRow = await image(own, `${day}T12:00:00.000Z`, {
      costUsd: 0.0000751,
      costEvidence: "estimated",
    });
    for (const cost of [daily, expected])
      repository.addCost(cost, "image", { usd: imageRow.costUsd, evidence: "estimated" });
  }
  const report = await repository.getDailySpendReport(shop, {
    from: "2026-10-06", to: "2026-10-07",
  }, prices);
  for (const row of report.days) assertCostsEqual(row.cost, expectedDays.get(row.day));
  assertCostsEqual(report.cost, expected);
  assertCostsEqual(report.cost, await repository.getShopCostSummary(shop, prices));
  assert.equal(report.cost.estimatedImageAttempts, 2);
  assert.equal(report.cost.imageUsd, 0.0001502);
});

test("daily costs distinguish missing reports, partial totals, measured zero and no activity", async () => {
  const own = await conversation();
  await usage(own, "2026-10-06T12:00:00.000Z", { inputTokens: null });
  await voice(own, "2026-10-06T12:00:00.000Z", { usageSeconds: null });
  await image(own, "2026-10-06T12:00:00.000Z", {
    costUsd: null, usageValid: false, costEvidence: "unknown",
  });
  await usage(own, "2026-10-07T12:00:00.000Z", {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
  });
  await voice(own, "2026-10-07T12:00:00.000Z", { usageSeconds: 0 });
  await image(own, "2026-10-07T12:00:00.000Z", { costUsd: 0 });
  await usage(own, "2026-10-08T12:00:00.000Z");
  await usage(own, "2026-10-08T12:00:00.000Z", { outputTokens: null });
  const report = await repository.getDailySpendReport(shop, {
    from: "2026-10-06", to: "2026-10-09",
  });
  assert.equal(report.days[0].cost.totalUsd, null);
  assert.equal(report.days[0].cost.unpricedModelCalls, 1);
  assert.equal(report.days[0].cost.unpricedVoiceSessions, 1);
  assert.equal(report.days[0].cost.unpricedImageAttempts, 1);
  assert.equal(report.days[1].cost.totalUsd, 0);
  assert.equal(report.days[1].cost.pricedModelCalls, 1);
  assert.equal(report.days[1].cost.pricedVoiceSessions, 1);
  assert.equal(report.days[1].cost.pricedImageAttempts, 1);
  assert.ok(report.days[2].cost.totalUsd > 0);
  assert.equal(report.days[2].cost.unpricedModelCalls, 1);
  assert.deepEqual(report.days[3].cost, repository.emptyCostSummary());
  assert.equal(report.cost.unpricedModelCalls, 2);
  assert.equal(report.cost.totalUsd, report.days[2].cost.totalUsd);
});

test("daily spend emits three scoped aggregate reads regardless of retained usage size", async () => {
  const own = await conversation();
  const row = await usage(own, "2026-10-06T12:00:00.000Z");
  await database.modelUsage.createMany({
    data: Array.from({ length: 200 }, () => ({ ...row, id: randomUUID() })),
  });
  queries.length = 0;
  const report = await repository.getDailySpendReport(shop, {
    from: "2026-10-01", to: "2026-10-10",
  });
  assert.equal(report.days.length, 10);
  assert.equal(report.cost.pricedModelCalls, 201);
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.match(query, /c\."shop" = \?/);
    assert.match(query, /u\."createdAt" >= \? AND u\."createdAt" < \?/);
    assert.match(query, /date\(u\."createdAt" \/ 1000\.0, 'unixepoch'\)/);
    assert.match(query, /GROUP BY groupKey,/);
    assert.match(query, /COUNT\(\*\)/);
    assert.doesNotMatch(query, /SELECT\s+u\."id"|usageJson|partsJson|credentialHash/);
  }
});

test("server callers reject invalid or unbounded ranges before reading usage", async () => {
  queries.length = 0;
  for (const range of [
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-10-07", to: "2026-10-06" },
    { from: "2026-01-01", to: "2027-01-02" },
    { from: "2026-10-06T00:00:00Z", to: "2026-10-07" },
  ])
    await assert.rejects(repository.getDailySpendReport(shop, range), RangeError);
  assert.equal(queries.length, 0);
  const report = await repository.getDailySpendReport(shop, {
    from: "2024-01-01", to: "2024-12-31",
  });
  assert.equal(report.days.length, 366);
  assert.deepEqual(report.cost, repository.emptyCostSummary());
  assert.equal(queries.length, 3);
});
