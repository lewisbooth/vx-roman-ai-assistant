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
  entryPoints: ["admin/usage/repository.server.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
let directory, database, repository, conversationId, assistantId, voiceId;
const previousGlobal = global.prismaGlobal;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-usage-"));
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
  conversationId = randomUUID();
  assistantId = randomUUID();
  voiceId = randomUUID();
  await database.conversation.create({
    data: {
      id: conversationId,
      shop: "hd-dev-single.myshopify.com",
      origin: "https://hd-dev-single.myshopify.com",
      credentialHash: randomUUID(),
      credentialExpiresAt: new Date(Date.now() + 86400000),
      messages: {
        create: {
          id: assistantId,
          requestId: randomUUID(),
          role: "assistant",
          status: "pending",
          sequence: 0,
        },
      },
      voiceSessions: {
        create: {
          id: voiceId,
          clientId: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 45000),
        },
      },
    },
  });
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});
const attempt = (extra = {}) => ({
  id: randomUUID(),
  model: "gpt-5.6-luna",
  serviceTier: null,
  status: "pending",
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  ...extra,
});
const complete = (usage, extra = {}) => ({
  ...usage,
  status: "completed",
  model: "gpt-5.6-luna-observed",
  serviceTier: "priority",
  inputTokens: 20,
  cachedInputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 2,
  totalTokens: 25,
  ...extra,
});
const record = (usage) =>
  repository.recordModelUsage(conversationId, assistantId, usage);

test("request UUIDs persist once, retain actual provider fields and cannot be downgraded", async () => {
  const usage = attempt();
  await record(usage);
  await record(usage);
  await record(complete(usage));
  await record(complete(usage, { totalTokens: 90 }));
  await record(usage);
  const rows = await database.modelUsage.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
  assert.equal(rows[0].model, "gpt-5.6-luna-observed");
  assert.equal(rows[0].serviceTier, "priority");
  assert.equal(rows[0].totalTokens, 25);
  assert.equal(rows[0].cachedInputTokens, 10);
  assert.equal(rows[0].reasoningTokens, 2);
  assert.ok(rows[0].completedAt);
});

test("cancelled replies and ended conversations still accept their already incurred usage", async () => {
  const usage = attempt();
  await record(usage);
  await database.conversationMessage.update({
    where: { id: assistantId },
    data: { status: "failed", role: "context" },
  });
  await database.conversation.update({
    where: { id: conversationId },
    data: { status: "ended" },
  });
  await record(complete(usage, { status: "incomplete" }));
  assert.equal(
    (await database.modelUsage.findUnique({ where: { id: usage.id } }))
      .totalTokens,
    25,
  );
  assert.equal(
    (
      await database.conversationMessage.findUnique({
        where: { id: assistantId },
      })
    ).status,
    "failed",
  );
});

test("known zero, unavailable attempts and different tool rounds remain distinct", async () => {
  const first = attempt();
  const missing = attempt();
  const zero = attempt();
  await record(complete(first));
  await record({ ...missing, status: "unavailable" });
  await record(
    complete(zero, {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    }),
  );
  const rows = await database.modelUsage.findMany({
    orderBy: { createdAt: "asc" },
  });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === missing.id).totalTokens, null);
  assert.equal(rows.find((r) => r.id === zero.id).totalTokens, 0);
  assert.equal(
    rows
      .filter((r) => r.totalTokens !== null)
      .reduce((sum, r) => sum + r.totalTokens, 0),
    25,
  );
});

test("model usage is scoped to its conversation and assistant, including UUID replays", async () => {
  const usage = attempt();
  await record(usage);
  const otherAssistant = randomUUID();
  await database.conversationMessage.create({
    data: {
      id: otherAssistant,
      conversationId,
      requestId: randomUUID(),
      role: "assistant",
      status: "pending",
      sequence: 1,
    },
  });
  await assert.rejects(
    repository.recordModelUsage(randomUUID(), assistantId, complete(usage)),
    /owner/,
  );
  await assert.rejects(
    repository.recordModelUsage(
      conversationId,
      otherAssistant,
      complete(usage),
    ),
    /owner/,
  );
  await database.conversationMessage.update({
    where: { id: otherAssistant },
    data: { role: "user" },
  });
  await assert.rejects(
    repository.recordModelUsage(conversationId, otherAssistant, attempt()),
    /owner/,
  );
  assert.equal(await database.modelUsage.count(), 1);
});

test("invalid provider counts and unbounded metadata cannot enter usage records", async () => {
  for (const extra of [
    { inputTokens: -1 },
    { outputTokens: NaN },
    { totalTokens: 2 ** 31 },
    { inputTokens: 1.5 },
    { model: "private\nmetadata" },
    { serviceTier: "x".repeat(500) },
  ])
    await assert.rejects(
      record(complete(attempt(), extra)),
      /Invalid model usage/,
    );
  await assert.rejects(
    record(complete(attempt(), { cachedInputTokens: 21 })),
    /Invalid model usage/,
  );
  await assert.rejects(
    record(complete(attempt(), { reasoningTokens: 6 })),
    /Invalid model usage/,
  );
  assert.equal(await database.modelUsage.count(), 0);
});

test("voice records keep final cumulative seconds once, including a real zero", async () => {
  await database.voiceSession.update({
    where: { id: voiceId },
    data: { status: "closed" },
  });
  await repository.recordVoiceUsage(conversationId, voiceId, {
    model: "gpt-live-1",
    seconds: null,
  });
  assert.equal(
    (await database.voiceSession.findUnique({ where: { id: voiceId } }))
      .usageSeconds,
    null,
  );
  await repository.recordVoiceUsage(conversationId, voiceId, {
    model: "gpt-live-1",
    seconds: 0,
  });
  await repository.recordVoiceUsage(conversationId, voiceId, {
    model: "gpt-live-1",
    seconds: 12.5,
  });
  await repository.recordVoiceUsage(conversationId, voiceId, {
    model: "gpt-live-1",
    seconds: null,
  });
  const row = await database.voiceSession.findUnique({
    where: { id: voiceId },
  });
  assert.equal(row.usageSeconds, 0);
  assert.equal(row.model, "gpt-live-1");
});

test("voice duration rejects invalid numbers and other conversation identities", async () => {
  for (const seconds of [-1, NaN, Infinity, "20", Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      repository.recordVoiceUsage(conversationId, voiceId, {
        model: "gpt-live-1",
        seconds,
      }),
      /Invalid voice usage/,
    );
  await assert.rejects(
    repository.recordVoiceUsage(randomUUID(), voiceId, {
      model: "gpt-live-1",
      seconds: 10,
    }),
    /owner/,
  );
  await repository.recordVoiceUsage(conversationId, voiceId, {
    model: "gpt-live-1",
    seconds: 10.125,
  });
  assert.equal(
    (await database.voiceSession.findUnique({ where: { id: voiceId } }))
      .usageSeconds,
    10.125,
  );
});

test("rows without provider reports have unknown usage, and conversation deletion owns usage cleanup", async () => {
  const voice = await database.voiceSession.findUnique({
    where: { id: voiceId },
  });
  assert.equal(voice.model, null);
  assert.equal(voice.usageSeconds, null);
  assert.equal(await database.modelUsage.count(), 0);
  await record(complete(attempt()));
  await database.conversation.delete({ where: { id: conversationId } });
  assert.equal(await database.modelUsage.count(), 0);
});
