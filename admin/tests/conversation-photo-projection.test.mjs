import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {after, before, test} from "node:test";
import {PrismaClient} from "@prisma/client";
import {build} from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {contents: `export * from './admin/conversations/repository.server.ts';
    export {latestQuestion} from './shared/questions.ts';
    export {isMediaPart} from './shared/visualizations.ts';`, resolveDir: process.cwd()},
  bundle: true, write: false, format: "cjs", platform: "node", external: ["@prisma/client"],
});
const origin = "https://hd-dev-single.myshopify.com";
const previousGlobal = global.prismaGlobal;
let directory, database, repository;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-photo-projection-"));
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({datasourceUrl: databaseUrl});
  global.prismaGlobal = database;
  const module = {exports: {}};
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
  repository = module.exports;
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, {recursive: true, force: true});
  global.prismaGlobal = previousGlobal;
});

const childCallId = (assistantId, callId) => `roman:photos:${createHash("sha256").update(JSON.stringify([assistantId, callId])).digest("hex")}`;
function fixture(kind = "windows", extra = {}) {
  const assistantId = randomUUID(), questionId = randomUUID(), callId = randomUUID();
  const photo = kind === "windows" ? {type: "media", version: 1, kind, windowIds: [randomUUID()], purpose: "selection"} : {type: "media", version: 1, kind, suggestedTitle: "Study window"};
  const question = {type: "question", version: 1, invocationId: questionId, question: "Which window photo would you like to use?", answers: ["Study window"], ...extra};
  const message = {id: assistantId, requestId: randomUUID(), role: "assistant", status: "complete", sequence: 0, partsJson: JSON.stringify([photo, question]), createdAt: new Date(), completedAt: new Date(), error: null};
  const tools = [
    {id: questionId, assistantId, providerCallId: callId, name: "ask_question", status: "complete", argumentsJson: JSON.stringify(question)},
    {id: randomUUID(), assistantId, providerCallId: childCallId(assistantId, callId), name: kind === "windows" ? "show_windows" : "request_photo", status: "complete", argumentsJson: JSON.stringify(photo)},
  ];
  return {origin, messages: [message], voiceTranscripts: [], toolInvocations: tools, photo, question};
}
const source = (value) => ({origin: value.origin, messages: value.messages, voiceTranscripts: value.voiceTranscripts, toolInvocations: value.toolInvocations});

test("saved call ownership normalizes old photo picker questions on current, snapshot and earlier-history reads without rewriting storage", async (t) => {
  for (const kind of ["windows", "upload"]) await t.test(kind, async () => {
    const f = fixture(kind), id = randomUUID();
    await database.conversation.create({data: {id, shop: "hd-dev-single.myshopify.com", origin, credentialHash: randomUUID(), credentialExpiresAt: new Date(Date.now() + 60000), nextSequence: 1}});
    await database.conversationMessage.create({data: {...f.messages[0], conversationId: id}});
    await database.toolInvocation.createMany({data: f.toolInvocations.map((tool) => ({...tool, conversationId: id, completedAt: new Date()}))});
    const current = await repository.getCurrentContext(id);
    const snapshot = await repository.getSnapshot(id);
    const page = await repository.getHistoryPage(id, 1);
    assert.equal(current.current.pendingQuestion, null);
    assert.equal(snapshot.current.pendingQuestion, null);
    for (const message of [snapshot.messages[0], page.history.entries[0].message]) {
      assert.equal(message.parts.some((part) => part.type === "question"), false);
      assert.deepEqual(message.parts.filter((part) => part.type === "text"), [{type: "text", text: f.question.question}]);
      assert.deepEqual(message.parts.find((part) => part.type === "media"), f.photo);
    }
    assert.equal((await database.conversationMessage.findUnique({where: {id: f.messages[0].id}})).partsJson, f.messages[0].partsJson);
  });
});

test("unrelated photo ownership cannot retire a genuine pending question", async () => {
  const variations = [
    (f) => { f.toolInvocations[1].providerCallId = childCallId(f.messages[0].id, "different-provider-call"); },
    (f) => { f.toolInvocations[1].assistantId = randomUUID(); },
    (f) => { f.toolInvocations[0].id = randomUUID(); },
    (f) => { f.toolInvocations[1].status = "failed"; },
    (f) => { f.toolInvocations = []; },
  ];
  for (const change of variations) {
    const f = fixture(); change(f);
    const original = structuredClone(source(f));
    const timeline = repository.conversationTimeline(source(f));
    assert.deepEqual(repository.latestQuestion(timeline), f.question);
    assert.deepEqual(source(f), original);
  }
});

test("measurement, product and completed-preview questions retain their normal controls", async () => {
  const measurement = fixture("windows", {answers: [], measurement: {productPath: "/products/linen", label: "Width", unit: "cm", instructions: "Use the smallest of three recess widths."}});
  measurement.toolInvocations[0].name = "ask_measurement";
  assert.deepEqual(repository.latestQuestion(repository.conversationTimeline(source(measurement))), measurement.question);
  for (const part of [
    {type: "products", version: 1, invocationId: randomUUID(), productIds: ["gid://shopify/Product/123"]},
    {type: "media", version: 1, kind: "visualization", jobId: randomUUID(), customerIntent: true},
  ]) {
    const f = fixture(); f.messages[0].partsJson = JSON.stringify([part, f.question]);
    assert.deepEqual(repository.latestQuestion(repository.conversationTimeline(source(f))), f.question);
  }
});

test("a normalized voice photo picker keeps caption-owned words and its placement below the spoken reply", () => {
  const voiceId = randomUUID(), f = fixture("windows", {voiceReply: {voiceId, afterSequence: 1}});
  f.messages[0].role = "context";
  f.voiceTranscripts = [{id: randomUUID(), voiceId, sequence: 1, role: "assistant", text: f.question.question, startMs: 100, endMs: 800, createdAt: new Date()}];
  const original = structuredClone(source(f));
  const timeline = repository.conversationTimeline(source(f));
  assert.equal(repository.latestQuestion(timeline), undefined);
  assert.deepEqual(timeline.map((message) => message.parts.map((part) => part.type)), [["voice"], ["media"]]);
  assert.equal(timeline[0].parts[0].text, f.question.question);
  assert.deepEqual(timeline[1].parts[0].voiceReply, f.question.voiceReply);
  assert.deepEqual(source(f), original);
});

test("photo voice associations validate their bounded display provenance without becoming tool arguments", () => {
  const association = {voiceId: randomUUID(), afterSequence: 2};
  for (const kind of ["windows", "upload"]) {
    const part = {...fixture(kind).photo, voiceReply: association};
    assert.equal(repository.isMediaPart(part), true);
    assert.equal(repository.isMediaPart({...part, voiceReply: {...association, afterSequence: -1}}), false);
    assert.equal(repository.isMediaPart({...part, voiceReply: {...association, permission: true}}), false);
  }
});
