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
  entryPoints: ["admin/conversations/repository.server.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
const shop = "hd-dev-multi.myshopify.com";
const origin = `https://${shop}`;
let directory;
let database;
let repository;
const previousAppUrl = process.env.SHOPIFY_APP_URL;
const previousGlobal = global.prismaGlobal;

function loadRepository() {
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-conversations-"));
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
      .filter(Boolean)) {
      await database.$executeRawUnsafe(statement);
    }
  }
  repository = loadRepository();
});

beforeEach(async () => {
  await database.conversation.deleteMany();
  await database.session.deleteMany();
  await database.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "test",
      isOnline: false,
      accessToken: "test-install-token",
      scope: "write_app_proxy",
    },
  });
});

after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
  if (previousAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = previousAppUrl;
});

test("credentials are hashed, scoped to their conversation, and expire", async () => {
  const first = await repository.createConversation(shop, origin);
  const second = await repository.createConversation(shop, origin);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    first.apiBaseUrl,
    "https://roman.example.test/api/conversations",
  );
  assert.deepEqual(first.conversation, {
    id: first.conversationId,
    messages: [],
    busy: false,
  });
  const row = await database.conversation.findUniqueOrThrow({
    where: { id: first.conversationId },
  });
  assert.match(row.credentialHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(first.token));
  assert.equal(
    (await repository.authorizeCredential(first.conversationId, first.token))
      .shop,
    shop,
  );
  await assert.rejects(
    repository.authorizeCredential(first.conversationId, second.token),
    { status: 401 },
  );
  await database.conversation.update({
    where: { id: first.conversationId },
    data: { credentialExpiresAt: new Date(0) },
  });
  await assert.rejects(
    repository.authorizeCredential(first.conversationId, first.token),
    { status: 401 },
  );
});

test("scope revocation and uninstall deny credentials while retaining the conversation", async () => {
  const credential = await repository.createConversation(shop, origin);
  await database.session.update({
    where: { id: `offline_${shop}` },
    data: { scope: "" },
  });
  await assert.rejects(
    repository.authorizeCredential(credential.conversationId, credential.token),
    { status: 401 },
  );
  await database.session.update({
    where: { id: `offline_${shop}` },
    data: { scope: "write_app_proxy" },
  });
  assert.ok(
    await repository.authorizeCredential(
      credential.conversationId,
      credential.token,
    ),
  );
  await database.session.deleteMany();
  await assert.rejects(
    repository.authorizeCredential(credential.conversationId, credential.token),
    { status: 401 },
  );
  assert.equal(await database.conversation.count(), 1);
});

test("turns persist ordered public messages and deduplicate the exact request", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const input = {
    requestId: randomUUID(),
    text: "Which blind fits a sunny room?",
  };
  const started = await repository.beginTurn(id, input);
  assert.equal(started.snapshot.busy, true);
  assert.deepEqual(started.history, [{ role: "user", text: input.text }]);
  assert.deepEqual(
    started.snapshot.messages.map(({ role, status }) => [role, status]),
    [
      ["user", "complete"],
      ["assistant", "pending"],
    ],
  );
  assert.equal((await repository.beginTurn(id, input)).assistantId, null);
  await assert.rejects(
    repository.beginTurn(id, { ...input, text: "Changed message" }),
    { status: 400 },
  );
  await assert.rejects(
    repository.beginTurn(id, {
      requestId: randomUUID(),
      text: "Second message",
    }),
    { status: 409 },
  );
  await repository.finishTurn(id, started.assistantId, {
    text: "Consider light filtering.",
    status: "complete",
    model: "test-model",
    serviceTier: "priority",
  });
  const persisted = await loadRepository().getSnapshot(id);
  assert.equal(persisted.busy, false);
  assert.equal(persisted.messages[1].id, started.assistantId);
  assert.equal(
    persisted.messages[1].parts[0].text,
    "Consider light filtering.",
  );
  assert.deepEqual(Object.keys(persisted.messages[1]).sort(), [
    "createdAt",
    "id",
    "parts",
    "role",
    "status",
  ]);
  const next = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "What about glare?",
  });
  assert.deepEqual(
    next.history.map(({ role }) => role),
    ["user", "assistant", "user"],
  );
});

test("simultaneous turns cannot create two pending replies", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const results = await Promise.allSettled([
    repository.beginTurn(id, { requestId: randomUUID(), text: "First" }),
    repository.beginTurn(id, { requestId: randomUUID(), text: "Second" }),
  ]);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.status, 409);
  assert.equal(
    await database.conversationMessage.count({
      where: { conversationId: id, status: "pending" },
    }),
    1,
  );
  assert.equal(
    await database.conversationMessage.count({ where: { conversationId: id } }),
    2,
  );
});

test("restart recovery fails only old pending replies and ignores late completion", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const started = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Old question",
  });
  await repository.failPending(id);
  assert.equal((await repository.getSnapshot(id)).busy, true);
  await database.conversationMessage.update({
    where: { id: started.assistantId },
    data: { createdAt: new Date(0) },
  });
  await repository.failPending(id);
  await repository.finishTurn(id, started.assistantId, {
    text: "A late reply",
    status: "complete",
  });
  const recovered = await repository.getSnapshot(id);
  assert.equal(recovered.busy, false);
  assert.equal(recovered.messages[1].status, "failed");
  assert.equal(recovered.messages[1].parts[0].text, "");
  const next = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "New question",
  });
  assert.deepEqual(next.history, [
    { role: "user", text: "Old question" },
    { role: "user", text: "New question" },
  ]);
});

test("failed replies release the conversation and bounded turn limit survives reload", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const firstInput = { requestId: randomUUID(), text: "A question" };
  const started = await repository.beginTurn(id, firstInput);
  await repository.finishTurn(id, started.assistantId, {
    text: "Partial",
    status: "failed",
    error: "Please try again.",
  });
  assert.equal((await repository.getSnapshot(id)).busy, false);
  await database.conversation.update({
    where: { id },
    data: { turnCount: 40 },
  });
  const reloaded = loadRepository();
  assert.equal((await reloaded.beginTurn(id, firstInput)).assistantId, null);
  await assert.rejects(
    reloaded.beginTurn(id, {
      requestId: randomUUID(),
      text: "Another question",
    }),
    { status: 429 },
  );
});

test("the daily shop creation bound is durable and does not leak between shops", async () => {
  const first = await repository.createConversation(shop, origin);
  const row = await database.conversation.findUniqueOrThrow({
    where: { id: first.conversationId },
  });
  await database.conversation.createMany({
    data: Array.from({ length: 99 }, () => ({
      ...row,
      id: randomUUID(),
      credentialHash: randomUUID(),
    })),
  });
  await assert.rejects(loadRepository().createConversation(shop, origin), {
    status: 429,
  });
  const otherShop = "hd-dev-single.myshopify.com";
  assert.ok(
    (await repository.createConversation(otherShop, `https://${otherShop}`))
      .conversationId,
  );
});
