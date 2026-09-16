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
const queries = [];
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
    log: [{ emit: "event", level: "query" }],
  });
  database.$on("query", ({ query }) => queries.push(query));
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

test("healthy version probes do not write or read transcript contents at the caption bound", async () => {
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
      status: "active",
      leaseExpiresAt: new Date(Date.now() + 45_000),
    },
  });
  await database.conversationMessage.createMany({
    data: Array.from({ length: 20 }, (_, sequence) => ({
      id: randomUUID(),
      conversationId: id,
      requestId: randomUUID(),
      sequence,
      role: "assistant",
      status: "complete",
      partsJson: '[{"type":"text","text":"**Synthetic** reply."}]',
    })),
  });
  await database.voiceTranscript.createMany({
    data: Array.from({ length: 1100 }, (_, index) => ({
      id: randomUUID(),
      voiceId,
      conversationId: id,
      providerEventId: `fixture-${index}`,
      sequence: index + 20,
      role: "assistant",
      text: "Synthetic caption. ",
      startMs: index * 100,
      endMs: index * 100 + 90,
    })),
  });
  queries.length = 0;
  for (let index = 0; index < 20; index++)
    assert.equal(await repository.getReadRevision(id, true), 0);
  assert.equal(
    queries.length,
    60,
    "each read uses three bounded metadata selects",
  );
  assert.ok(queries.every((query) => /^SELECT\b/.test(query)));
  assert.ok(
    queries.every(
      (query) => !/VoiceTranscript|ToolInvocation|partsJson|"text"/.test(query),
    ),
  );
  queries.length = 0;
  await repository.failPending(id);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT\b/);
});

test("version probes recover stale replies and voices once, then remain read-only", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const started = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Hello",
  });
  const old = new Date(0);
  await database.conversationMessage.updateMany({
    where: { conversationId: id },
    data: { createdAt: old },
  });
  await database.voiceSession.create({
    data: {
      id: randomUUID(),
      conversationId: id,
      clientId: randomUUID(),
      createdAt: old,
      leaseExpiresAt: old,
    },
  });
  assert.equal(
    await repository.getReadRevision(id, true),
    started.snapshot.revision + 2,
  );
  const recovered = await repository.getSnapshot(id);
  assert.equal(recovered.busy, false);
  assert.equal(recovered.voice.status, "failed");
  assert.equal(recovered.messages[1].status, "failed");
  queries.length = 0;
  assert.equal(await repository.getReadRevision(id, true), recovered.revision);
  assert.ok(queries.every((query) => /^SELECT\b/.test(query)));
  await assert.rejects(repository.getReadRevision(randomUUID(), true), {
    status: 404,
  });
});

test("recovery advances the version without clearing a different current request", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const old = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Earlier question",
  });
  await database.conversationMessage.updateMany({
    where: { id: old.assistantId },
    data: { createdAt: new Date(0) },
  });
  const currentRequest = randomUUID();
  await database.conversation.update({
    where: { id },
    data: { pendingRequestId: currentRequest },
  });
  assert.equal(
    await repository.getReadRevision(id, true),
    old.snapshot.revision + 1,
  );
  assert.equal(
    (await database.conversation.findUnique({ where: { id } }))
      .pendingRequestId,
    currentRequest,
  );
  assert.equal((await repository.getSnapshot(id)).messages[1].status, "failed");
});

const cartFixture = {
  currency: "GBP",
  itemCount: 1,
  totalPriceMinorUnits: 1000,
  items: [
    {
      lineKey: "123:abc",
      title: "Configured shade",
      variantId: 123,
      quantity: 1,
      linePriceMinorUnits: 1000,
    },
  ],
};

async function cartInvocation(name = "clear_cart", args = {}, voice = false) {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const voiceId = voice ? randomUUID() : undefined;
  if (voiceId)
    await database.voiceSession.create({
      data: {
        id: voiceId,
        conversationId: id,
        clientId: randomUUID(),
        status: "active",
        leaseExpiresAt: new Date(Date.now() + 45000),
      },
    });
  const turn = await repository.beginTurn(
    id,
    {
      requestId: randomUUID(),
      text: voiceId ? "" : "Please change my cart.",
    },
    voiceId,
  );
  const tool = await repository.createToolInvocation(id, turn.assistantId, {
    providerCallId: randomUUID(),
    name,
    arguments: args,
  });
  return { id, turn, tool };
}

test("cart reads persist only sanitized results and remain available to future text and voice history", async () => {
  const { id, turn, tool } = await cartInvocation("get_cart");
  const claim = executor();
  await assert.rejects(
    repository.claimToolInvocation(id, tool.id, { ...claim, confirmed: true }),
    { status: 400 },
  );
  await repository.claimToolInvocation(id, tool.id, claim);
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome: { ...cartFixture, token: "PRIVATE_TOKEN" },
    }),
  );
  const result = { productIds: [], outcome: cartFixture };
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const before = await repository.getSnapshot(id);
  await repository.completeToolInvocation(id, tool.id, claim, result);
  assert.deepEqual(await repository.getSnapshot(id), before);
  await repository.finishTurn(id, turn.assistantId, {
    text: "",
    status: "failed",
  });
  const history = JSON.stringify(await repository.getModelHistory(id));
  assert.match(history, /Historical storefront action/);
  assert.match(history, /123:abc/);
  assert.doesNotMatch(history, /PRIVATE_TOKEN/);
  const stored = await database.toolInvocation.findUnique({
    where: { id: tool.id },
  });
  assert.deepEqual(JSON.parse(stored.resultJson), cartFixture);
  assert.equal(stored.confirmedAt, null);
});

