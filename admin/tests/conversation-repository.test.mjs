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
    status: "active",
    revision: 0,
    messages: [],
    busy: false,
    tools: [],
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

function pageView(overrides = {}) {
  return {
    requestId: randomUUID(),
    title: "  Blackout blinds  ",
    path: "/collections/blackout-blinds",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function executor() {
  return {
    clientId: randomUUID(),
    claimToken: randomBytes(32).toString("base64url"),
  };
}

async function pendingLookup(id) {
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Find blackout blinds",
  });
  const input = {
    providerCallId: randomUUID(),
    name: "search_products",
    arguments: { query: "blackout blinds" },
  };
  const tool = await repository.createToolInvocation(
    id,
    turn.assistantId,
    input,
  );
  return { turn, tool, input };
}

test("journey and turns share one durable order with idempotent revisions and untrusted model context", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const page = pageView();
  const first = await repository.appendJourney(id, page);
  assert.equal(first.revision, 1);
  assert.equal(first.messages[0].role, "context");
  assert.equal(first.messages[0].parts[0].title, "Blackout blinds");
  assert.deepEqual(await repository.appendJourney(id, page), first);
  await assert.rejects(
    repository.appendJourney(id, { ...page, path: "/cart" }),
    { status: 400 },
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "What fits?",
  });
  assert.equal(turn.origin, origin);
  assert.match(turn.history[0].text, /^Untrusted storefront observations/);
  assert.match(turn.history[0].text, /\/collections\/blackout-blinds/);
  const nextPage = await repository.appendJourney(
    id,
    pageView({ path: "/products/blind" }),
  );
  assert.equal(nextPage.busy, true);
  assert.equal(nextPage.revision, 3);
  await repository.finishTurn(id, turn.assistantId, {
    text: "Measure first.",
    status: "complete",
  });
  const final = await repository.getSnapshot(id);
  assert.equal(final.revision, 4);
  assert.deepEqual(
    final.messages.map((row) => row.role),
    ["context", "user", "assistant", "context"],
  );
  const rows = await database.conversationMessage.findMany({
    where: { conversationId: id },
    orderBy: { sequence: "asc" },
  });
  assert.deepEqual(
    rows.map((row) => row.sequence),
    [0, 1, 2, 3],
  );
  assert.equal(await repository.getConversationOrigin(id), origin);
});

test("journey rejects sensitive URLs, unbounded timestamps and excess rows without storing them", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  for (const path of [
    "https://other.test/",
    "//other.test/",
    "/cart?token=secret",
    "/cart#secret",
    "/account",
    "/en/account/orders",
    "/checkouts/secret",
    "/checkout",
    "/challenge",
    "/password",
    "/%61ccount",
    "/products/../account",
    "/products/%5csecret",
    "/products/%00secret",
    "/products/%3ftoken=secret",
    "/products/\nsecret",
  ]) {
    await assert.rejects(repository.appendJourney(id, pageView({ path })), {
      status: 400,
    });
  }
  for (const input of [
    { title: "" },
    { title: "x".repeat(201) },
    { occurredAt: "bad" },
    { occurredAt: new Date(0).toISOString() },
    { occurredAt: new Date(Date.now() + 600000).toISOString() },
  ]) {
    await assert.rejects(repository.appendJourney(id, pageView(input)), {
      status: 400,
    });
  }
  assert.equal((await repository.getSnapshot(id)).revision, 0);
  await repository.appendJourney(id, pageView({ path: "/cart" }));
  const row = await database.conversationMessage.findFirstOrThrow({
    where: { conversationId: id },
  });
  await database.conversationMessage.createMany({
    data: Array.from({ length: 199 }, (_, index) => ({
      ...row,
      id: randomUUID(),
      requestId: randomUUID(),
      sequence: index + 1,
    })),
  });
  await database.conversation.update({
    where: { id },
    data: { nextSequence: 200 },
  });
  await assert.rejects(repository.appendJourney(id, pageView()), {
    status: 429,
  });
  assert.equal(
    await database.conversationMessage.count({ where: { conversationId: id } }),
    200,
  );
});

