import assert from "node:assert/strict";
import {Buffer} from "node:buffer";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {after, before, test} from "node:test";
import {PrismaClient} from "@prisma/client";
import {build} from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url), previousGlobal = global.prismaGlobal;
const bundle = await build({entryPoints: ["admin/conversations/memory-history.server.ts"], bundle: true, write: false, format: "cjs", platform: "node", external: ["@prisma/client"]});
let directory, database, recall;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-memory-history-"));
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({datasourceUrl: databaseUrl});
  global.prismaGlobal = database;
  const module = {exports: {}};
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
  recall = module.exports.recallConversationHistory;
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, {recursive: true, force: true});
  global.prismaGlobal = previousGlobal;
});
async function conversation() {
  return database.conversation.create({data: {id: randomUUID(), shop: "test.myshopify.com", origin: "https://test.example", credentialHash: randomUUID(), credentialExpiresAt: new Date(Date.now() + 60000)}});
}
async function message(conversationId, sequence, text) {
  return database.conversationMessage.create({data: {id: randomUUID(), requestId: randomUUID(), conversationId, sequence, role: "assistant", status: "complete", partsJson: JSON.stringify([{type: "text", text}]), completedAt: new Date()}});
}
async function receipt(conversationId, assistantId, overrides = {}) {
  return database.toolInvocation.create({data: {id: randomUUID(), providerCallId: randomUUID(), conversationId, assistantId, name: "apply_measurements", status: "complete", argumentsJson: JSON.stringify({productPath: "/products/shared-blind"}), resultJson: JSON.stringify({status: "applied", measurements: {width: 550, height: 1150, unit: "mm"}, configuredPrice: "£110.74"}), completedAt: new Date(), ...overrides}});
}
const lookup = (id, beforeSequence = null) => recall(id, {query: "Willow pane", beforeSequence}, new AbortController().signal);
const toolEntries = (result) => result.entries.filter((entry) => entry.source.startsWith("tool:"));

test("a customer window label recalls confirmed receipts from its exact matched assistant turn without adjacent or foreign expansion", async () => {
  const own = await conversation(), foreign = await conversation();
  const matched = await message(own.id, 4, "Willow pane 2 was entered; purchase remains pending.");
  const applied = await receipt(own.id, matched.id);
  const failed = await receipt(own.id, matched.id, {name: "configure_product", status: "failed", resultJson: null, error: "The option change was not confirmed."});
  await receipt(own.id, matched.id, {name: "ask_question"});
  await receipt(own.id, matched.id, {name: "present_photos"});
  const adjacent = await message(own.id, 5, "The next task uses that same blind.");
  const unrelated = await receipt(own.id, adjacent.id);
  const foreignMatched = await message(foreign.id, 4, "Willow pane private data from another conversation.");
  const foreignReceipt = await receipt(foreign.id, foreignMatched.id);
  const original = await database.toolInvocation.findUniqueOrThrow({where: {id: applied.id}});
  const result = await lookup(own.id);
  assert.equal(result.referenceOnly, true);
  const tools = toolEntries(result);
  assert.deepEqual(new Set(tools.map((entry) => entry.source)), new Set([`tool:${applied.id}`, `tool:${failed.id}`]));
  assert.equal(JSON.parse(tools.find((entry) => entry.source === `tool:${applied.id}`).text).result.status, "applied");
  assert.equal(JSON.parse(tools.find((entry) => entry.source === `tool:${failed.id}`).text).status, "failed");
  assert.ok(result.entries.some((entry) => entry.source === "message:4"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${unrelated.id}|${foreignReceipt.id}|private data|ask_question|present_photos`));
  assert.deepEqual(await database.toolInvocation.findUniqueOrThrow({where: {id: applied.id}}), original);
  assert.deepEqual((await lookup(own.id, 4)).entries, [], "an exclusive history cursor also bounds linked receipts");
  assert.equal(result.nextBeforeSequence, 4);
});

test("matched-turn proof takes priority within the existing eight-receipt and UTF-8 byte limits with deterministic ordering", async () => {
  const own = await conversation();
  const matched = await message(own.id, 1, `Willow pane configured. ${"x".repeat(23000)}`);
  const proof = await receipt(own.id, matched.id, {createdAt: new Date("2026-01-01T00:00:00Z")});
  for (let index = 0; index < 10; index++) {
    const newer = await message(own.id, index + 2, "An unrelated newer setup.");
    await receipt(own.id, newer.id, {createdAt: new Date("2026-02-01T00:00:00Z"), argumentsJson: JSON.stringify({label: "Willow pane", padding: "y".repeat(6000)})});
  }
  const first = await lookup(own.id), second = await lookup(own.id);
  assert.deepEqual(first, second);
  assert.ok(toolEntries(first).some((entry) => entry.source === `tool:${proof.id}`), "newer lexical receipts must not crowd out the exact completion proof");
  assert.ok(toolEntries(first).length <= 8);
  assert.ok(first.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text, "utf8"), 0) <= 24000);
  assert.deepEqual(first.entries.map((entry) => entry.sequence), first.entries.map((entry) => entry.sequence).sort((a, b) => a - b));
  await assert.rejects(recall(own.id, {query: "Willow pane", beforeSequence: null}, AbortSignal.abort()));
});