test("cart removal, quantity and clearing require an invocation-specific shopper decision and decline is durable", async () => {
  for (const [name, args] of [
    ["remove_from_cart", { lineKey: "123:abc" }],
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 2 }],
    ["clear_cart", {}],
  ]) {
    const { id, tool } = await cartInvocation(name, args);
    const claim = executor();
    await assert.rejects(repository.claimToolInvocation(id, tool.id, claim), {
      status: 400,
    });
    await assert.rejects(
      repository.claimToolInvocation(id, tool.id, {
        ...claim,
        confirmed: "true",
      }),
      { status: 400 },
    );
    assert.equal(
      (await database.toolInvocation.findUnique({ where: { id: tool.id } }))
        .status,
      "pending",
    );
    const declined = await repository.claimToolInvocation(id, tool.id, {
      ...claim,
      confirmed: false,
    });
    assert.equal(declined.claimed, false);
    assert.equal(declined.outcome.status, "cancelled");
    const before = await repository.getSnapshot(id);
    assert.deepEqual(
      await repository.claimToolInvocation(id, tool.id, {
        ...claim,
        confirmed: false,
      }),
      declined,
    );
    assert.deepEqual(
      await repository.claimToolInvocation(id, tool.id, {
        ...claim,
        confirmed: true,
      }),
      { claimed: false },
    );
    assert.deepEqual(await repository.getSnapshot(id), before);
    assert.equal(
      (await database.toolInvocation.findUnique({ where: { id: tool.id } }))
        .confirmedAt,
      null,
    );
  }
});

test("cart additions need no approval but remain bound to their executor and uncertain outcomes never replay", async () => {
  const { id, turn, tool } = await cartInvocation("add_to_cart", {
    productPath: "/products/shade",
  });
  const claim = executor();
  for (const confirmed of [true, false])
    await assert.rejects(
      repository.claimToolInvocation(id, tool.id, { ...claim, confirmed }),
      { status: 400 },
    );
  await repository.claimToolInvocation(id, tool.id, claim);
  assert.equal(
    (await database.toolInvocation.findUnique({ where: { id: tool.id } }))
      .confirmedAt,
    null,
  );
  await assert.rejects(
    repository.claimToolInvocation(id, tool.id, { ...claim, confirmed: false }),
    { status: 400 },
  );
  assert.deepEqual(
    await repository.claimToolInvocation(id, tool.id, executor()),
    { claimed: false },
  );
  const result = {
    productIds: [],
    outcome: {
      status: "handed_off",
      message: "The theme may still complete this request.",
    },
  };
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, executor(), result),
    { status: 401 },
  );
  await repository.completeToolInvocation(id, tool.id, claim, result);
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const stored = await database.toolInvocation.findUnique({
    where: { id: tool.id },
  });
  assert.equal(stored.status, "failed");
  assert.equal(JSON.parse(stored.resultJson).status, "handed_off");
  await assert.rejects(
    repository.createToolInvocation(id, turn.assistantId, {
      providerCallId: stored.providerCallId,
      name: stored.name,
      arguments: JSON.parse(stored.argumentsJson),
    }),
    { status: 409 },
  );
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome: { status: "added", message: "Late result", quantityAdded: 1 },
    }),
    { status: 409 },
  );
});

test("confirmed additions persist once before the model reply, survive failure and reload, and retain actual dimensions", async () => {
  for (const voice of [false, true]) {
    const product = {
      productPath: "/en-gb/products/shade",
      title: "Configured shade",
      ...(voice
        ? {}
        : { measurements: { width: 18.125, height: 36.5, unit: "in" } }),
    };
    const { id, turn, tool } = await cartInvocation(
      "add_to_cart",
      { productPath: product.productPath },
      voice,
    );
    const claim = executor();
    await repository.claimToolInvocation(id, tool.id, claim);
    const before = await repository.getSnapshot(id);
    const result = {
      productIds: [],
      outcome: {
        status: "added",
        message: "The theme confirmed this addition.",
        addedProduct: product,
      },
    };
    await assert.rejects(
      repository.completeToolInvocation(id, tool.id, claim, {
        ...result,
        outcome: {
          ...result.outcome,
          addedProduct: { ...product, productPath: "/products/other" },
        },
      }),
      { status: 400 },
    );
    assert.deepEqual(await repository.getSnapshot(id), before);
    await repository.completeToolInvocation(id, tool.id, claim, result);
    const completed = await repository.getSnapshot(id);
    const notifications = completed.messages.filter((message) =>
      message.parts.some((part) => part.type === "cart_added"),
    );
    assert.equal(
      completed.busy,
      true,
      "the durable addition does not await the assistant reply",
    );
    assert.equal(completed.revision, before.revision + 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].role, "context");
    assert.equal(notifications[0].status, "complete");
    assert.deepEqual(notifications[0].parts, [
      { type: "cart_added", version: 1, invocationId: tool.id, product },
    ]);
    await repository.completeToolInvocation(id, tool.id, claim, result);
    assert.deepEqual(
      await repository.getSnapshot(id),
      completed,
      "a result retry cannot append another notification",
    );
    await repository.finishTurn(id, turn.assistantId, {
      text: "",
      status: "failed",
    });
    await repository.endConversation(id);
    const reloaded = await loadRepository().getSnapshot(id);
    assert.deepEqual(
      reloaded.messages.filter((message) =>
        message.parts.some((part) => part.type === "cart_added"),
      ),
      notifications,
    );
    const history = await repository.getModelHistory(id);
    const actionHistory = history.filter((message) =>
      message.text.includes("Historical storefront action"),
    );
    assert.equal(actionHistory.length, 1);
    assert.match(actionHistory[0].text, /"addedProduct"/);
    assert.equal(
      history.some((message) => message.text.includes('"type":"cart_added"')),
      false,
      "the display notification does not duplicate the action in model context",
    );
  }
});

test("confirmed sample additions persist as distinct notifications and bind the verified PDP", async () => {
  const sample = {
    productPath: "/products/shade",
    title: "BiFold Matte Black Venetian - 16mm Slat",
  };
  const { id, turn, tool } = await cartInvocation("add_sample_to_cart", {
    productPath: sample.productPath,
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const result = {
    productIds: [],
    outcome: {
      status: "added",
      message: "The theme confirmed the sample addition.",
      addedSample: sample,
    },
  };
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, {
      ...result,
      outcome: {
        ...result.outcome,
        addedSample: { ...sample, productPath: "/products/other" },
      },
    }),
    { status: 400 },
  );
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const completed = await repository.getSnapshot(id);
  const notifications = completed.messages.filter((message) =>
    message.parts.some((part) => part.type === "cart_sample_added"),
  );
  assert.deepEqual(notifications[0]?.parts, [
    { type: "cart_sample_added", version: 1, invocationId: tool.id, sample },
  ]);
  assert.equal(
    completed.messages.some((message) =>
      message.parts.some((part) => part.type === "cart_added"),
    ),
    false,
  );
  await repository.completeToolInvocation(id, tool.id, claim, result);
  assert.equal(
    (await repository.getSnapshot(id)).messages.filter((message) =>
      message.parts.some((part) => part.type === "cart_sample_added"),
    ).length,
    1,
  );
  await repository.finishTurn(id, turn.assistantId, {
    text: "",
    status: "failed",
  });
  const history = await repository.getModelHistory(id);
  assert.equal(
    history.some((message) =>
      message.text.includes('"type":"cart_sample_added"'),
    ),
    false,
  );
  assert.match(
    history.find((message) =>
      message.text.includes("Historical storefront action"),
    )?.text ?? "",
    /"addedSample"/,
  );
});

