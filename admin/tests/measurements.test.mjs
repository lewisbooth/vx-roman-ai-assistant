import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  stdin: {
    contents: `export * from "./admin/measurements/service.server.ts";
      export * from "./shared/measurements.ts";
      export * from "./shared/product-path.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
let directory;
let database;
let api;
const previousGlobal = global.prismaGlobal;
const input = {
  productPath: "/products/lottie-mojito-roman-blind",
  width: 123.45,
  height: 234.56,
  unit: "cm",
  kind: "window",
  mount: "unknown",
};

function load() {
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-measurements-"));
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
  api = load();
});

beforeEach(async () => {
  await database.conversation.deleteMany();
});

after(async () => {
  await database?.$disconnect();
  global.prismaGlobal = previousGlobal;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function conversation(shop = "hd-dev-single.myshopify.com") {
  const id = randomUUID();
  await database.conversation.create({
    data: {
      id,
      shop,
      origin: `https://${shop}`,
      credentialHash: randomUUID(),
      credentialExpiresAt: new Date(Date.now() + 86400000),
    },
  });
  return id;
}

async function assistant(id, role = "assistant") {
  const assistantId = randomUUID();
  const requestId = randomUUID();
  await database.conversation.update({
    where: { id },
    data: { pendingRequestId: requestId },
  });
  await database.conversationMessage.create({
    data: {
      id: assistantId,
      conversationId: id,
      requestId,
      sequence: 0,
      role,
      status: "pending",
    },
  });
  return assistantId;
}

const manual = (id, values = input, requestId = randomUUID()) =>
  api.executeManualMeasurementTool(id, requestId, "set_measurements", values);

test("strict measurement calls preserve fractions and require explicit meaning", () => {
  assert.deepEqual(api.parseMeasurementCall("set_measurements", input), {
    name: "set_measurements",
    arguments: input,
  });
  assert.deepEqual(
    api.measurementToolDefinitions[0].parameters.required,
    Object.keys(input),
  );
  for (const key of Object.keys(input)) {
    const incomplete = { ...input };
    delete incomplete[key];
    assert.throws(() =>
      api.parseMeasurementCall("set_measurements", incomplete),
    );
  }
  for (const values of [
    { width: 0 },
    { height: -1 },
    { width: NaN },
    { height: Infinity },
    { width: "123" },
    { width: Number.MAX_SAFE_INTEGER + 1 },
    { unit: "inch" },
    { kind: "assumed" },
    { mount: "inside" },
    { privateToken: "discard-me" },
  ])
    assert.throws(() =>
      api.parseMeasurementCall("set_measurements", { ...input, ...values }),
    );
});

test("canonical product scope rejects collection aliases, queries and encoded routes", () => {
  for (const productPath of [
    "/collections/roman/products/lottie",
    "/products/lottie?variant=1",
    "/products/lottie#size",
    "/products/lottie/",
    "/products/%2e%2e",
    "//example.com/products/lottie",
    "/products/a/b",
    "https://example.com/products/lottie",
    "/products/a\\b",
    "/products/a%252fb",
  ])
    assert.throws(() => api.parseProductPath(productPath));
  assert.throws(() =>
    api.parseMeasurementCall("get_measurements", {
      productPath: input.productPath,
      unit: "cm",
    }),
  );
  assert.throws(() =>
    api.parseMeasurementCall("apply_measurements", {
      productPath: input.productPath,
    }),
  );
});

test("result and apply projection reject unknown fields and bind order drafts to the product", () => {
  const draft = {
    ...input,
    kind: "order",
    updatedAt: "2026-09-16T12:00:00.000Z",
  };
  const result = { status: "saved", draft };
  assert.deepEqual(api.parseMeasurementToolResult(result), result);
  assert.throws(() =>
    api.parseMeasurementToolResult({ ...result, raw: "private" }),
  );
  assert.throws(() =>
    api.parseMeasurementToolResult({
      ...result,
      draft: { ...draft, token: "private" },
    }),
  );
  assert.throws(() =>
    api.parseMeasurementDraft({ ...draft, updatedAt: "yesterday" }),
  );
  assert.deepEqual(
    api.parseApplyMeasurementsCommand({
      productPath: input.productPath,
      draft,
    }),
    { productPath: input.productPath, draft },
  );
  assert.throws(() =>
    api.parseApplyMeasurementsCommand({
      productPath: input.productPath,
      draft: { ...draft, kind: "window" },
    }),
  );
  assert.throws(() =>
    api.parseApplyMeasurementsCommand({
      productPath: "/products/another",
      draft,
    }),
  );
  const applied = {
    status: "applied",
    productPath: input.productPath,
    draftUpdatedAt: draft.updatedAt,
    message: "Dimensions filled. Review the product form.",
  };
  assert.deepEqual(api.parseApplyMeasurementsResult(applied), applied);
  const rejected = {
    ...applied,
    status: "invalid_measurements",
    message:
      "Drop 35 cm is below this product's minimum of 40 cm. No dimensions were entered.",
  };
  assert.deepEqual(api.parseApplyMeasurementsResult(rejected), rejected);
  assert.throws(() =>
    api.parseApplyMeasurementsResult({ ...applied, draftUpdatedAt: undefined }),
  );
  assert.throws(() =>
    api.parseApplyMeasurementsResult({ ...applied, cartToken: "private" }),
  );
});

