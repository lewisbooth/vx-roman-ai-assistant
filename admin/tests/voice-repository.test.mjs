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
  entryPoints: ["admin/voice/repository.server.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
const projectionBundle = await build({
  entryPoints: ["shared/voice-transcript.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
let directory;
let database;
let repository;
let conversationId;
let clock = Date.now();
const previousGlobal = global.prismaGlobal;
const clientId = randomUUID();
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
}

function load(source = bundle) {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "Date",
    source.outputFiles[0].text,
  )(require, module, module.exports, Clock);
  return module.exports;
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-voice-"));
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
});

beforeEach(async () => {
  await database.conversation.deleteMany();
  clock = Date.now();
  repository = load();
  conversationId = randomUUID();
  await database.conversation.create({
    data: {
      id: conversationId,
      shop: "hd-dev-single.myshopify.com",
      origin: "https://hd-dev-single.myshopify.com",
      credentialHash: randomUUID(),
      credentialExpiresAt: new Date(clock + 86400000),
    },
  });
});

after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});

async function reserve(voiceId = randomUUID(), owner = clientId) {
  return repository.reserveVoiceSession(conversationId, {
    voiceId,
    clientId: owner,
  });
}
function caption(overrides = {}) {
  return {
    providerEventId: randomUUID(),
    role: "user",
    text: "A sunny room.",
    startMs: 100,
    endMs: 300,
    ...overrides,
  };
}
async function append(voiceId, overrides = {}) {
  return repository.appendVoiceTranscript(
    conversationId,
    voiceId,
    caption(overrides),
  );
}
async function storedConversation() {
  return database.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
}

test("voice reservations are scoped, bounded, and idempotent without reconnecting", async () => {
  const voiceId = randomUUID();
  const first = await reserve(voiceId);
  assert.equal(first.created, true);
  assert.equal(first.session.status, "starting");
  assert.equal(first.session.leaseExpiresAt.getTime(), clock + 45000);
  assert.deepEqual(await reserve(voiceId), {
    session: first.session,
    created: false,
  });
  await assert.rejects(reserve(voiceId, randomUUID()), { status: 409 });
  await assert.rejects(reserve(), { status: 409 });
  assert.equal((await storedConversation()).revision, 1);
  await repository.closeVoiceSession(conversationId, voiceId, clientId);
  assert.equal((await reserve(voiceId)).created, false);
  assert.equal((await reserve(voiceId)).session.status, "closed");
  for (let count = 1; count < 10; count++) {
    clock++;
    const { session } = await reserve();
    await repository.closeVoiceSession(conversationId, session.id, clientId);
  }
  await assert.rejects(reserve(), { status: 429 });
});

test("voice cannot overlap a text reply or start after the chat ends", async () => {
  await database.conversation.update({
    where: { id: conversationId },
    data: { pendingRequestId: randomUUID() },
  });
  await assert.rejects(reserve(), { status: 409 });
  await database.conversation.update({
    where: { id: conversationId },
    data: { pendingRequestId: null, status: "ended" },
  });
  await assert.rejects(reserve(), { status: 409 });
  assert.equal(await database.voiceSession.count(), 0);
});