test("cart completion and its inline addition commit atomically", async () => {
  const { id, tool } = await cartInvocation("add_to_cart", {
    productPath: "/products/shade",
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const before = await repository.getSnapshot(id);
  const result = {
    productIds: [],
    outcome: {
      status: "added",
      message: "Added.",
      addedProduct: { productPath: "/products/shade", title: "Shade" },
    },
  };
  await database.$executeRawUnsafe(`CREATE TRIGGER reject_add_event BEFORE INSERT ON ConversationMessage
    WHEN NEW.role = 'context' BEGIN SELECT RAISE(ABORT, 'test event write failed'); END`);
  try {
    await assert.rejects(
      repository.completeToolInvocation(id, tool.id, claim, result),
    );
    assert.deepEqual(await repository.getSnapshot(id), before);
    const pending = await database.toolInvocation.findUnique({
      where: { id: tool.id },
    });
    assert.equal(pending.status, "running");
    assert.equal(pending.resultJson, null);
  } finally {
    await database.$executeRawUnsafe("DROP TRIGGER reject_add_event");
  }
  await repository.completeToolInvocation(id, tool.id, claim, result);
  assert.equal(
    (await repository.getSnapshot(id)).messages.filter((message) =>
      message.parts.some((part) => part.type === "cart_added"),
    ).length,
    1,
  );
});

test("unconfirmed outcomes and historical additions without metadata never fabricate inline additions", async () => {
  for (const status of [
    "handed_off",
    "uncertain",
    "cancelled",
    "needs_configuration",
    "added",
  ]) {
    const { id, tool } = await cartInvocation("add_to_cart", {
      productPath: "/products/shade",
    });
    const claim = executor();
    await repository.claimToolInvocation(id, tool.id, claim);
    await repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome: { status, message: "Theme outcome." },
    });
    const snapshot = await repository.getSnapshot(id);
    assert.equal(
      snapshot.messages.some((message) =>
        message.parts.some((part) => part.type === "cart_added"),
      ),
      false,
      status,
    );
  }
});

test("timeout, End and restart preserve claimed cart uncertainty and unclaimed cancellation", async () => {
  for (const name of ["clear_cart", "add_to_cart"])
    for (const cleanup of ["timeout", "end", "restart"])
      for (const claimed of [false, true]) {
        const { id, tool } = await cartInvocation(
          name,
          name === "add_to_cart" ? { productPath: "/products/shade" } : {},
        );
        if (claimed)
          await repository.claimToolInvocation(id, tool.id, {
            ...executor(),
            ...(name === "clear_cart" ? { confirmed: true } : {}),
          });
        if (cleanup === "timeout")
          await repository.failToolInvocation(id, tool.id, "Timed out.");
        if (cleanup === "end") await repository.endConversation(id);
        if (cleanup === "restart") {
          await database.conversationMessage.updateMany({
            where: { conversationId: id },
            data: { createdAt: new Date(0) },
          });
          await repository.failPending(id);
        }
        const stored = await database.toolInvocation.findUnique({
          where: { id: tool.id },
        });
        assert.equal(
          JSON.parse(stored.resultJson).status,
          claimed ? "uncertain" : "cancelled",
          `${name}/${cleanup}/${claimed}`,
        );
      }
});

test("measurement application uses an ordinary claim bound to the exact order draft and result fingerprint", async () => {
  const draft = {
    productPath: "/products/shade",
    width: 300,
    height: 400,
    unit: "mm",
    kind: "order",
    mount: "recess",
    updatedAt: new Date().toISOString(),
  };
  const { id, tool } = await cartInvocation("apply_measurements", {
    productPath: draft.productPath,
    draft,
  });
  const { updatedAt, ...values } = draft;
  await database.measurementDraft.create({
    data: { conversationId: id, ...values, updatedAt: new Date(updatedAt) },
  });
  const claim = executor();
  for (const confirmed of [true, false])
    await assert.rejects(
      repository.claimToolInvocation(id, tool.id, { ...claim, confirmed }),
      { status: 400 },
    );
  await database.measurementDraft.update({
    where: {
      conversationId_productPath: {
        conversationId: id,
        productPath: draft.productPath,
      },
    },
    data: { width: 350 },
  });
  await assert.rejects(repository.claimToolInvocation(id, tool.id, claim), {
    status: 409,
  });
  await database.measurementDraft.update({
    where: {
      conversationId_productPath: {
        conversationId: id,
        productPath: draft.productPath,
      },
    },
    data: { width: 300 },
  });
  assert.deepEqual(await repository.claimToolInvocation(id, tool.id, claim), {
    claimed: true,
  });
  assert.equal(
    (
      await database.toolInvocation.findUniqueOrThrow({
        where: { id: tool.id },
      })
    ).confirmedAt,
    null,
  );
  assert.deepEqual(await repository.claimToolInvocation(id, tool.id, claim), {
    claimed: true,
  });
  const outcome = {
    status: "applied",
    productPath: draft.productPath,
    draftUpdatedAt: updatedAt,
    message: "Exact dimensions were filled; review the form.",
  };
  await database.measurementDraft.update({
    where: {
      conversationId_productPath: {
        conversationId: id,
        productPath: draft.productPath,
      },
    },
    data: { updatedAt: new Date(Date.parse(updatedAt) + 1) },
  });
  await assert.rejects(repository.claimToolInvocation(id, tool.id, claim), {
    status: 409,
  });
  assert.deepEqual(
    await repository.claimToolInvocation(id, tool.id, executor()),
    { claimed: false },
  );
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome: { ...outcome, draftUpdatedAt: new Date(0).toISOString() },
    }),
    { status: 400 },
  );
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome,
  });
  const savedRevision = (await repository.getSnapshot(id)).revision;
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome,
  });
  assert.equal(
    (await repository.getSnapshot(id)).revision,
    savedRevision,
    "lost result responses retry without rechecking a later draft or repeating execution",
  );
  assert.deepEqual(
    JSON.parse(
      (await database.toolInvocation.findUnique({ where: { id: tool.id } }))
        .resultJson,
    ),
    outcome,
  );
});