test("competing catalog executors receive one durable claim and cannot complete another claim or conversation", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const { tool, turn, input } = await pendingLookup(id);
  assert.deepEqual(
    await repository.createToolInvocation(id, turn.assistantId, input),
    tool,
  );
  assert.equal((await repository.getSnapshot(id)).revision, 2);
  const claims = [executor(), executor()];
  const outcomes = await Promise.all(
    claims.map((claim) => repository.claimToolInvocation(id, tool.id, claim)),
  );
  assert.equal(outcomes.filter((result) => result.claimed).length, 1);
  const winner = claims[outcomes.findIndex((result) => result.claimed)];
  const loser = claims[outcomes.findIndex((result) => !result.claimed)];
  assert.deepEqual(await repository.claimToolInvocation(id, tool.id, winner), {
    claimed: true,
  });
  const state = await repository.getSnapshot(id);
  assert.equal(state.revision, 3);
  assert.equal(state.tools[0].status, "running");
  assert.ok(!JSON.stringify(state).includes(winner.claimToken));
  const persisted = await database.toolInvocation.findUniqueOrThrow({
    where: { id: tool.id },
  });
  assert.match(persisted.claimTokenHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(persisted).includes(winner.claimToken));
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, loser, { productIds: [] }),
    { status: 401 },
  );
  const { conversationId: otherId } = await repository.createConversation(
    shop,
    origin,
  );
  await assert.rejects(
    repository.claimToolInvocation(otherId, tool.id, winner),
    { status: 404 },
  );
  await assert.rejects(
    repository.completeToolInvocation(otherId, tool.id, winner, {
      productIds: [],
    }),
    { status: 404 },
  );
});

test("catalog completion persists only product IDs once and final text preserves its widget", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const { tool, turn } = await pendingLookup(id);
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const result = {
    productIds: ["gid://shopify/Product/123", "gid://shopify/Product/456"],
  };
  await repository.completeToolInvocation(id, tool.id, claim, result);
  await repository.completeToolInvocation(id, tool.id, claim, result);
  let state = await repository.getSnapshot(id);
  assert.equal(state.revision, 4);
  assert.deepEqual(state.tools, []);
  assert.deepEqual(state.messages[1].parts[1], {
    type: "products",
    version: 1,
    invocationId: tool.id,
    ...result,
  });
  const persisted = await database.toolInvocation.findUniqueOrThrow({
    where: { id: tool.id },
  });
  assert.deepEqual(JSON.parse(persisted.productIdsJson), result.productIds);
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, { productIds: [] }),
    { status: 409 },
  );
  await repository.finishTurn(id, turn.assistantId, {
    text: "These are worth exploring.",
    status: "complete",
  });
  state = await repository.getSnapshot(id);
  assert.equal(state.revision, 5);
  assert.equal(state.messages[1].parts.length, 2);
  assert.equal(state.messages[1].parts[0].text, "These are worth exploring.");
  assert.deepEqual(
    await repository.claimToolInvocation(id, tool.id, executor()),
    { claimed: false },
  );
  const next = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Compare those.",
  });
  assert.ok(
    next.history.some(
      (entry) =>
        entry.role === "user" &&
        entry.text.startsWith("Untrusted storefront observations") &&
        entry.text.includes(result.productIds[0]),
    ),
  );
});

test("invalid tool arguments and results cannot persist and lookups have a per-reply bound", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const { tool, turn, input } = await pendingLookup(id);
  for (const call of [
    { ...input, name: "clear_cart" },
    { ...input, arguments: { query: "x", arbitrary: true } },
    { ...input, arguments: { query: "" } },
  ]) {
    await assert.rejects(
      repository.createToolInvocation(id, turn.assistantId, call),
      { status: 400 },
    );
  }
  await assert.rejects(
    repository.claimToolInvocation(id, tool.id, {
      clientId: "bad",
      claimToken: "bad",
    }),
    { status: 400 },
  );
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  for (const result of [
    { productIds: ["gid://shopify/ProductVariant/123"] },
    { productIds: ["gid://shopify/Product/1", "gid://shopify/Product/1"] },
    { productIds: ["https://other.test"] },
    { productIds: ["gid://shopify/Product/1"], error: "failed" },
    { productIds: [], error: "x".repeat(501) },
  ]) {
    await assert.rejects(
      repository.completeToolInvocation(id, tool.id, claim, result),
      { status: 400 },
    );
  }
  for (let index = 1; index < 8; index++)
    await repository.createToolInvocation(id, turn.assistantId, {
      ...input,
      providerCallId: randomUUID(),
    });
  await assert.rejects(
    repository.createToolInvocation(id, turn.assistantId, {
      ...input,
      providerCallId: randomUUID(),
    }),
    { status: 429 },
  );
  assert.equal((await repository.getSnapshot(id)).tools.length, 8);
});

