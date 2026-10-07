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
    export {isMediaPart, parsePhotoPresentation, MAX_GALLERY_PHOTOS} from './shared/visualizations.ts';`, resolveDir: process.cwd()},
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

test("reference photos preserve an owned clarification and its answer controls across text and voice projection", () => {
  for (const voice of [false, true]) {
    const association = {voiceId: randomUUID(), afterSequence: 1};
    const f = fixture("windows", {
      question: "Could the width and height labels have been swapped?",
      answers: ["My measurements are correct", "Swap width and height"],
      ...(voice ? {voiceReply: association} : {}),
    });
    f.photo.purpose = "reference";
    if (voice) {
      f.photo.voiceReply = association;
      f.messages[0].role = "context";
      f.voiceTranscripts = [{id: randomUUID(), voiceId: association.voiceId, sequence: 1, role: "assistant", text: f.question.question, startMs: 100, endMs: 800, createdAt: new Date()}];
    }
    f.messages[0].partsJson = JSON.stringify([f.photo, f.question]);
    const original = structuredClone(source(f));
    const timeline = repository.conversationTimeline(source(f));
    assert.deepEqual(repository.latestQuestion(timeline), f.question);
    assert.deepEqual(timeline.flatMap((message) => message.parts).find((part) => part.type === "media"), f.photo);
    assert.equal(timeline.flatMap((message) => message.parts).filter((part) => part.type === "question").length, 1);
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

test("upload picker snapshots accept empty and bounded distinct owned IDs only as persisted display data", () => {
  const part = fixture("upload").photo;
  assert.equal(repository.isMediaPart(part), true, "legacy history remains readable");
  for (const windowIds of [[], [randomUUID()], Array.from({length: repository.MAX_GALLERY_PHOTOS}, () => randomUUID())])
    assert.equal(repository.isMediaPart({...part, windowIds}), true);
  const repeated = randomUUID();
  for (const windowIds of [null, "not an array", ["invalid"], [repeated, repeated], Array.from({length: repository.MAX_GALLERY_PHOTOS + 1}, () => randomUUID())])
    assert.equal(repository.isMediaPart({...part, windowIds}), false);
  assert.throws(() => repository.parsePhotoPresentation({kind: "upload", suggestedTitle: null, windowIds: []}), /Invalid photo presentation/,
    "the model cannot supply or enlarge the server-owned Gallery snapshot");
});

test("preview display provenance accepts an exact request UUID without making it required in historical media", () => {
  const part = {type: "media", version: 1, kind: "visualization", jobId: randomUUID(), customerIntent: true};
  assert.equal(repository.isMediaPart(part), true);
  assert.equal(repository.isMediaPart({...part, continuationRequestId: randomUUID()}), true);
  for (const continuationRequestId of [null, "", "invalid", 123, {requestId: randomUUID()}])
    assert.equal(repository.isMediaPart({...part, continuationRequestId}), false);
  assert.equal(repository.isMediaPart({...fixture("upload").photo, continuationRequestId: randomUUID()}), false);
});

test("upload pickers persist their complete owner-scoped Gallery snapshot once, including an empty Gallery", async () => {
  const envKeys = ["ROMAN_VISUALIZATIONS_ENABLED", "ROMAN_VISUALIZATIONS_SHOPS", "OPENAI_API_KEY", "ROMAN_MEDIA_ROOT", "SHOPIFY_APP_URL"];
  const prior = envKeys.map((key) => process.env[key]);
  const shop = "hd-dev-single.myshopify.com";
  process.env.ROMAN_VISUALIZATIONS_ENABLED = "true";
  process.env.ROMAN_VISUALIZATIONS_SHOPS = shop;
  process.env.OPENAI_API_KEY = "synthetic-unused";
  process.env.ROMAN_MEDIA_ROOT = directory;
  process.env.SHOPIFY_APP_URL = "https://synthetic.example";
  const ownerId = randomUUID(), otherOwnerId = randomUUID();
  let id;
  try {
    id = (await repository.createConversation(shop, origin)).conversationId;
    await database.galleryOwner.createMany({data: [ownerId, otherOwnerId].map((owner) => ({id: owner, shop, origin, tokenHash: randomUUID()}))});
    await database.conversation.update({where: {id}, data: {galleryOwnerId: ownerId}});
    const finishPicker = async (callId) => {
      const turn = await repository.beginTurn(id, {requestId: randomUUID(), text: "Upload a photo."});
      const result = {status: "complete", text: "Choose an image.", photoPresentation: {callId, kind: "upload", suggestedTitle: null}};
      assert.equal(await repository.finishTurn(id, turn.assistantId, result), true);
      return {turn, result};
    };
    const empty = await finishPicker("empty-gallery");
    const readPart = async (assistantId) => JSON.parse((await database.conversationMessage.findUniqueOrThrow({where: {id: assistantId}})).partsJson).find((part) => part.type === "media");
    assert.deepEqual((await readPart(empty.turn.assistantId)).windowIds, []);
    const photos = Array.from({length: repository.MAX_GALLERY_PHOTOS}, (_, index) => ({
      id: randomUUID(), ownerId, conversationId: id, requestId: randomUUID(), requestHash: "synthetic",
      title: `Image ${index}`, assetKey: `synthetic-${index}.jpg`, sha256: "synthetic", width: 1000, height: 800, bytes: 100,
      consentVersion: "roman-window-photo-v1", consentAt: new Date(), uploadStatus: "ready", createdAt: new Date(1_700_000_000_000 + index),
    }));
    await database.windowPhoto.createMany({data: [
      ...photos,
      {...photos[0], id: randomUUID(), requestId: randomUUID(), deletedAt: new Date()},
      {...photos[0], id: randomUUID(), requestId: randomUUID(), uploadStatus: "saving"},
      {...photos[0], id: randomUUID(), requestId: randomUUID(), ownerId: otherOwnerId},
    ]});
    const populated = await finishPicker("full-gallery");
    const saved = await readPart(populated.turn.assistantId);
    assert.deepEqual(saved.windowIds, photos.map(({id}) => id).reverse(), "all ready owned photos, including beyond the first Gallery page");
    await database.windowPhoto.create({data: {...photos[0], id: randomUUID(), requestId: randomUUID(), createdAt: new Date()}});
    assert.equal(await repository.finishTurn(id, populated.turn.assistantId, populated.result), false, "completion replay cannot change its snapshot");
    const snapshot = await repository.getSnapshot(id);
    const page = await repository.getHistoryPage(id, snapshot.history.end);
    for (const messages of [snapshot.messages, page.history.entries.map(({message}) => message)]) {
      assert.deepEqual(messages.find((message) => message.id === empty.turn.assistantId).parts.find((part) => part.type === "media").windowIds, []);
      assert.deepEqual(messages.find((message) => message.id === populated.turn.assistantId).parts.find((part) => part.type === "media").windowIds, saved.windowIds);
    }
    assert.deepEqual(await readPart(populated.turn.assistantId), saved);
  } finally {
    if (id) await database.conversation.update({where: {id}, data: {galleryOwnerId: null, selectedWindowPhotoId: null}});
    await database.windowPhoto.deleteMany({where: {ownerId: {in: [ownerId, otherOwnerId]}}});
    await database.galleryOwner.deleteMany({where: {id: {in: [ownerId, otherOwnerId]}}});
    envKeys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
  }
});