test("interrupted measurement applications retain claim uncertainty without cart confirmation and never replay", async () => {
  for (const cleanup of ["timeout", "end", "restart", "browser-error"]) {
    for (const claimed of [false, true]) {
      if (cleanup === "browser-error" && !claimed) continue;
      const draft = {
        productPath: "/products/shade",
        width: 300,
        height: 300,
        unit: "mm",
        kind: "order",
        mount: "recess",
        updatedAt: new Date().toISOString(),
      };
      const { id, turn, tool } = await cartInvocation("apply_measurements", {
        productPath: draft.productPath,
        draft,
      });
      const { updatedAt, ...values } = draft;
      await database.measurementDraft.create({
        data: { conversationId: id, ...values, updatedAt: new Date(updatedAt) },
      });
      const claim = executor();
      if (claimed) await repository.claimToolInvocation(id, tool.id, claim);
      if (cleanup === "timeout")
        await repository.failToolInvocation(id, tool.id, "Timed out.");
      if (cleanup === "end") await repository.endConversation(id);
      if (cleanup === "restart") {
        await database.conversationMessage.updateMany({
          where: { conversationId: id },
          data: { createdAt: new Date(0) },
        });
        await repository.failPending(id);
      }
      if (cleanup === "browser-error")
        await repository.completeToolInvocation(id, tool.id, claim, {
          productIds: [],
          error: "The page disappeared before the result was returned.",
        });
      const stored = await database.toolInvocation.findUniqueOrThrow({
        where: { id: tool.id },
      });
      const outcome = JSON.parse(stored.resultJson);
      assert.equal(stored.confirmedAt, null);
      assert.equal(stored.status, "failed");
      assert.equal(
        outcome.status,
        claimed ? "uncertain" : "cancelled",
        `${cleanup}/${claimed}`,
      );
      assert.equal(outcome.productPath, draft.productPath);
      assert.equal(outcome.draftUpdatedAt, draft.updatedAt);
      if (!claimed) assert.match(outcome.message, /did not start/);
      if (cleanup !== "end")
        assert.deepEqual(
          await repository.claimToolInvocation(id, tool.id, claim),
          {
            claimed: false,
          },
        );
      await assert.rejects(
        repository.createToolInvocation(id, turn.assistantId, {
          providerCallId: stored.providerCallId,
          name: stored.name,
          arguments: JSON.parse(stored.argumentsJson),
        }),
        { status: 409 },
      );
      if (claimed)
        await assert.rejects(
          repository.completeToolInvocation(id, tool.id, claim, {
            productIds: [],
            outcome: {
              status: "applied",
              productPath: draft.productPath,
              draftUpdatedAt: updatedAt,
              message: "A late result must not overwrite uncertainty.",
            },
          }),
          { status: 409 },
        );
    }
  }
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
  assert.deepEqual(await repository.getBrowserToolContext(id, tool.id), {
    origin,
    name: input.name,
    arguments: input.arguments,
  });
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

test("catalog completion persists IDs idempotently without adding a recommendation widget", async () => {
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
  assert.deepEqual(state.messages[1].parts, [{ type: "text", text: "" }]);
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
  assert.equal(state.messages[1].parts.length, 1);
  assert.equal(state.messages[1].parts[0].text, "These are worth exploring.");
  assert.deepEqual(
    await repository.claimToolInvocation(id, tool.id, executor()),
    { claimed: false },
  );
  assert.equal(
    await database.toolInvocation.count({ where: { name: "show_products" } }),
    0,
  );
});

test("navigation persists a claimed storefront action without product evidence or automatic cards", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Take me to that blind.",
  });
  const input = {
    providerCallId: randomUUID(),
    name: "navigate",
    arguments: { path: "/products/dalmatians?variant=123#measurements" },
  };
  const tool = await repository.createToolInvocation(
    id,
    turn.assistantId,
    input,
  );
  assert.deepEqual(tool, {
    id: tool.id,
    name: input.name,
    arguments: input.arguments,
    status: "pending",
  });
  const reloaded = loadRepository();
  assert.deepEqual((await reloaded.getSnapshot(id)).tools, [tool]);
  assert.deepEqual(await reloaded.getBrowserToolContext(id, tool.id), {
    origin,
    name: input.name,
    arguments: input.arguments,
  });
  const claim = executor();
  assert.deepEqual(await repository.claimToolInvocation(id, tool.id, claim), {
    claimed: true,
  });
  const claimed = await repository.getSnapshot(id);
  assert.equal(claimed.tools[0].status, "running");
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, {
      productIds: ["gid://shopify/Product/123"],
    }),
    { status: 400 },
  );
  assert.deepEqual(await repository.getSnapshot(id), claimed);
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome: { status: "navigated", path: input.arguments.path },
  });
  const completed = await repository.getSnapshot(id);
  assert.deepEqual(completed.tools, []);
  assert.deepEqual(completed.messages[1].parts, [{ type: "text", text: "" }]);
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome: { status: "navigated", path: input.arguments.path },
  });
  assert.deepEqual(await repository.getSnapshot(id), completed);
  const persisted = await database.toolInvocation.findUniqueOrThrow({
    where: { id: tool.id },
  });
  assert.equal(persisted.name, "navigate");
  assert.equal(persisted.status, "complete");
  assert.deepEqual(JSON.parse(persisted.argumentsJson), input.arguments);
  assert.deepEqual(JSON.parse(persisted.productIdsJson), []);
  assert.deepEqual(completed.messages.at(-1).parts, [
    {
      type: "navigation",
      version: 1,
      invocationId: tool.id,
      path: "/products/dalmatians",
      title: "/products/dalmatians",
    },
  ]);
  assert.deepEqual(JSON.parse(persisted.resultJson), {
    status: "navigated",
    path: input.arguments.path,
  });
  await assert.rejects(
    repository.finishTurn(id, turn.assistantId, {
      text: "An ungrounded recommendation.",
      status: "complete",
      presentation: {
        callId: randomUUID(),
        productIds: ["gid://shopify/Product/123"],
      },
    }),
    { status: 400 },
  );
  await repository.finishTurn(id, turn.assistantId, {
    text: "You are now on the blind page.",
    status: "complete",
  });
  assert.deepEqual((await repository.getSnapshot(id)).messages[1].parts, [
    { type: "text", text: "You are now on the blind page." },
  ]);
});