test("manual saves are durable, retain exact units and never start a model turn", async () => {
  const id = await conversation();
  const saved = await manual(id, {
    ...input,
    width: 32.375,
    height: 50.125,
    unit: "in",
    mount: "exact",
  });
  assert.equal(saved.status, "saved");
  assert.equal(saved.draft.width, 32.375);
  assert.equal(saved.draft.height, 50.125);
  assert.equal(saved.draft.unit, "in");
  assert.equal(saved.draft.kind, "window");
  const restarted = load();
  assert.deepEqual(
    await restarted.getMeasurementDraft(id, input.productPath),
    saved.draft,
  );
  assert.deepEqual(Object.keys(saved.draft), [
    ...Object.keys(input),
    "updatedAt",
  ]);
  assert.equal(await database.conversationMessage.count(), 0);
  assert.equal(await database.toolInvocation.count(), 0);
  const row = await database.conversation.findUnique({ where: { id } });
  assert.equal(row.turnCount, 0);
  assert.equal(row.pendingRequestId, null);
  assert.equal(row.revision, 1);
});

test("same product drafts are isolated across conversations and shops", async () => {
  const first = await conversation();
  const second = await conversation();
  const otherShop = await conversation("hd-dev-multi.myshopify.com");
  await manual(first);
  assert.equal(await api.getMeasurementDraft(second, input.productPath), null);
  assert.equal(
    await api.getMeasurementDraft(otherShop, input.productPath),
    null,
  );
  assert.deepEqual(
    await api.executeManualMeasurementTool(
      second,
      randomUUID(),
      "get_measurements",
      { productPath: input.productPath },
    ),
    { status: "not_found", productPath: input.productPath },
  );
  assert.equal(
    await database.measurementWriteReceipt.count({
      where: { conversationId: second },
    }),
    0,
  );
});

test("a retried old manual request returns its original receipt without overwriting a newer draft", async () => {
  const id = await conversation();
  const requestId = randomUUID();
  const original = await manual(id, input, requestId);
  const newer = await manual(id, { ...input, width: 150 });
  assert.ok(
    Date.parse(newer.draft.updatedAt) > Date.parse(original.draft.updatedAt),
  );
  assert.deepEqual(await manual(id, input, requestId), original);
  assert.deepEqual(
    await api.getMeasurementDraft(id, input.productPath),
    newer.draft,
  );
  assert.equal(await database.measurementWriteReceipt.count(), 2);
  assert.equal(
    (await database.conversation.findUnique({ where: { id } })).revision,
    2,
  );
  await assert.rejects(manual(id, { ...input, width: 200 }, requestId), {
    status: 400,
  });
});

test("draft count is bounded at 20 while existing products remain editable", async () => {
  const id = await conversation();
  for (let index = 0; index < 20; index++)
    await manual(id, { ...input, productPath: `/products/blind-${index}` });
  await assert.rejects(manual(id), { status: 429 });
  await manual(id, { ...input, productPath: "/products/blind-0", width: 99 });
  assert.equal(await database.measurementDraft.count(), 20);
  assert.equal(await database.measurementWriteReceipt.count(), 21);
});

test("manual receipt storage has a bound and existing receipts remain replayable", async () => {
  const id = await conversation();
  const requestId = randomUUID();
  const saved = await manual(id, input, requestId);
  await database.measurementWriteReceipt.createMany({
    data: Array.from({ length: 199 }, () => ({
      conversationId: id,
      requestId: randomUUID(),
      argumentsJson: JSON.stringify(input),
      resultJson: JSON.stringify(saved),
    })),
  });
  await assert.rejects(manual(id), { status: 429 });
  assert.deepEqual(await manual(id, input, requestId), saved);
});

test("concurrent distinct saves preserve one draft and distinct approval versions", async () => {
  const id = await conversation();
  const results = await Promise.all([
    manual(id),
    manual(id, { ...input, width: 180 }),
  ]);
  assert.notEqual(results[0].draft.updatedAt, results[1].draft.updatedAt);
  assert.equal(await database.measurementDraft.count(), 1);
  assert.equal(await database.measurementWriteReceipt.count(), 2);
  assert.equal(
    (await database.conversation.findUnique({ where: { id } })).revision,
    2,
  );
});

