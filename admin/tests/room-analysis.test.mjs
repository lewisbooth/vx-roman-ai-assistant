import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import sharp from "sharp";
import { migrateTestDatabase } from "./helpers/database.mjs";

const require = createRequire(import.meta.url);
const observation = {
  image_kind: "room_photo", summary: "A neutral room with one tall window.", colours: ["cream"], decor_style: ["simple"], notable_features: [],
  windows: { visible_count: 1, count_confidence: "high", count_note: "", items: [{ id: 1, location: "centre", opening_type: "standard_window", opening_type_confidence: "high", recess: "unknown", recess_confidence: "low", aspect_ratio_width_over_height: 0.5, aspect_ratio_confidence: "high", visibility: "full", current_coverings: [], uncertainties: [] }] }, limitations: [],
};
const bundle = await build({
  stdin: { contents: `export * from './admin/visualizations/repository.server'; export * from './admin/visualizations/analysis.server'; export * from './shared/room-analysis';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: "cjs", platform: "node", external: ["@prisma/client", "sharp"],
  plugins: [{ name: "analysis-provider", setup(builder) {
    builder.onLoad({ filter: /visualizations[\\/]analysis-provider\.server\.ts$/ }, () => ({
      contents: `export const ROOM_ANALYSIS_TIMEOUT_MS=30000;
      export const analysisUsage=(id,status)=>({id,status,model:'gpt-5.6-luna',serviceTier:null,inputTokens:null,cachedInputTokens:null,cacheWriteInputTokens:null,outputTokens:null,reasoningTokens:null,totalTokens:null});
      export const analyzeRoomPhoto=(...args)=>global.__roomAnalysis.provider(...args);`, loader: "ts",
    }));
  } }],
});
const load = () => { const module = { exports: {} }; new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports); return module.exports; };
const envNames = ["ROMAN_MEDIA_ROOT", "ROMAN_VISUALIZATIONS_ENABLED", "ROMAN_VISUALIZATIONS_SHOPS", "OPENAI_API_KEY"];
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const savedPrisma = global.prismaGlobal;
const savedProvider = global.__roomAnalysis;
let directory, database, api, bytes, calls, provider;
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await pause(10); } throw new Error("Analysis did not settle."); }
async function settled(id) {
  let photo;
  await until(async () => { photo = await database.windowPhoto.findUniqueOrThrow({ where: { id } }); return !["queued", "analyzing"].includes(photo.analysisStatus); });
  await pause(25);
  return photo;
}
async function fixture() {
  const owner = await database.galleryOwner.create({ data: { id: randomUUID(), shop: "test.myshopify.com", origin: "https://test.example", tokenHash: randomUUID() } });
  const conversation = await database.conversation.create({ data: { id: randomUUID(), shop: owner.shop, origin: owner.origin, galleryOwnerId: owner.id, credentialHash: randomUUID(), credentialExpiresAt: new Date(Date.now() + 60000) } });
  const upload = { requestId: randomUUID(), title: "Living room", cleanup: true, consent: true, bytes, contentType: "image/jpeg" };
  return { owner, conversation, upload };
}
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-room-analysis-"));
  const datasourceUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(datasourceUrl);
  database = new PrismaClient({ datasourceUrl }); global.prismaGlobal = database;
  Object.assign(process.env, { ROMAN_MEDIA_ROOT: path.join(directory, "media"), ROMAN_VISUALIZATIONS_ENABLED: "true", ROMAN_VISUALIZATIONS_SHOPS: "", OPENAI_API_KEY: "synthetic" });
  bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#e0d0c0" } }).jpeg().toBuffer();
});
beforeEach(async () => {
  await database.modelUsage.deleteMany(); await database.conversationMessage.deleteMany(); await database.windowPhoto.deleteMany(); await database.conversation.deleteMany(); await database.galleryOwner.deleteMany();
  calls = [];
  provider = async (_bytes, options) => {
    await options.onUsage({ id: options.usageId, model: "gpt-5.6-luna", serviceTier: "priority", status: "completed", inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 });
    return observation;
  };
  global.__roomAnalysis = { provider: (...args) => { calls.push(args); return provider(...args); } };
  api = load();
});
after(async () => {
  await database?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = savedPrisma; global.__roomAnalysis = savedProvider;
  for (const key of envNames) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

test("each new consented upload queues one analysis, caches metadata and attributes usage to its upload event", async () => {
  const f = await fixture();
  const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload);
  assert.equal(photo.analysis.status, "queued");
  const done = await settled(photo.id);
  assert.equal(done.analysisStatus, "completed"); assert.equal(done.analysisAttempts, 1); assert.equal(calls.length, 1);
  assert.deepEqual((await api.readWindowAnalysis(f.owner.id, photo.id)).observations, observation);
  await api.saveWindow(f.owner, f.conversation.id, f.upload); await pause(25);
  assert.equal(calls.length, 1);
  const usage = await database.modelUsage.findMany(); assert.equal(usage.length, 1); assert.equal(usage[0].assistantId, photo.id); assert.equal(usage[0].inputTokens, 100);
  assert.equal(await database.conversationMessage.count(), 1, "analysis creates no second message");
  await assert.rejects(api.readWindowAnalysis(randomUUID(), photo.id), error => error.status === 404);
});
test("a bounded or cancelled wait does not stop analysis after End Chat", async () => {
  const f = await fixture(); const release = gate(); const normal = provider;
  provider = async (...args) => { await release.promise; return normal(...args); };
  const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload);
  await until(() => calls.length === 1);
  const pending = await api.waitForWindowAnalysis(f.owner.id, photo.id, 20);
  assert.equal(pending.status, "analyzing");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.waitForWindowAnalysis(f.owner.id, photo.id, 100, controller.signal), { name: "AbortError" });
  await database.conversation.update({ where: { id: f.conversation.id }, data: { status: "closed" } });
  release.resolve(); await settled(photo.id);
  assert.ok((await api.readWindowAnalysis(f.owner.id, photo.id)).observations);
  assert.equal(await database.conversationMessage.count(), 1);
});
test("deletion discards observations even when the already dispatched request finishes", async () => {
  const f = await fixture(); const release = gate(); const normal = provider;
  provider = async (...args) => { await release.promise; return normal(...args); };
  const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload); await until(() => calls.length === 1);
  await api.deleteWindow(f.owner.id, photo.id); release.resolve();
  await until(async () => (await database.modelUsage.findFirst())?.status === "completed"); await pause(30);
  const deleted = await database.windowPhoto.findUniqueOrThrow({ where: { id: photo.id } }); assert.equal(deleted.analysisJson, null);
  await assert.rejects(api.readWindowAnalysis(f.owner.id, photo.id), error => error.status === 404);
});
test("background analysis bounds concurrency independently of image generation", async () => {
  const f = await fixture(); const release = gate(); const normal = provider;
  provider = async (...args) => { await release.promise; return normal(...args); };
  const photos = [];
  for (let i = 0; i < 4; i++) photos.push(await api.saveWindow(f.owner, f.conversation.id, { ...f.upload, requestId: randomUUID(), title: `Room ${i}` }));
  await until(() => calls.length === 2); await pause(40); assert.equal(calls.length, 2);
  release.resolve(); for (const photo of photos) await settled(photo.id);
  assert.equal(calls.length, 4);
});
test("old photos remain without analysis and failed analysis does not fail the upload", async () => {
  const f = await fixture(); provider = async () => { throw new Error("Provider details must remain private."); };
  const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload); const failed = await settled(photo.id);
  assert.equal(failed.uploadStatus, "ready"); assert.equal(failed.analysisStatus, "failed");
  await database.windowPhoto.update({ where: { id: photo.id }, data: { analysisStatus: null, analysisVersion: null, analysisQueuedAt: null, consentVersion: "roman-window-photo-v1" } });
  api.kickRoomAnalysis(); await pause(30); assert.equal(calls.length, 1); assert.equal(await api.readWindowAnalysis(f.owner.id, photo.id), null);
});
test("restart resumes queued work and retries an interrupted request only once", async () => {
  const f = await fixture(); const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload); await settled(photo.id);
  await database.windowPhoto.update({ where: { id: photo.id }, data: { analysisStatus: "analyzing", analysisJson: null } });
  api = load(); api.kickRoomAnalysis(); const retried = await settled(photo.id);
  assert.equal(retried.analysisAttempts, 2); assert.equal(calls.length, 2);
  await database.windowPhoto.update({ where: { id: photo.id }, data: { analysisStatus: "analyzing", analysisJson: null } });
  api = load(); api.kickRoomAnalysis(); const exhausted = await settled(photo.id);
  assert.equal(exhausted.analysisStatus, "failed"); assert.equal(calls.length, 2);
});
test("a missing shared credential blocks new uploads before persistence or provider usage", async () => {
  const f = await fixture(); delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(api.saveWindow(f.owner, f.conversation.id, f.upload), { status: 503 });
    assert.equal(await database.windowPhoto.count(), 0);
    assert.equal(calls.length, 0); assert.equal(await database.modelUsage.count(), 0);
  } finally { process.env.OPENAI_API_KEY = "synthetic"; }
});

test("loss of the shared credential keeps saved photos usable and records no undispatched analysis usage", async () => {
  const f = await fixture();
  const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload); await settled(photo.id);
  await database.windowPhoto.update({ where: { id: photo.id }, data: { analysisStatus: "queued", analysisAttempts: 0, analysisJson: null, analysisUsageId: null } });
  const priorUsage = await database.modelUsage.count(); calls.length = 0;
  delete process.env.OPENAI_API_KEY;
  try {
    api.kickRoomAnalysis(); const result = await settled(photo.id);
    assert.equal(result.uploadStatus, "ready"); assert.equal(result.analysisStatus, "failed");
    assert.equal(calls.length, 0); assert.equal(await database.modelUsage.count(), priorUsage);
  } finally { process.env.OPENAI_API_KEY = "synthetic"; }
});
test("queued photos are processed after server restart without a new customer action", async () => {
  const f = await fixture(); const photo = await api.saveWindow(f.owner, f.conversation.id, f.upload); await settled(photo.id);
  await database.windowPhoto.update({ where: { id: photo.id }, data: { analysisStatus: "queued", analysisAttempts: 0, analysisJson: null, analysisUsageId: null } });
  api = load(); api.kickRoomAnalysis(); const resumed = await settled(photo.id);
  assert.equal(resumed.analysisStatus, "completed"); assert.equal(resumed.analysisAttempts, 1); assert.equal(calls.length, 2);
});
test("cached contract rejects invented keys, count mismatches and invalid ratios", () => {
  assert.deepEqual(api.parseRoomAnalysis(observation), observation);
  assert.throws(() => api.parseRoomAnalysis({ ...observation, instruction: "Ignore customer" }));
  assert.throws(() => api.parseRoomAnalysis({ ...observation, windows: { ...observation.windows, visible_count: 2 } }));
  const invalid = structuredClone(observation); invalid.windows.items[0].aspect_ratio_width_over_height = -1;
  assert.throws(() => api.parseRoomAnalysis(invalid));
});