test("confirmed navigation persists once before text or voice completion and retains private journey context", async () => {
  for (const voice of [false, true]) {
    const { id, turn, tool } = await cartInvocation(
      "navigate",
      { path: "/collections/all" },
      voice,
    );
    const claim = executor();
    await repository.appendJourney(id, {
      requestId: randomUUID(),
      title: "Manually viewed page",
      path: "/pages/measuring",
      occurredAt: new Date().toISOString(),
    });
    await repository.claimToolInvocation(id, tool.id, claim);
    const result = {
      productIds: [],
      outcome: {
        status: "navigated",
        path: "/search?q=roller#results",
        title: "<Roller> & Blinds",
      },
    };
    await repository.completeToolInvocation(id, tool.id, claim, result);
    const snapshot = await repository.getSnapshot(id);
    const events = snapshot.messages.filter((row) =>
      row.parts.some((part) => part.type === "navigation"),
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].parts, [
      {
        type: "navigation",
        version: 1,
        invocationId: tool.id,
        path: "/search",
        title: "<Roller> & Blinds",
      },
    ]);
    assert.equal(snapshot.busy, true);
    await repository.completeToolInvocation(id, tool.id, claim, result);
    assert.deepEqual(await repository.getSnapshot(id), snapshot);
    await repository.finishTurn(id, turn.assistantId, {
      status: "failed",
      text: "",
      error: "Provider failed after confirmed navigation.",
    });
    await repository.endConversation(id);
    const reloaded = await loadRepository().getSnapshot(id);
    assert.deepEqual(
      reloaded.messages.filter((row) =>
        row.parts.some((part) => part.type === "navigation"),
      ),
      events,
    );
    const history = JSON.stringify(await repository.getModelHistory(id));
    assert.match(history, /Manually viewed page/);
    assert.match(history, /navigation/);
    assert.doesNotMatch(history, /q=roller|#results/);
  }
});

test("navigation acknowledgements require a live owned claim and never fabricate failure or stale events", async () => {
  for (const scenario of [
    "wrong-owner",
    "unclaimed",
    "failed-result",
    "timeout",
    "cancelled",
    "ended",
  ]) {
    const { id, turn, tool } = await cartInvocation("navigate", {
      path: "/cart",
    });
    const claim = executor();
    if (scenario !== "unclaimed")
      await repository.claimToolInvocation(id, tool.id, claim);
    if (scenario === "timeout")
      await repository.failToolInvocation(id, tool.id, "Navigation timed out.");
    if (scenario === "cancelled")
      await repository.finishTurn(id, turn.assistantId, {
        status: "failed",
        text: "",
        error: "Cancelled.",
      });
    if (scenario === "ended") await repository.endConversation(id);
    const result =
      scenario === "failed-result"
        ? { productIds: [], error: "Page load unconfirmed." }
        : {
            productIds: [],
            outcome: { status: "navigated", path: "/cart", title: "Cart" },
          };
    const completion = repository.completeToolInvocation(
      id,
      tool.id,
      scenario === "wrong-owner" ? executor() : claim,
      result,
    );
    if (scenario === "failed-result") await completion;
    else await assert.rejects(completion);
    assert.equal(
      (await repository.getSnapshot(id)).messages.some((row) =>
        row.parts.some((part) => part.type === "navigation"),
      ),
      false,
      scenario,
    );
  }
});

test("navigation event persistence is atomic with the completed outcome", async () => {
  const { id, tool } = await cartInvocation("navigate", { path: "/cart" });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const before = await repository.getSnapshot(id);
  const result = {
    productIds: [],
    outcome: { status: "navigated", path: "/cart", title: "Cart" },
  };
  await database.$executeRawUnsafe(`CREATE TRIGGER reject_navigation_event BEFORE INSERT ON ConversationMessage
    WHEN NEW.role = 'context' BEGIN SELECT RAISE(ABORT, 'test event write failed'); END`);
  try {
    await assert.rejects(
      repository.completeToolInvocation(id, tool.id, claim, result),
    );
    assert.deepEqual(await repository.getSnapshot(id), before);
    const stored = await database.toolInvocation.findUniqueOrThrow({
      where: { id: tool.id },
    });
    assert.equal(stored.status, "running");
    assert.equal(stored.resultJson, null);
  } finally {
    await database.$executeRawUnsafe("DROP TRIGGER reject_navigation_event");
  }
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const after = await loadRepository().getSnapshot(id);
  assert.equal(
    after.messages.filter((row) =>
      row.parts.some((part) => part.type === "navigation"),
    ).length,
    1,
  );
});

test("navigation rejects external and malformed arguments before creating an invocation", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Open a page.",
  });
  const before = await repository.getSnapshot(id);
  for (const args of [
    { path: "https://other.example/products/blind" },
    { path: `${origin}/products/blind` },
    { path: "//other.example/products/blind" },
    { path: "/\\other.example/products/blind" },
    { path: "/products/\nblind" },
    { path: "javascript:alert(1)" },
    { path: "" },
    { path: `/${"x".repeat(2048)}` },
    { path: "/products/blind", extra: true },
    { path: 123 },
    {},
  ]) {
    await assert.rejects(
      repository.createToolInvocation(id, turn.assistantId, {
        providerCallId: randomUUID(),
        name: "navigate",
        arguments: args,
      }),
      { status: 400 },
    );
  }
  assert.deepEqual(await repository.getSnapshot(id), before);
  assert.equal(
    await database.toolInvocation.count({ where: { conversationId: id } }),
    0,
  );
});