test("simultaneous reservations create only one active voice connection", async () => {
  const results = await Promise.allSettled([reserve(), reserve()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.status,
    409,
  );
  assert.equal(await database.voiceSession.count(), 1);
});

test("the database prevents a second active session even outside the repository", async () => {
  await reserve();
  await assert.rejects(
    database.voiceSession.create({
      data: {
        id: randomUUID(),
        conversationId,
        clientId,
        status: "active",
        leaseExpiresAt: new Date(clock + 45000),
      },
    }),
    { code: "P2002" },
  );
});

test("cancel before start persists a terminal request and prevents late provider reservation", async () => {
  const voiceId = randomUUID();
  const cancelled = await repository.cancelVoiceSession(
    conversationId,
    voiceId,
    clientId,
  );
  assert.equal(cancelled.status, "closed");
  assert.equal(cancelled.providerId, null);
  assert.equal(cancelled.closedAt.getTime(), clock);
  assert.deepEqual(
    await repository.cancelVoiceSession(conversationId, voiceId, clientId),
    cancelled,
  );
  assert.deepEqual(await reserve(voiceId), {
    session: cancelled,
    created: false,
  });
  assert.equal((await storedConversation()).revision, 1);
  assert.equal(await database.voiceSession.count(), 1);
  await assert.rejects(
    repository.activateVoiceSession(
      conversationId,
      voiceId,
      clientId,
      "provider_1",
    ),
    { status: 409 },
  );
});

test("concurrent start and cancel converge on one closed session in either order", async () => {
  for (const cancelFirst of [false, true]) {
    const voiceId = randomUUID();
    const start = () => reserve(voiceId);
    const cancel = () =>
      repository.cancelVoiceSession(conversationId, voiceId, clientId);
    await Promise.all(cancelFirst ? [cancel(), start()] : [start(), cancel()]);
    const row = await database.voiceSession.findUniqueOrThrow({
      where: { id: voiceId },
    });
    assert.equal(row.status, "closed");
    assert.equal(row.providerId, null);
    assert.equal((await reserve(voiceId)).created, false);
  }
  assert.equal(await database.voiceSession.count(), 2);
});

test("cancellation is scoped and tombstones cannot hide another active session", async () => {
  const { session } = await reserve();
  await assert.rejects(
    repository.cancelVoiceSession(conversationId, session.id, randomUUID()),
    { status: 404 },
  );
  await assert.rejects(
    repository.cancelVoiceSession(randomUUID(), session.id, clientId),
    { status: 404 },
  );
  clock++;
  await repository.cancelVoiceSession(conversationId, randomUUID(), clientId);
  assert.equal((await repository.getVoiceState(conversationId)).id, session.id);
  assert.equal(
    (await repository.getVoiceState(conversationId)).status,
    "starting",
  );
  await assert.rejects(reserve(), { status: 409 });
});

test("cancel tombstones respect the shared connection bound", async () => {
  for (let index = 0; index < 10; index++)
    await repository.cancelVoiceSession(conversationId, randomUUID(), clientId);
  const blockedRequestId = randomUUID();
  assert.equal(
    await repository.cancelVoiceSession(
      conversationId,
      blockedRequestId,
      clientId,
    ),
    null,
  );
  assert.equal(
    await repository.cancelVoiceSession(
      conversationId,
      blockedRequestId,
      clientId,
    ),
    null,
  );
  await assert.rejects(reserve(blockedRequestId), { status: 429 });
  await assert.rejects(reserve(), { status: 429 });
  assert.equal(await database.voiceSession.count(), 10);
});

test("ending chat permits existing voice cancellation but rejects unknown new tombstones", async () => {
  const { session } = await reserve();
  await database.conversation.update({
    where: { id: conversationId },
    data: { status: "ended" },
  });
  assert.equal(
    (await repository.cancelVoiceSession(conversationId, session.id, clientId))
      .status,
    "closed",
  );
  await assert.rejects(
    repository.cancelVoiceSession(conversationId, randomUUID(), clientId),
    { status: 409 },
  );
  assert.equal(await database.voiceSession.count(), 1);
});

test("provider activation and browser heartbeat retain exact ownership", async () => {
  const { session } = await reserve();
  for (const wrong of [randomUUID(), "invalid"]) {
    await assert.rejects(
      repository.activateVoiceSession(
        conversationId,
        session.id,
        wrong,
        "provider_1",
      ),
    );
    await assert.rejects(
      repository.heartbeatVoiceSession(conversationId, session.id, wrong),
    );
    await assert.rejects(
      repository.closeVoiceSession(conversationId, session.id, wrong),
    );
  }
  await assert.rejects(
    repository.activateVoiceSession(
      randomUUID(),
      session.id,
      clientId,
      "provider_1",
    ),
    { status: 404 },
  );
  const active = await repository.activateVoiceSession(
    conversationId,
    session.id,
    clientId,
    "provider_1",
  );
  assert.equal(active.status, "active");
  assert.equal(active.providerId, "provider_1");
  assert.deepEqual(
    await repository.activateVoiceSession(
      conversationId,
      session.id,
      clientId,
      "provider_1",
    ),
    active,
  );
  await assert.rejects(
    repository.activateVoiceSession(
      conversationId,
      session.id,
      clientId,
      "provider_2",
    ),
    { status: 409 },
  );
  clock += 20000;
  const renewed = await repository.heartbeatVoiceSession(
    conversationId,
    session.id,
    clientId,
  );
  assert.equal(renewed.leaseExpiresAt.getTime(), clock + 45000);
  assert.equal((await storedConversation()).revision, 2);
});

test("an expired heartbeat cannot revive voice, and terminal failure remains visible", async () => {
  const { session } = await reserve();
  clock += 45000;
  await assert.rejects(
    repository.heartbeatVoiceSession(conversationId, session.id, clientId),
    { status: 409 },
  );
  const ended = await repository.getVoiceState(conversationId);
  assert.equal(ended.status, "failed");
  assert.equal(ended.closedAt.getTime(), clock);
  assert.match(ended.error, /disconnected/);
  assert.equal((await storedConversation()).revision, 2);
  assert.equal((await reserve(session.id)).session.status, "failed");
  clock++;
  assert.equal((await reserve()).created, true);
});

test("heartbeats stop at the ten-minute session deadline", async () => {
  const start = clock;
  const { session } = await reserve();
  for (let tick = 1; tick <= 29; tick++) {
    clock = start + tick * 20000;
    await repository.heartbeatVoiceSession(
      conversationId,
      session.id,
      clientId,
    );
  }
  assert.equal(
    (await repository.getVoiceState(conversationId)).leaseExpiresAt.getTime(),
    start + 600000,
  );
  clock = start + 600000;
  await assert.rejects(
    repository.heartbeatVoiceSession(conversationId, session.id, clientId),
    { status: 409 },
  );
  assert.equal(
    (await repository.getVoiceState(conversationId)).status,
    "failed",
  );
});

test("server restart abandons its prior connection without erasing transcript or replaying start", async () => {
  const { session } = await reserve();
  const recorded = await append(session.id);
  clock++;
  const restarted = load();
  assert.equal(
    (await restarted.getVoiceState(conversationId)).status,
    "failed",
  );
  assert.deepEqual(await restarted.listVoiceTranscripts(conversationId), [
    recorded,
  ]);
  assert.equal(
    (
      await restarted.reserveVoiceSession(conversationId, {
        voiceId: session.id,
        clientId,
      })
    ).created,
    false,
  );
});

test("exact captions deduplicate once and share the conversation's global sequence", async () => {
  await database.conversation.update({
    where: { id: conversationId },
    data: { nextSequence: 7 },
  });
  const { session } = await reserve();
  const input = caption({ text: "  Exact provider text. " });
  const first = await repository.appendVoiceTranscript(
    conversationId,
    session.id,
    input,
  );
  assert.equal(first.sequence, 7);
  assert.equal(first.text, input.text);
  assert.equal(first.providerEventId, input.providerEventId);
  assert.deepEqual(
    await repository.appendVoiceTranscript(conversationId, session.id, input),
    first,
  );
  assert.equal((await storedConversation()).nextSequence, 8);
  assert.equal((await storedConversation()).revision, 2);
  await assert.rejects(
    repository.appendVoiceTranscript(conversationId, session.id, {
      ...input,
      text: "Changed",
    }),
    { status: 409 },
  );
  await database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId,
      requestId: randomUUID(),
      sequence: 8,
      role: "context",
      status: "complete",
      partsJson: "[]",
    },
  });
  await database.conversation.update({
    where: { id: conversationId },
    data: { nextSequence: 9 },
  });
  const second = await append(session.id, { role: "assistant" });
  assert.equal(second.sequence, 9);
  assert.deepEqual(await repository.listVoiceTranscripts(conversationId), [
    first,
    second,
  ]);
  assert.deepEqual(await repository.listVoiceTranscripts(randomUUID()), []);
});