test("ending a chat and server recovery prevent late catalog writes without losing its transcript", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const { tool, turn } = await pendingLookup(id);
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const ended = await repository.endConversation(id);
  assert.equal(ended.status, "ended");
  assert.equal(ended.busy, false);
  assert.equal(ended.revision, 4);
  assert.deepEqual(ended.tools, []);
  assert.equal(ended.messages.length, 2);
  assert.deepEqual(await repository.endConversation(id), ended);
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, { productIds: [] }),
    { status: 409 },
  );
  await assert.rejects(repository.appendJourney(id, pageView()), {
    status: 409,
  });
  await assert.rejects(
    repository.beginTurn(id, { requestId: randomUUID(), text: "Restart" }),
    { status: 409 },
  );
  await repository.finishTurn(id, turn.assistantId, {
    text: "Late reply",
    status: "complete",
  });
  assert.deepEqual(await repository.getSnapshot(id), ended);
  const { conversationId: nextId } = await repository.createConversation(
    shop,
    origin,
  );
  const next = await pendingLookup(nextId);
  await repository.claimToolInvocation(nextId, next.tool.id, claim);
  await database.conversationMessage.update({
    where: { id: next.turn.assistantId },
    data: { createdAt: new Date(0) },
  });
  await assert.rejects(
    repository.completeToolInvocation(nextId, next.tool.id, claim, {
      productIds: [],
    }),
    { status: 409 },
  );
  await repository.failPending(nextId);
  const recovered = await repository.getSnapshot(nextId);
  assert.equal(recovered.busy, false);
  assert.deepEqual(recovered.tools, []);
  assert.equal(recovered.messages[1].status, "failed");
});

test("migration retains legacy messages, metadata and credentials and advances ordering past existing sequences", async () => {
  const legacy = new PrismaClient({
    datasourceUrl: `file:${path.join(directory, "migration.sqlite").replaceAll("\\", "/")}`,
  });
  async function migrate(name) {
    const sql = await readFile(
      `prisma/migrations/${name}/migration.sql`,
      "utf8",
    );
    for (const statement of sql
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await legacy.$executeRawUnsafe(statement);
  }
  try {
    await migrate("20240530213853_create_session_table");
    await migrate("20260915120000_add_conversations");
    const id = randomUUID();
    const messageId = randomUUID();
    const originalText = 'A "quoted" blind\nwith café and 🪟';
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Conversation" ("id", "shop", "origin", "credentialHash", "credentialExpiresAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
      id,
      shop,
      origin,
      "a".repeat(64),
      new Date(Date.now() + 100000),
      new Date(),
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "ConversationMessage" ("id", "conversationId", "requestId", "sequence", "role", "status", "text", "model", "serviceTier", "completedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      messageId,
      id,
      randomUUID(),
      7,
      "assistant",
      "complete",
      originalText,
      "fixture-model",
      "priority",
      new Date(),
    );
    await migrate("20260915150000_conversation_catalog_journey");
    const row = await legacy.conversation.findUniqueOrThrow({
      where: { id },
      include: { messages: true },
    });
    assert.equal(row.credentialHash, "a".repeat(64));
    assert.equal(row.nextSequence, 8);
    assert.equal(row.status, "active");
    assert.deepEqual(JSON.parse(row.messages[0].partsJson), [
      { type: "text", text: originalText },
    ]);
    assert.equal(row.messages[0].id, messageId);
    assert.equal(row.messages[0].sequence, 7);
    assert.equal(row.messages[0].model, "fixture-model");
    assert.equal(row.messages[0].serviceTier, "priority");
    assert.ok(row.messages[0].completedAt);
    const columns = await legacy.$queryRawUnsafe(
      'PRAGMA table_info("ConversationMessage")',
    );
    assert.ok(!columns.some((column) => column.name === "text"));
    const violations = await legacy.$queryRawUnsafe("PRAGMA foreign_key_check");
    assert.deepEqual(violations, []);
  } finally {
    await legacy.$disconnect();
  }
});