async function completedCatalog(id, assistantId, productIds, overrides = {}) {
  const tool = await repository.createToolInvocation(id, assistantId, {
    providerCallId: randomUUID(),
    name: "search_products",
    arguments: { query: "blackout blinds" },
    ...overrides,
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  await repository.completeToolInvocation(id, tool.id, claim, { productIds });
  return tool;
}

test("a completed reply atomically presents one ordered subset of current-turn catalog matches", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show two plain blackout options.",
  });
  const productIds = [1, 2, 3].map(
    (number) => `gid://shopify/Product/${number}`,
  );
  await completedCatalog(id, turn.assistantId, productIds.slice(0, 2));
  await completedCatalog(id, turn.assistantId, productIds.slice(2), {
    name: "lookup_catalog",
    arguments: { ids: [productIds[2]] },
  });
  const before = await repository.getSnapshot(id);
  assert.deepEqual(before.messages[1].parts, [{ type: "text", text: "" }]);
  const presentation = {
    callId: randomUUID(),
    productIds: [productIds[2], productIds[0]],
  };
  const reply = {
    text: "These two meet your preference.",
    status: "complete",
    presentation,
  };
  await repository.finishTurn(id, turn.assistantId, reply);
  const state = await loadRepository().getSnapshot(id);
  assert.equal(state.busy, false);
  assert.equal(state.revision, before.revision + 1);
  assert.deepEqual(state.tools, []);
  const shown = await database.toolInvocation.findFirstOrThrow({
    where: { conversationId: id, name: "show_products" },
  });
  assert.equal(shown.assistantId, turn.assistantId);
  assert.equal(shown.providerCallId, presentation.callId);
  assert.equal(shown.status, "complete");
  assert.deepEqual(JSON.parse(shown.productIdsJson), presentation.productIds);
  assert.equal(shown.claimClientId, null);
  await assert.rejects(repository.getBrowserToolContext(id, shown.id), {
    status: 400,
  });
  assert.deepEqual(state.messages[1].parts, [
    { type: "text", text: reply.text },
    {
      type: "products",
      version: 1,
      invocationId: shown.id,
      productIds: presentation.productIds,
    },
  ]);
  await repository.finishTurn(id, turn.assistantId, reply);
  assert.deepEqual(await repository.getSnapshot(id), state);
  assert.equal(
    await database.toolInvocation.count({ where: { name: "show_products" } }),
    1,
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
        entry.text.includes(productIds[2]),
    ),
  );
});

test("questions persist after product and guide widgets, survive reload and keep short answers meaningful", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Suggest no-drill blinds.",
  });
  const productIds = ["gid://shopify/Product/123"];
  await completedCatalog(id, turn.assistantId, productIds);
  const source = await guideLookup(id, turn.assistantId);
  const questionPresentation = {
    callId: randomUUID(),
    question: "Is blackout your priority?",
    answers: ["Yes", "Daytime privacy"],
  };
  const result = {
    status: "complete",
    text: "These offer different levels of light control.",
    presentation: { callId: randomUUID(), productIds },
    guidePresentation: guidePresentation(source.sourceCallId),
    questionPresentation,
  };
  await repository.finishTurn(id, turn.assistantId, result);
  const state = await loadRepository().getSnapshot(id);
  assert.deepEqual(
    state.messages[1].parts.map((part) => part.type),
    ["text", "products", "guides", "question"],
  );
  const question = state.messages[1].parts.at(-1);
  const saved = await database.toolInvocation.findFirstOrThrow({
    where: { conversationId: id, name: "ask_question" },
  });
  assert.equal(saved.id, question.invocationId);
  assert.equal(saved.status, "complete");
  assert.equal(saved.claimClientId, null);
  assert.equal(saved.confirmedAt, null);
  await assert.rejects(repository.getBrowserToolContext(id, saved.id), {
    status: 400,
  });
  await repository.finishTurn(id, turn.assistantId, result);
  assert.deepEqual(await repository.getSnapshot(id), state);
  assert.equal(
    await database.toolInvocation.count({ where: { name: "ask_question" } }),
    1,
  );
  const next = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Yes",
  });
  assert.deepEqual(next.history.slice(-2), [
    {
      role: "assistant",
      text: 'Is blackout your priority?\nSuggested answers: ["Yes","Daytime privacy"]',
    },
    { role: "user", text: "Yes" },
  ]);
  assert.ok(
    next.history
      .filter((entry) => entry.text.startsWith("Untrusted"))
      .every((entry) => !entry.text.includes('"type":"question"')),
  );
  assert.deepEqual(
    (await repository.getSnapshot(id)).messages[1].parts.at(-1),
    question,
  );
});

test("question-only replies persist without fabricated text, and invalid questions roll back every presentation", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Help me choose.",
  });
  const productIds = ["gid://shopify/Product/123"];
  await completedCatalog(id, turn.assistantId, productIds);
  const questionPresentation = {
    callId: randomUUID(),
    question: "Which room?",
    answers: ["Bedroom", "Kitchen"],
  };
  for (const invalid of [
    { ...questionPresentation, callId: "" },
    { ...questionPresentation, answers: ["a", "A"] },
  ]) {
    await assert.rejects(
      repository.finishTurn(id, turn.assistantId, {
        text: "",
        status: "complete",
        presentation: { callId: randomUUID(), productIds },
        questionPresentation: invalid,
      }),
      { status: 400 },
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { name: { in: ["show_products", "ask_question"] } },
      }),
      0,
    );
    assert.equal((await repository.getSnapshot(id)).busy, true);
  }
  await repository.finishTurn(id, turn.assistantId, {
    text: "",
    status: "complete",
    questionPresentation,
  });
  const snapshot = await loadRepository().getSnapshot(id);
  assert.deepEqual(
    snapshot.messages[1].parts.map((part) => part.type),
    ["question"],
  );
  assert.equal((await repository.getModelHistory(id)).at(-1).role, "assistant");
  const corrupted = { ...snapshot.messages[1].parts[0], answers: ["a", "A"] };
  await database.conversationMessage.update({
    where: { id: turn.assistantId },
    data: { partsJson: JSON.stringify([corrupted]) },
  });
  await assert.rejects(repository.getSnapshot(id));
  await assert.rejects(repository.getModelHistory(id));
});

