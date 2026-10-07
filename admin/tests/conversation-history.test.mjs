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
    contents: `export * from "./admin/conversations/repository.server.ts";
      export {saveLibraryDiscovery, bindLibrarySource, clearLibrarySession, readLibraryGuides} from "./admin/guides/library.server.ts";
      export {latestProductPage} from "./admin/guides/product-page.server.ts";`,
    resolveDir: process.cwd(),
  },
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
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: "event", level: "query" }],
  });

  global.prismaGlobal = database;
  process.env.SHOPIFY_APP_URL = "https://roman.example.test";
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

test("bounded snapshot and stable history pages preserve a transcript beyond the former lifetime ceiling", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const count = 2400;
  await database.conversationMessage.createMany({
    data: Array.from({ length: count }, (_, sequence) => ({
      id: randomUUID(),
      conversationId: id,
      requestId: randomUUID(),
      sequence,
      role: sequence % 2 ? "assistant" : "user",
      status: "complete",
      completedAt: new Date(sequence * 1000),
      partsJson: JSON.stringify([
        { type: "text", text: `Message ${sequence}` },
      ]),
    })),
  });
  await database.conversation.update({
    where: { id },
    data: { nextSequence: count, revision: count },
  });
  const snapshot = await repository.getSnapshot(id);
  assert.equal(snapshot.history.start, count - 256);
  assert.equal(snapshot.history.entries.length, 256);
  assert.equal(snapshot.current.hasCustomerReply, true);
  assert.ok(snapshot.messages.length <= 272);
  const sequences = new Set(
    snapshot.history.entries.map((entry) => entry.sequence),
  );
  let before = snapshot.history.before;
  while (before !== null) {
    const result = await repository.getHistoryPage(id, before);
    assert.equal(result.history.end, before);
    assert.ok(result.history.entries.length <= 256);
    for (const entry of result.history.entries) {
      assert.ok(!sequences.has(entry.sequence));
      sequences.add(entry.sequence);
    }
    before = result.history.before;
  }
  assert.equal(sequences.size, count);
  const cursor = snapshot.history.before;
  await database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId: id,
      requestId: randomUUID(),
      sequence: count,
      role: "user",
      status: "complete",
      partsJson: JSON.stringify([{ type: "text", text: "New turn" }]),
    },
  });
  await database.conversation.update({
    where: { id },
    data: { nextSequence: count + 1, revision: count + 1 },
  });
  assert.equal(
    (await repository.getHistoryPage(id, cursor)).history.end,
    cursor,
  );
  await assert.rejects(repository.getHistoryPage(id, count + 2), {
    status: 400,
  });
  await assert.rejects(repository.getHistoryPage(id, 0), { status: 400 });
});

test("current product and pending question survive a caption-only recent page", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const voiceId = randomUUID();
  await database.voiceSession.create({
    data: {
      id: voiceId,
      conversationId: id,
      clientId: randomUUID(),
      status: "closed",
      leaseExpiresAt: new Date(),
    },
  });
  const questionId = randomUUID();
  await database.conversationMessage.createMany({
    data: [
      {
        id: randomUUID(),
        conversationId: id,
        requestId: randomUUID(),
        sequence: 0,
        role: "context",
        status: "complete",
        partsJson: JSON.stringify([
          {
            type: "navigation",
            version: 1,
            invocationId: randomUUID(),
            title: "Linen Blind",
            path: "/products/linen-blind",
          },
        ]),
      },
      {
        id: randomUUID(),
        conversationId: id,
        requestId: randomUUID(),
        sequence: 1,
        role: "assistant",
        status: "complete",
        partsJson: JSON.stringify([
          {
            type: "question",
            version: 1,
            invocationId: questionId,
            question: "Which room?",
            answers: ["Bedroom", "Kitchen"],
          },
        ]),
      },
    ],
  });
  await database.voiceTranscript.createMany({
    data: Array.from({ length: 600 }, (_, index) => ({
      id: randomUUID(),
      conversationId: id,
      voiceId,
      providerEventId: `caption-${index}`,
      sequence: index + 2,
      role: "assistant",
      text: " hello",
      startMs: index * 10,
      endMs: index * 10 + 5,
    })),
  });
  await database.conversation.update({
    where: { id },
    data: { nextSequence: 602, revision: 602 },
  });
  const result = await repository.getSnapshot(id);
  assert.deepEqual(result.current.activeProduct, {
    path: "/products/linen-blind",
    title: "Linen Blind",
  });
  assert.equal(result.current.pendingQuestion.invocationId, questionId);
  assert.equal(result.current.hasCustomerReply, false);
  assert.ok(
    result.historyUpdates.some((entry) =>
      entry.message?.parts.some((part) => part.type === "question"),
    ),
  );
  assert.equal(result.history.entries.length, 256);
});