test("close is terminal and idempotent; neither late captions nor a late activation can revive it", async () => {
  const { session } = await reserve();
  const input = caption();
  await repository.appendVoiceTranscript(conversationId, session.id, input);
  const closed = await repository.closeVoiceSession(
    conversationId,
    session.id,
    clientId,
  );
  assert.deepEqual(
    await repository.closeVoiceSession(conversationId, session.id, clientId, {
      status: "failed",
      error: "late failure",
    }),
    closed,
  );
  await assert.rejects(
    repository.appendVoiceTranscript(conversationId, session.id, input),
    { status: 409 },
  );
  await assert.rejects(
    repository.activateVoiceSession(
      conversationId,
      session.id,
      clientId,
      "provider_1",
    ),
    { status: 409 },
  );
  assert.equal(await database.voiceTranscript.count(), 1);
  assert.equal((await storedConversation()).revision, 3);
});

test("ended conversations and another conversation's voice reject captions", async () => {
  const { session } = await reserve();
  await assert.rejects(
    repository.appendVoiceTranscript(randomUUID(), session.id, caption()),
    { status: 404 },
  );
  await database.conversation.update({
    where: { id: conversationId },
    data: { status: "ended" },
  });
  await assert.rejects(append(session.id), { status: 409 });
  await repository.closeVoiceSession(conversationId, session.id, clientId);
  assert.equal(await database.voiceTranscript.count(), 0);
});