test("failed, cancelled and ended replies never persist questions", async () => {
  for (const mode of ["failed", "cancelled", "ended"]) {
    const { conversationId: id } = await repository.createConversation(
      shop,
      origin,
    );
    const turn = await repository.beginTurn(id, {
      requestId: randomUUID(),
      text: "Help me choose.",
    });
    if (mode === "ended") await repository.endConversation(id);
    if (mode === "cancelled")
      await repository.finishTurn(id, turn.assistantId, {
        status: "failed",
        text: "",
        error: "Cancelled.",
      });
    await repository.finishTurn(id, turn.assistantId, {
      status: mode === "failed" ? "failed" : "complete",
      text: "Late overview.",
      questionPresentation: {
        callId: randomUUID(),
        question: "Which room?",
        answers: ["Bedroom", "Kitchen"],
      },
    });
    assert.ok(
      (await repository.getSnapshot(id)).messages.every((message) =>
        message.parts.every((part) => part.type !== "question"),
      ),
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { conversationId: id, name: "ask_question" },
      }),
      0,
    );
  }
});

test("invalid or ungrounded presentations cannot partially complete a reply", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show recommendations.",
  });
  const available = Array.from(
    { length: 7 },
    (_, index) => `gid://shopify/Product/${index + 1}`,
  );
  await completedCatalog(id, turn.assistantId, available);
  const before = await repository.getSnapshot(id);
  for (const presentation of [
    { callId: randomUUID(), productIds: [] },
    { callId: randomUUID(), productIds: available },
    { callId: randomUUID(), productIds: [available[0], available[0]] },
    { callId: randomUUID(), productIds: ["gid://shopify/Product/999"] },
    { callId: randomUUID(), productIds: ["gid://shopify/ProductVariant/1"] },
    { callId: "", productIds: [available[0]] },
    { callId: "x".repeat(201), productIds: [available[0]] },
  ]) {
    await assert.rejects(
      repository.finishTurn(id, turn.assistantId, {
        text: "This must not persist.",
        status: "complete",
        presentation,
      }),
      { status: 400 },
    );
    assert.deepEqual(await repository.getSnapshot(id), before);
    assert.equal(
      await database.toolInvocation.count({ where: { name: "show_products" } }),
      0,
    );
  }
});

test("presentation grounding excludes previous turns, other conversations and unsuccessful lookups", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const first = await pendingLookup(id);
  const claim = executor();
  await repository.claimToolInvocation(id, first.tool.id, claim);
  await repository.completeToolInvocation(id, first.tool.id, claim, {
    productIds: ["gid://shopify/Product/1"],
  });
  await repository.finishTurn(id, first.turn.assistantId, {
    text: "A previous answer.",
    status: "complete",
  });
  const current = await pendingLookup(id);
  const { conversationId: otherId } = await repository.createConversation(
    shop,
    origin,
  );
  const other = await pendingLookup(otherId);
  await completedCatalog(otherId, other.turn.assistantId, [
    "gid://shopify/Product/2",
  ]);
  const failed = await repository.createToolInvocation(
    id,
    current.turn.assistantId,
    {
      providerCallId: randomUUID(),
      name: "get_product",
      arguments: { id: "gid://shopify/Product/3" },
    },
  );
  await repository.failToolInvocation(id, failed.id, "Catalog unavailable.");
  const before = await repository.getSnapshot(id);
  for (const productId of [1, 2, 3]) {
    await assert.rejects(
      repository.finishTurn(id, current.turn.assistantId, {
        text: "Stale or unknown recommendation.",
        status: "complete",
        presentation: {
          callId: randomUUID(),
          productIds: [`gid://shopify/Product/${productId}`],
        },
      }),
      { status: 400 },
    );
  }
  assert.deepEqual(await repository.getSnapshot(id), before);
  assert.equal(
    await database.toolInvocation.count({ where: { name: "show_products" } }),
    0,
  );
});

test("failed and ended replies do not publish a selected carousel", async () => {
  for (const ended of [false, true]) {
    const { conversationId: id } = await repository.createConversation(
      shop,
      origin,
    );
    const turn = await repository.beginTurn(id, {
      requestId: randomUUID(),
      text: "Show recommendations.",
    });
    const productIds = ["gid://shopify/Product/1"];
    await completedCatalog(id, turn.assistantId, productIds);
    if (ended) await repository.endConversation(id);
    await repository.finishTurn(id, turn.assistantId, {
      text: "An incomplete answer.",
      status: ended ? "complete" : "failed",
      error: ended ? undefined : "The reply failed.",
      presentation: { callId: randomUUID(), productIds },
    });
    const state = await repository.getSnapshot(id);
    assert.equal(state.busy, false);
    assert.equal(state.messages[1].status, "failed");
    assert.equal(
      state.messages[1].parts.some((part) => part.type === "products"),
      false,
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { conversationId: id, name: "show_products" },
      }),
      0,
    );
  }
});

const guidePath = "/products/verified-shade";
const guideOutcome = (kinds = ["measuring", "fitting"]) => ({
  status: kinds.length ? "found" : "unavailable",
  productPath: guidePath,
  guides: kinds.map((kind) => ({
    kind,
    url: `${origin}/cdn/shop/files/${kind}.pdf?v=123`,
  })),
});
async function guideLookup(id, assistantId, outcome = guideOutcome()) {
  const sourceCallId = randomUUID();
  const tool = await repository.createToolInvocation(id, assistantId, {
    providerCallId: sourceCallId,
    name: "get_product_guides",
    arguments: { productPath: guidePath },
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  if (outcome)
    await repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome,
    });
  return { tool, claim, sourceCallId };
}
const guidePresentation = (sourceCallId, kinds = ["fitting", "measuring"]) => ({
  callId: randomUUID(),
  sourceCallId,
  productPath: guidePath,
  kinds,
});