test("model writes atomically persist a completed call and replay its exact outcome", async () => {
  const id = await conversation();
  const assistantId = await assistant(id);
  const result = await api.executeMeasurementTool(
    id,
    assistantId,
    "call-save",
    "set_measurements",
    input,
  );
  const tool = await database.toolInvocation.findFirst({
    where: { conversationId: id },
  });
  assert.equal(tool.status, "complete");
  assert.deepEqual(JSON.parse(tool.resultJson), result);
  assert.equal(tool.claimTokenHash, null);
  assert.equal(tool.confirmedAt, null);
  await manual(id, { ...input, width: 222 });
  assert.deepEqual(
    await api.executeMeasurementTool(
      id,
      assistantId,
      "call-save",
      "set_measurements",
      input,
    ),
    result,
  );
  assert.equal(
    (await api.getMeasurementDraft(id, input.productPath)).width,
    222,
  );
  assert.equal(await database.toolInvocation.count(), 1);
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "call-save",
      "set_measurements",
      { ...input, width: 999 },
    ),
    { status: 400 },
  );
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      randomUUID(),
      "call-save",
      "set_measurements",
      input,
    ),
    { status: 400 },
  );
});

test("model read tools record explicit missing data and support delegated context replies", async () => {
  const id = await conversation();
  const assistantId = await assistant(id, "context");
  const result = await api.executeMeasurementTool(
    id,
    assistantId,
    "call-read",
    "get_measurements",
    { productPath: input.productPath },
  );
  assert.deepEqual(result, {
    status: "not_found",
    productPath: input.productPath,
  });
  assert.equal(await database.measurementDraft.count(), 0);
  assert.equal(await database.toolInvocation.count(), 1);
  await manual(id);
  assert.deepEqual(
    await api.executeMeasurementTool(
      id,
      assistantId,
      "call-read",
      "get_measurements",
      { productPath: input.productPath },
    ),
    result,
  );
});

test("completed, foreign, cancelled and pre-restart replies cannot write new measurements", async () => {
  const id = await conversation();
  const other = await conversation();
  const assistantId = await assistant(id);
  await assert.rejects(
    api.executeMeasurementTool(
      other,
      assistantId,
      "foreign",
      "set_measurements",
      input,
    ),
    { status: 409 },
  );
  await database.conversationMessage.update({
    where: { id: assistantId },
    data: { status: "failed" },
  });
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "cancelled",
      "set_measurements",
      input,
    ),
    { status: 409 },
  );
  await database.conversationMessage.update({
    where: { id: assistantId },
    data: { status: "pending", createdAt: new Date(0) },
  });
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "orphaned",
      "set_measurements",
      input,
    ),
    { status: 409 },
  );
  await database.conversationMessage.update({
    where: { id: assistantId },
    data: { status: "complete", createdAt: new Date() },
  });
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "complete",
      "set_measurements",
      input,
    ),
    { status: 409 },
  );
  assert.equal(await database.measurementDraft.count(), 0);
  assert.equal(await database.toolInvocation.count(), 0);
});

test("End rejects later manual/model operations while retaining saved dimensions", async () => {
  const id = await conversation();
  const assistantId = await assistant(id);
  await manual(id);
  await database.conversation.update({
    where: { id },
    data: { status: "ended" },
  });
  await assert.rejects(manual(id), { status: 409 });
  await assert.rejects(api.getMeasurementDraft(id, input.productPath), {
    status: 409,
  });
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "late",
      "set_measurements",
      input,
    ),
    { status: 409 },
  );
  assert.equal(await database.measurementDraft.count(), 1);
  assert.equal(await database.measurementWriteReceipt.count(), 1);
});

test("a failed outcome insert rolls back the draft and revision together", async () => {
  const id = await conversation();
  const assistantId = await assistant(id);
  await database.$executeRawUnsafe(
    `CREATE TRIGGER reject_measurement_outcome BEFORE INSERT ON ToolInvocation BEGIN SELECT RAISE(ABORT, 'synthetic outcome failure'); END;`,
  );
  try {
    await assert.rejects(
      api.executeMeasurementTool(
        id,
        assistantId,
        "failure",
        "set_measurements",
        input,
      ),
    );
  } finally {
    await database.$executeRawUnsafe("DROP TRIGGER reject_measurement_outcome");
  }
  assert.equal(await database.measurementDraft.count(), 0);
  assert.equal(await database.toolInvocation.count(), 0);
  assert.equal(
    (await database.conversation.findUnique({ where: { id } })).revision,
    0,
  );
});

test("model action count is bounded and validation fails before writes", async () => {
  const id = await conversation();
  const assistantId = await assistant(id);
  for (let index = 0; index < 12; index++)
    await api.executeMeasurementTool(
      id,
      assistantId,
      `read-${index}`,
      "get_measurements",
      { productPath: input.productPath },
    );
  await assert.rejects(
    api.executeMeasurementTool(
      id,
      assistantId,
      "thirteenth",
      "set_measurements",
      input,
    ),
    { status: 429 },
  );
  await assert.rejects(manual(id, { ...input, width: -1 }), { status: 400 });
  await assert.rejects(manual(id, input, "invalid-request"), { status: 400 });
  await assert.rejects(
    api.executeMeasurementTool(id, assistantId, "", "set_measurements", input),
    { status: 400 },
  );
  await assert.rejects(manual(randomUUID()), { status: 404 });
  assert.equal(await database.measurementDraft.count(), 0);
  assert.equal(await database.measurementWriteReceipt.count(), 0);
});