test("caption validation rejects malformed or oversized provider payloads", async () => {
  const { session } = await reserve();
  for (const value of [
    null,
    [],
    {},
    caption({ extra: true }),
    caption({ text: "" }),
    caption({ text: "x".repeat(2001) }),
    caption({ role: "system" }),
    caption({ startMs: -1 }),
    caption({ startMs: NaN }),
    caption({ endMs: Infinity }),
    caption({ endMs: 99 }),
    caption({ endMs: 600001 }),
    caption({ providerEventId: " " }),
    caption({ providerEventId: "x".repeat(201) }),
  ]) {
    await assert.rejects(
      repository.appendVoiceTranscript(conversationId, session.id, value),
      { status: 400 },
    );
  }
  assert.equal(await database.voiceTranscript.count(), 0);
});

test("voice caption count is bounded without overwriting existing records", async () => {
  const { session } = await reserve();
  await database.voiceTranscript.createMany({
    data: Array.from({ length: 1200 }, (_, sequence) => ({
      id: randomUUID(),
      voiceId: session.id,
      conversationId,
      providerEventId: `caption_${sequence}`,
      sequence,
      role: "user",
      text: "a",
      startMs: 0,
      endMs: 1,
    })),
  });
  await database.conversation.update({
    where: { id: conversationId },
    data: { nextSequence: 1200 },
  });
  await assert.rejects(append(session.id), { status: 429 });
  assert.equal(await database.voiceTranscript.count(), 1200);
  assert.equal((await storedConversation()).nextSequence, 1200);
});

test("voice caption character limit bounds total payload independently of fragment count", async () => {
  const { session } = await reserve();
  for (let index = 0; index < 30; index++)
    await append(session.id, { text: "a".repeat(2000) });
  await assert.rejects(append(session.id), { status: 429 });
  assert.equal(await database.voiceTranscript.count(), 30);
});

test("caption limits apply across reconnects rather than resetting with each voice session", async () => {
  const { session } = await reserve();
  for (let index = 0; index < 30; index++)
    await append(session.id, { text: "a".repeat(2000) });
  await repository.closeVoiceSession(conversationId, session.id, clientId);
  clock++;
  const next = await reserve();
  await assert.rejects(append(next.session.id), { status: 429 });
  assert.equal(await database.voiceTranscript.count(), 30);
});

test("provider captions preserve whitespace and fractional timestamps exactly", async () => {
  const { session } = await reserve();
  const input = caption({ text: " ", startMs: 1.25, endMs: 2.75 });
  const stored = await repository.appendVoiceTranscript(
    conversationId,
    session.id,
    input,
  );
  assert.equal(stored.text, " ");
  assert.equal(stored.startMs, 1.25);
  assert.equal(stored.endMs, 2.75);
  assert.deepEqual(await repository.listVoiceTranscripts(conversationId), [
    stored,
  ]);
});

test("caption projection keeps exact fragments, stable IDs and conversational boundaries", () => {
  const { groupVoiceTranscript } = load(projectionBundle);
  const voiceId = randomUUID();
  const fragment = (sequence, overrides = {}) => ({
    id: `row-${sequence}`,
    voiceId,
    providerEventId: `event-${sequence}`,
    sequence,
    role: "user",
    text: "hello",
    startMs: sequence * 100,
    endMs: sequence * 100 + 200,
    createdAt: new Date().toISOString(),
    ...overrides,
  });
  const first = fragment(0, { text: "Hello " });
  const next = fragment(1, { text: "there" });
  const otherSpeaker = fragment(2, { role: "assistant" });
  const interruptedByJourney = fragment(4, { role: "assistant" });
  const differentSession = fragment(5, { voiceId: randomUUID() });
  const gap = fragment(6, {
    voiceId: differentSession.voiceId,
    startMs: 10000,
    endMs: 11000,
  });
  const input = [
    first,
    next,
    otherSpeaker,
    interruptedByJourney,
    differentSession,
    gap,
  ];
  const result = groupVoiceTranscript([...input].reverse());
  assert.equal(result.length, 5);
  assert.equal(result[0].id, first.id);
  assert.equal(result[0].text, "Hello there");
  assert.deepEqual(result[0].fragments, [first, next]);
  assert.equal(first.text, "Hello ");
  assert.equal(next.text, "there");
  assert.equal(
    groupVoiceTranscript([
      fragment(0, { text: "black" }),
      fragment(1, { text: "out" }),
    ])[0].text,
    "blackout",
  );
  assert.equal(groupVoiceTranscript([first])[0].id, result[0].id);
  assert.equal(result[1].role, "assistant");
  assert.equal(result[2].sequence, 4);
});