test("guide results are durable evidence and explicit selection is ordered, atomic and idempotent", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show this blind's fitting and measuring guides.",
  });
  const source = await guideLookup(id, turn.assistantId);
  const result = { productIds: [], outcome: guideOutcome() };
  await repository.completeToolInvocation(
    id,
    source.tool.id,
    source.claim,
    result,
  );
  assert.deepEqual(
    JSON.parse(
      (
        await database.toolInvocation.findUniqueOrThrow({
          where: { id: source.tool.id },
        })
      ).resultJson,
    ),
    result.outcome,
  );
  assert.ok(
    (await repository.getSnapshot(id)).messages.every((message) =>
      message.parts.every((part) => part.type !== "guides"),
    ),
  );
  const finish = {
    status: "complete",
    text: "Here are the product's guide links. I have not read the PDFs.",
    guidePresentation: guidePresentation(source.sourceCallId),
  };
  await repository.finishTurn(id, turn.assistantId, finish);
  const snapshot = await repository.getSnapshot(id);
  const content = snapshot.messages[1].parts;
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "guides"],
  );
  assert.deepEqual(content[1].guides, [...guideOutcome().guides].reverse());
  assert.equal(content[1].productPath, guidePath);
  assert.equal(content[1].voiceReply, undefined);
  const history = await repository.getModelHistory(id);
  assert.match(history.at(-1).text, /Untrusted storefront observations/);
  assert.match(history.at(-1).text, /"type":"guides"/);
  assert.match(history.at(-1).text, /fitting\.pdf\?v=123/);
  await repository.finishTurn(id, turn.assistantId, finish);
  await repository.completeToolInvocation(
    id,
    source.tool.id,
    source.claim,
    result,
  );
  assert.deepEqual(await repository.getSnapshot(id), snapshot);
  assert.equal(
    await database.toolInvocation.count({
      where: { conversationId: id, name: "show_guides" },
    }),
    1,
  );
});

test("guide completion and saved widgets both revalidate exact product and storefront origin", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show measuring.",
  });
  const source = await guideLookup(id, turn.assistantId, null);
  const valid = guideOutcome();
  const foreign = {
    ...valid,
    guides: [
      {
        kind: "measuring",
        url: "https://other-store.myshopify.com/cdn/shop/files/measuring.pdf",
      },
    ],
  };
  for (const outcome of [foreign, { ...valid, productPath: "/products/other" }])
    await assert.rejects(
      repository.completeToolInvocation(id, source.tool.id, source.claim, {
        productIds: [],
        outcome,
      }),
    );
  assert.equal(
    (
      await database.toolInvocation.findUniqueOrThrow({
        where: { id: source.tool.id },
      })
    ).resultJson,
    null,
  );
  await repository.completeToolInvocation(id, source.tool.id, source.claim, {
    productIds: [],
    outcome: valid,
  });
  const finish = {
    status: "complete",
    text: "Guide links.",
    guidePresentation: guidePresentation(source.sourceCallId),
  };
  await database.toolInvocation.update({
    where: { id: source.tool.id },
    data: { resultJson: JSON.stringify(foreign) },
  });
  await assert.rejects(repository.finishTurn(id, turn.assistantId, finish));
  assert.equal(
    await database.toolInvocation.count({
      where: { conversationId: id, name: "show_guides" },
    }),
    0,
  );
  await database.toolInvocation.update({
    where: { id: source.tool.id },
    data: { resultJson: JSON.stringify(valid) },
  });
  await repository.finishTurn(id, turn.assistantId, finish);
  const parts = (await repository.getSnapshot(id)).messages[1].parts;
  parts[1].guides = foreign.guides;
  await database.conversationMessage.update({
    where: { id: turn.assistantId },
    data: { partsJson: JSON.stringify(parts) },
  });
  await assert.rejects(repository.getSnapshot(id));
  await assert.rejects(repository.getModelHistory(id));
});

test("guide selection cannot use another conversation, a prior reply, unavailable kinds or failed lookups", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const first = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "First guide lookup.",
  });
  const prior = await guideLookup(id, first.assistantId);
  await repository.finishTurn(id, first.assistantId, {
    status: "complete",
    text: "Guide available.",
  });
  const { conversationId: otherId } = await repository.createConversation(
    shop,
    origin,
  );
  const otherTurn = await repository.beginTurn(otherId, {
    requestId: randomUUID(),
    text: "Other customer.",
  });
  const other = await guideLookup(otherId, otherTurn.assistantId);
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Display guides.",
  });
  const unavailable = await guideLookup(id, turn.assistantId, guideOutcome([]));
  const onlyMeasuring = await guideLookup(
    id,
    turn.assistantId,
    guideOutcome(["measuring"]),
  );
  const failed = await guideLookup(id, turn.assistantId, null);
  await repository.failToolInvocation(
    id,
    failed.tool.id,
    "Product changed during lookup.",
  );
  const snapshot = await repository.getSnapshot(id);
  for (const source of [prior, other, unavailable, onlyMeasuring, failed])
    await assert.rejects(
      repository.finishTurn(id, turn.assistantId, {
        status: "complete",
        text: "Not a verified guide selection.",
        guidePresentation: guidePresentation(source.sourceCallId),
      }),
      { status: 400 },
    );
  assert.deepEqual(await repository.getSnapshot(id), snapshot);
  assert.equal(
    await database.toolInvocation.count({ where: { name: "show_guides" } }),
    0,
  );
});

test("failed, cancelled and ended replies cannot publish selected guides even after a successful lookup", async () => {
  for (const mode of ["failed", "cancelled", "ended"]) {
    const { conversationId: id } = await repository.createConversation(
      shop,
      origin,
    );
    const turn = await repository.beginTurn(id, {
      requestId: randomUUID(),
      text: "Show the guides.",
    });
    const source = await guideLookup(id, turn.assistantId);
    if (mode === "ended") await repository.endConversation(id);
    if (mode === "cancelled")
      await repository.finishTurn(id, turn.assistantId, {
        status: "failed",
        text: "",
        error: "Cancelled.",
      });
    await repository.finishTurn(id, turn.assistantId, {
      status: mode === "failed" ? "failed" : "complete",
      text: "Late answer.",
      guidePresentation: guidePresentation(source.sourceCallId),
    });
    const snapshot = await repository.getSnapshot(id);
    assert.equal(snapshot.busy, false);
    assert.ok(
      snapshot.messages.every((message) =>
        message.parts.every((part) => part.type !== "guides"),
      ),
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { conversationId: id, name: "show_guides" },
      }),
      0,
    );
  }
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
