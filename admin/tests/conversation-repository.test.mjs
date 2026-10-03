import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
  stdin: {
    contents: `export * from "./admin/conversations/repository.server.ts";
      export {recallConversationHistory} from "./admin/conversations/memory-history.server.ts";
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
const queries = [];
const queryDetails = [];
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
  database.$on("query", ({ query, params }) => {
    queries.push(query);
    // Bulk write parameter logs may be truncated by Prisma. These small read
    // parameters are the evidence for actual SQL bounds, not in-memory take.
    if (/^SELECT/.test(query) && /FROM .*VoiceTranscript/.test(query))
      queryDetails.push({ query, params: JSON.parse(params) });
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
  assert.match(history, /Storefront action/);
  assert.match(history, /123:abc/);
  assert.doesNotMatch(history, /PRIVATE_TOKEN/);
  const stored = await database.toolInvocation.findUnique({
    where: { id: tool.id },
  });
  assert.deepEqual(JSON.parse(stored.resultJson), cartFixture);
  assert.equal(stored.confirmedAt, null);
});

test("quantity changes and clearing execute through ordinary owned claims in text and voice", async () => {
  for (const [name, args] of [
    ["set_cart_quantity", { lineKey: "123:abc", quantity: 2 }],
    ["clear_cart", {}],
  ]) for (const voice of [false, true]) {
    const { id, tool } = await cartInvocation(name, args, voice);
    const claim = executor();
    for (const confirmed of [true, false])
      await assert.rejects(
        repository.claimToolInvocation(id, tool.id, { ...claim, confirmed }),
        { status: 400 },
      );
    assert.deepEqual(await repository.claimToolInvocation(id, tool.id, claim), {
      claimed: true,
    });
    assert.deepEqual(await repository.claimToolInvocation(id, tool.id, claim), {
      claimed: true,
    });
    assert.deepEqual(await repository.claimToolInvocation(id, tool.id, executor()), {
      claimed: false,
    });
    const result = {
      productIds: [],
      outcome: {
        status: "updated",
        message: "Cart updated.",
        cart: name === "clear_cart"
          ? { currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: [] }
          : {
              ...cartFixture,
              itemCount: 2,
              totalPriceMinorUnits: 2000,
              items: [{ ...cartFixture.items[0], quantity: 2, linePriceMinorUnits: 2000 }],
            },
      },
    };
    await assert.rejects(repository.completeToolInvocation(id, tool.id, executor(), result), {
      status: 401,
    });
    await repository.completeToolInvocation(id, tool.id, claim, result);
    const before = await repository.getSnapshot(id);
    await repository.completeToolInvocation(id, tool.id, claim, result);
    assert.deepEqual(await repository.getSnapshot(id), before);
    const stored = await database.toolInvocation.findUniqueOrThrow({ where: { id: tool.id } });
    assert.equal(stored.status, "complete");
    assert.equal(stored.confirmedAt, null);
  }
});

test("requested removals need no second approval and remain bound to the claimed executor in text and voice", async () => {
  for (const voice of [false, true]) {
    const {id, tool} = await cartInvocation("remove_from_cart", { lineKeys: ["123:abc", "456:def"] }, voice);
    const claim = executor();
    for (const confirmed of [true, false])
      await assert.rejects(repository.claimToolInvocation(id, tool.id, {...claim, confirmed}), {status: 400});
    assert.equal((await repository.claimToolInvocation(id, tool.id, claim)).claimed, true);
    assert.equal((await database.toolInvocation.findUnique({where: {id: tool.id}})).confirmedAt, null);
    const result = {productIds: [], outcome: {status: "updated", message: "Removed.", cart: {currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: []}}};
    await assert.rejects(repository.completeToolInvocation(id, tool.id, executor(), result), {status: 401});
    await repository.completeToolInvocation(id, tool.id, claim, result);
    const before = await repository.getSnapshot(id);
    await repository.completeToolInvocation(id, tool.id, claim, result);
    assert.deepEqual(await repository.getSnapshot(id), before);
    assert.equal((await repository.claimToolInvocation(id, tool.id, claim)).claimed, false);
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
      message.text.includes("Storefront action"),
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
      message.text.includes("Storefront action"),
    )?.text ?? "",
    /"addedSample"/,
  );
});

test("configuration hierarchy, guarantee terms and prices survive claimed results, persistence and model history", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Review this product's configuration.",
  });
  const current = {
    status: "available",
    productPath: "/products/shade",
    configurationId: randomUUID(),
    controls: [
      {
        id: "c0",
        label: "Control type",
        kind: "radio",
        options: [
          { id: "o0", label: "Motorized", selected: true, available: true },
        ],
      },
      {
        id: "c1",
        label: "Remote control",
        kind: "radio",
        parent: { controlId: "c0", optionId: "o0" },
        options: [
          { id: "o0", label: "No Remote", selected: true, available: true },
          {
            id: "o1",
            label: "14 Channel Remote",
            selected: false,
            available: true,
            priceLabel: "+ £19.95",
          },
        ],
      },
      {
        id: "c2",
        label: "Guarantee a Perfect Fit",
        kind: "radio",
        purpose: "measurement_guarantee",
        description:
          "If your blind doesn’t fit, you can order a replacement of the same blind for no additional charge, unless your new measurements are larger.",
        options: [
          {
            id: "o0",
            label: "Don’t insure measurements",
            selected: true,
            available: true,
          },
          {
            id: "o1",
            label: "Insure measurements",
            selected: false,
            available: true,
            priceLabel: "+£12.00",
          },
        ],
      },
    ],
    measurements: { unit: "cm", width: 40, height: 50, availableUnits: ["cm"] },
    configuredPrice: "£65.89",
    message: "Current product choices and displayed quote.",
  };
  const historical = structuredClone(current);
  historical.configurationId = randomUUID();
  historical.controls.pop();
  delete historical.configuredPrice;
  delete historical.controls[1].parent;
  delete historical.controls[1].options[1].priceLabel;
  for (const outcome of [current, historical]) {
    const tool = await repository.createToolInvocation(id, turn.assistantId, {
      providerCallId: randomUUID(),
      name: "get_product_configuration",
      arguments: { productPath: outcome.productPath },
    });
    const claim = executor();
    assert.equal(
      (await repository.claimToolInvocation(id, tool.id, claim)).claimed,
      true,
    );
    await repository.completeToolInvocation(id, tool.id, claim, {
      productIds: [],
      outcome,
    });
    const persisted = await database.toolInvocation.findUniqueOrThrow({
      where: { id: tool.id },
    });
    assert.equal(persisted.status, "complete");
    assert.deepEqual(JSON.parse(persisted.resultJson), outcome);
  }
  await repository.finishTurn(id, turn.assistantId, {
    status: "complete",
    text: "Here is the current configuration.",
  });
  const history = await loadRepository().getModelHistory(id);
  const outcomes = history
    .filter((message) =>
      message.text.startsWith("Storefront action"),
    )
    .map(
      (message) =>
        JSON.parse(message.text.slice(message.text.indexOf("{"))).outcome,
    );
  assert.deepEqual(outcomes, [current, historical]);
  assert.equal(outcomes[0].configuredPrice, "£65.89");
  assert.equal(outcomes[0].controls[2].options[1].priceLabel, "+£12.00");
  assert.equal(Object.hasOwn(outcomes[1], "configuredPrice"), false);
  assert.equal(Object.hasOwn(outcomes[1].controls[1], "parent"), false);
  assert.equal(
    outcomes[1].controls.some((control) => control.purpose),
    false,
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
          await repository.claimToolInvocation(id, tool.id, executor());
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

test("rejected native dimensions remain a precise durable result without a cart event or changed draft", async () => {
  const draft = {
    productPath: "/products/shade",
    width: 70,
    height: 35,
    unit: "cm",
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
  assert.equal(
    (await repository.claimToolInvocation(id, tool.id, claim)).claimed,
    true,
  );
  const outcome = {
    status: "invalid_measurements",
    productPath: draft.productPath,
    draftUpdatedAt: updatedAt,
    message:
      "Drop 35 cm is below this product's minimum of 40 cm. No dimensions were entered.",
  };
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome,
  });
  const saved = await database.toolInvocation.findUniqueOrThrow({
    where: { id: tool.id },
  });
  assert.equal(
    saved.status,
    "complete",
    "the tool completed with a known rejection, not an unknown mutation",
  );
  assert.deepEqual(JSON.parse(saved.resultJson), outcome);
  const measurement = await database.measurementDraft.findFirstOrThrow({
    where: { conversationId: id },
  });
  assert.equal(measurement.width, 70);
  assert.equal(measurement.height, 35);
  assert.equal(measurement.updatedAt.toISOString(), updatedAt);
  const snapshot = await repository.getSnapshot(id);
  assert.equal(
    snapshot.messages.some((row) =>
      row.parts.some((part) => part.type === "cart_added"),
    ),
    false,
  );
  assert.equal(
    (await repository.claimToolInvocation(id, tool.id, executor())).claimed,
    false,
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
    current: { activeProduct: null, hasCustomerReply: false, pendingQuestion: null },
    history: { start: 0, end: 0, before: null, entries: [] },
    historyUpdates: [],
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

test("valid activity renews a near-expiry credential without reviving expired or invalid tokens", async () => {
  const first = await repository.createConversation(shop, origin);
  const nearExpiry = new Date(Date.now() + 60_000);
  await database.conversation.update({where:{id:first.conversationId},data:{credentialExpiresAt:nearExpiry}});
  await assert.rejects(repository.authorizeCredential(first.conversationId, "invalid"), {status:401});
  assert.equal((await database.conversation.findUniqueOrThrow({where:{id:first.conversationId}})).credentialExpiresAt.getTime(), nearExpiry.getTime());
  const renewed = await repository.authorizeCredential(first.conversationId, first.token);
  assert.ok(new Date(renewed.credentialExpiresAt ?? renewed.expiresAt).getTime() > Date.now() + 6 * 86400_000);
});

test("private window and layer notes and a model-owned checkpoint commit with the reply and survive reload", async () => {
  const {conversationId:id}=await repository.createConversation(shop,origin);
  const turn=await repository.beginTurn(id,{requestId:randomUUID(),text:"A blind and curtains for the kitchen, then the bedroom"});
  const contextCheckpoint={model:"gpt-6-luna",throughSequence:turn.memory.throughSequence,input:[
    {type:"compaction",encrypted_content:"opaque-fixture"},
    {role:"assistant",content:"Let's start with the kitchen blind."},
  ]};
  await repository.finishTurn(id,turn.assistantId,{
    status:"complete",text:"Let's start with the kitchen blind.",model:"gpt-6-luna-snapshot",requestedModel:"gpt-6-luna",
    memoryUpdate:{set:[
      {key:"kitchen",text:"Blind first, curtain layer pending; visualize both together when available. Customer prefers green."},
      {key:"bedroom",text:"Return here after kitchen. No measurements yet."},
    ],forget:[]},contextCheckpoint,
  });
  const reloaded=loadRepository();
  const next=await reloaded.beginTurn(id,{requestId:randomUUID(),text:"Actually blue for the kitchen"});
  assert.match(next.memory.memo.kitchen,/curtain layer pending/);
  assert.match(next.memory.memo.bedroom,/Return here/);
  assert.deepEqual(next.memory.checkpoints,[contextCheckpoint]);
  assert.equal(typeof next.memory.recall,"function");
  assert.ok(next.history.some(item=>item.source==="memory"&&item.text.includes("bedroom")));
  await repository.finishTurn(id,next.assistantId,{
    status:"complete",text:"Blue for the kitchen.",memoryUpdate:{set:[{key:"kitchen",text:"Blue replaces green. Blind first; curtain pending."}],forget:[]},
  });
  const state=await reloaded.getSnapshot(id);
  assert.ok(!JSON.stringify(state).includes("curtain pending"));
  assert.ok(!JSON.stringify(state).includes("opaque-fixture"));
  assert.ok(!JSON.stringify(state).includes("memoJson"));
  const row=await database.conversation.findUniqueOrThrow({where:{id}});
  assert.equal(JSON.parse(row.memoJson).bedroom,"Return here after kitchen. No measurements yet.");
  const voice=await reloaded.getModelHistory(id);
  assert.ok(voice.some(item=>item.source==="memory"&&item.text.includes("Blue replaces green")));
});

test("invalid, failed and late replies cannot partially change memory or context", async () => {
  const {conversationId:id}=await repository.createConversation(shop,origin);
  const turn=await repository.beginTurn(id,{requestId:randomUUID(),text:"Measure the kitchen"});
  const patch={set:[{key:"kitchen",text:"Unfinished measuring task"}],forget:[]};
  await assert.rejects(repository.finishTurn(id,turn.assistantId,{
    status:"complete",text:"A response",memoryUpdate:patch,
    contextCheckpoint:{model:"foreign-model",throughSequence:1,input:[{type:"compaction",encrypted_content:"invalid-owner"}]},
    model:"gpt-6-luna",
  }),/checkpoint owner/);
  assert.equal((await database.conversation.findUniqueOrThrow({where:{id}})).memoJson,"{}");
  assert.equal((await database.conversationMessage.findUniqueOrThrow({where:{id:turn.assistantId}})).status,"pending");
  await assert.rejects(repository.finishTurn(id,turn.assistantId,{
    status:"complete",text:"A response",memoryUpdate:patch,
    questionPresentation:{callId:randomUUID(),question:"Pick one",answers:["Same","Same"]},
  }));
  assert.equal((await database.conversation.findUniqueOrThrow({where:{id}})).memoJson,"{}");
  await repository.finishTurn(id,turn.assistantId,{status:"failed",text:"",memoryUpdate:patch});
  await repository.finishTurn(id,turn.assistantId,{status:"complete",text:"Late",memoryUpdate:patch});
  assert.equal((await database.conversation.findUniqueOrThrow({where:{id}})).memoJson,"{}");
  assert.equal(await database.conversationContext.count(),0);
});

test("older evidence recall is conversation-scoped, bounded and cancellable", async () => {
  const first=await repository.createConversation(shop,origin);
  const second=await repository.createConversation(shop,origin);
  for (const [id,text] of [[first.conversationId,"Kitchen curtain must be blue"],[second.conversationId,"Kitchen curtain secret from another customer"]]) {
    const turn=await repository.beginTurn(id,{requestId:randomUUID(),text});
    await repository.finishTurn(id,turn.assistantId,{status:"complete",text:"Noted"});
  }
  const result=await repository.recallConversationHistory(first.conversationId,{query:"Kitchen curtain",beforeSequence:null},new AbortController().signal);
  assert.equal(result.referenceOnly,true);
  assert.match(JSON.stringify(result.entries),/must be blue/);
  assert.ok(!JSON.stringify(result).includes("another customer"));
  assert.equal(result.nextBeforeSequence,0);
  const older=await repository.recallConversationHistory(first.conversationId,{query:"",beforeSequence:0},new AbortController().signal);
  assert.deepEqual(older.entries,[]);
  await assert.rejects(repository.recallConversationHistory(first.conversationId,{query:"",beforeSequence:null},AbortSignal.abort()));
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
  assert.equal(started.snapshot.messages[0].requestId, input.requestId);
  assert.notEqual(started.snapshot.messages[0].id, input.requestId);
  assert.equal(started.snapshot.messages[1].requestId, undefined);
  assert.deepEqual(started.history, [{ role: "user", text: input.text, sequence: 0, endSequence: 0 }]);
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
  assert.equal(persisted.messages[0].requestId, input.requestId);
  assert.equal(persisted.messages[1].id, started.assistantId);
  assert.equal(
    persisted.messages[1].parts[0].text,
    "Consider light filtering.",
  );
  assert.deepEqual(Object.keys(persisted.messages[1]).sort(), [
    "createdAt",
    "endSequence",
    "id",
    "parts",
    "role",
    "sequence",
    "sourceEndSequence",
    "sourceSequence",
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
    { role: "user", text: "Old question", sequence: 0, endSequence: 0 },
    { role: "user", text: "New question", sequence: 2, endSequence: 2 },
  ]);
});

test("failed replies release the conversation and long chats retain idempotency without a turn cutoff", async () => {
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
    data: { turnCount: 1000 },
  });
  const reloaded = loadRepository();
  assert.equal((await reloaded.beginTurn(id, firstInput)).assistantId, null);
  const next = await reloaded.beginTurn(id, {
      requestId: randomUUID(),
      text: "Another question",
    });
  assert.ok(next.assistantId);
  assert.equal((await database.conversation.findUniqueOrThrow({where: {id}})).turnCount, 1001);
  await assert.rejects(reloaded.beginTurn(id, {requestId: randomUUID(), text: "Overlapping turn"}), {status: 409});
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
    arguments: { queries: ["blackout blinds"] },
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
  assert.equal(turn.history.at(-1).source, "application_state");
  assert.match(turn.history.at(-1).text, /\/collections\/blackout-blinds/);
  assert.equal(turn.history.filter((row) => row.text.includes("/collections/blackout-blinds")).length, 1);
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

test("journey rejects sensitive URLs and unbounded timestamps but continues beyond 200 page views", async () => {
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
  await repository.appendJourney(id, pageView());
  assert.equal(
    await database.conversationMessage.count({ where: { conversationId: id } }),
    201,
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
    catalogQueries: [{ query: "blackout blinds", status: "succeeded", productIds: ["gid://shopify/Product/123", "gid://shopify/Product/456"] }],
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
  assert.deepEqual(JSON.parse(persisted.resultJson), { queries: result.catalogQueries });
  await assert.rejects(
    repository.completeToolInvocation(id, tool.id, claim, { productIds: [], catalogQueries: [{ query: "blackout blinds", status: "succeeded", productIds: [] }] }),
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
    repository.finishTurn(id, turn.assistantId, terminalResponse({
      text: "An ungrounded recommendation.",
      status: "complete",
      presentation: {
        callId: randomUUID(),
        productIds: ["gid://shopify/Product/123"],
        productRefs: productRefs(["gid://shopify/Product/123"]),
      },
    })),
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

test("model history shares the active blind with the UI and distinguishes hidden page observations", async () => {
  const { id, tool } = await cartInvocation("navigate", { path: "/products/chosen-blind" });
  await repository.appendJourney(id, { requestId: randomUUID(), title: "Old hidden blind", path: "/products/old-hidden", occurredAt: new Date().toISOString() });
  assert.match((await repository.getModelHistory(id)).at(-1).text, /"activeBlind":null/);
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  await repository.completeToolInvocation(id, tool.id, claim, { productIds: [], outcome: {
    status: "navigated", path: "/products/chosen-blind", title: "Chosen blind",
  } });
  await repository.appendJourney(id, { requestId: randomUUID(), title: "Different hidden blind", path: "/products/different-hidden", occurredAt: new Date().toISOString() });
  const history = await repository.getModelHistory(id);
  assert.match(history.at(-1).text, /"activeBlind":\{"path":"\/products\/chosen-blind","title":"Chosen blind"\}/);
  assert.match(history.at(-1).text, /"backgroundPage":\{"title":"Different hidden blind","path":"\/products\/different-hidden"\}/);
  assert.equal(history.at(-1).source, "application_state");
  await repository.endConversation(id);
  assert.match((await repository.getModelHistory(id)).at(-1).text, /"activeBlind":null/);
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
    assert.match(history, /Application state.*\/search/);
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
    arguments: { queries: ["blackout blinds"] },
    ...overrides,
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds,
    ...(tool.name === "search_products" ? { catalogQueries: tool.arguments.queries.map((query, index) => ({
      query, status: "succeeded", productIds: productIds.slice(index * 10, index * 10 + 10),
    })) } : {}),
  });
  return tool;
}

const productRefs = (productIds) =>
  productIds.map((id) => ({ id, title: `Shade ${id.split("/").at(-1)}` }));

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
    productRefs: productRefs([productIds[2], productIds[0]]),
  };
  const reply = terminalResponse({
    text: "These two meet your preference.",
    status: "complete",
    presentation,
  });
  await repository.finishTurn(id, turn.assistantId, reply);
  const state = await loadRepository().getSnapshot(id);
  assert.equal(state.busy, false);
  assert.equal(state.revision, before.revision + 1);
  assert.deepEqual(state.tools, []);
  const shown = await database.toolInvocation.findFirstOrThrow({
    where: { conversationId: id, name: "show_products" },
  });
  assert.equal(shown.assistantId, turn.assistantId);
  assert.notEqual(shown.providerCallId, presentation.callId);
  assert.match(shown.providerCallId, /^roman:products:[a-f0-9]{64}$/);
  assert.equal(shown.status, "complete");
  assert.deepEqual(JSON.parse(shown.productIdsJson), presentation.productIds);
  assert.equal(shown.claimClientId, null);
  await assert.rejects(repository.getBrowserToolContext(id, shown.id), {
    status: 400,
  });
  assert.deepEqual(state.messages[1].parts.slice(0, 2), [
    { type: "text", text: reply.text },
    {
      type: "products",
      version: 1,
      invocationId: shown.id,
      productIds: presentation.productIds,
      productRefs: presentation.productRefs,
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
        entry.text.startsWith("Storefront history") &&
        entry.text.includes(productIds[2]),
    ),
  );
});

test("ten selected products persist and restore as one ordered carousel", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show ten roller blinds.",
  });
  const productIds = Array.from(
    { length: 10 },
    (_, index) => `gid://shopify/Product/${10 - index}`,
  );
  await completedCatalog(id, turn.assistantId, productIds);
  await repository.finishTurn(id, turn.assistantId, terminalResponse({
    text: "Here are ten options.",
    status: "complete",
    presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
  }));
  const restored = await loadRepository().getSnapshot(id);
  const cards = restored.messages[1].parts.find(
    (part) => part.type === "products",
  );
  assert.deepEqual(cards.productIds, productIds);
  assert.deepEqual(cards.productRefs, productRefs(productIds));
  assert.equal(restored.messages[1].status, "complete");
});

test("a displayed carousel keeps its ID-title mapping before a spoken partial-title choice, and legacy cards still load", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show me two roller blinds.",
  });
  const productIds = ["gid://shopify/Product/123", "gid://shopify/Product/456"];
  const refs = [
    { id: productIds[0], title: "Serene Green Roller Blind" },
    { id: productIds[1], title: "Midnight Blue Roller Blind" },
  ];
  await completedCatalog(id, turn.assistantId, productIds);
  await repository.finishTurn(id, turn.assistantId, terminalResponse({
    status: "complete",
    text: "Here are the two options.",
    presentation: { callId: randomUUID(), productIds, productRefs: refs },
  }));

  const restored = loadRepository();
  const carousel = (await restored.getSnapshot(id)).messages[1].parts.find(
    (part) => part.type === "products",
  );
  assert.deepEqual(carousel.productRefs, refs);
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
  await database.voiceTranscript.create({
    data: {
      id: randomUUID(),
      voiceId,
      conversationId: id,
      providerEventId: randomUUID(),
      sequence: 2,
      role: "user",
      text: "The green one",
      startMs: 0,
      endMs: 800,
    },
  });
  await database.conversation.update({ where: { id }, data: { nextSequence: 3 } });
  const history = await restored.getModelHistory(id);
  const observationIndex = history.findIndex((entry) =>
    entry.text.startsWith("Storefront history") &&
    entry.text.includes(carousel.invocationId),
  );
  const spokenIndex = history.findIndex((entry) =>
    entry.role === "user" && entry.text === "The green one",
  );
  assert.ok(observationIndex >= 0 && spokenIndex > observationIndex);
  const observations = JSON.parse(
    history[observationIndex].text.slice(history[observationIndex].text.indexOf(": ") + 2),
  );
  assert.deepEqual(observations[0].productRefs, refs);

  const stored = await database.conversationMessage.findUniqueOrThrow({
    where: { id: turn.assistantId },
  });
  const legacyParts = JSON.parse(stored.partsJson);
  delete legacyParts.find((part) => part.type === "products").productRefs;
  await database.conversationMessage.update({
    where: { id: turn.assistantId },
    data: { partsJson: JSON.stringify(legacyParts) },
  });
  const legacy = loadRepository();
  const oldCarousel = (await legacy.getSnapshot(id)).messages[1].parts.find(
    (part) => part.type === "products",
  );
  assert.equal(oldCarousel.productRefs, undefined);
  assert.ok((await legacy.getModelHistory(id)).some((entry) =>
    entry.text.includes(carousel.invocationId),
  ));
});

test("questions persist after product widgets, survive reload and keep short answers meaningful", async () => {
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
  const questionPresentation = {
    callId: randomUUID(),
    question: "Is blackout your priority?",
    answers: ["Yes", "Daytime privacy"],
  };
  const result = terminalResponse({
    status: "complete",
    text: "These offer different levels of light control.",
    presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
    questionPresentation,
  });
  await repository.finishTurn(id, turn.assistantId, result);
  const state = await loadRepository().getSnapshot(id);
  assert.deepEqual(
    state.messages[1].parts.map((part) => part.type),
    ["text", "products", "question"],
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
      role: "user",
      source: "roman_question",
      text: 'Roman question: {"question":"Is blackout your priority?","answers":["Yes","Daytime privacy"]}',
      sequence: 1, endSequence: 1,
    },
    { role: "user", text: "Yes", sequence: 2, endSequence: 2 },
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
      repository.finishTurn(id, turn.assistantId, terminalResponse({
        text: "",
        status: "complete",
        presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
        questionPresentation: invalid,
      })),
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
  const history = await repository.getModelHistory(id);
  assert.equal(history.at(-1).role, "user");
  assert.equal(history.at(-1).source, "application_state");
  assert.equal(history.at(-1).pendingQuestion.question, questionPresentation.question);
  assert.ok(!history.some((message) => message.role === "assistant"));
  assert.doesNotMatch(
    JSON.stringify(history),
    /Suggested answers:|Measurement input:/,
  );
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
    { length: 10 },
    (_, index) => `gid://shopify/Product/${index + 1}`,
  );
  await completedCatalog(id, turn.assistantId, available);
  const before = await repository.getSnapshot(id);
  for (const selection of [
    { callId: randomUUID(), productIds: [] },
    { callId: randomUUID(), productIds: [...available, "gid://shopify/Product/11"] },
    { callId: randomUUID(), productIds: [available[0], available[0]] },
    { callId: randomUUID(), productIds: ["gid://shopify/Product/999"] },
    { callId: randomUUID(), productIds: ["gid://shopify/ProductVariant/1"] },
    { callId: "", productIds: [available[0]] },
    { callId: "x".repeat(201), productIds: [available[0]] },
    { callId: randomUUID(), productIds: [available[0]], productRefs: [] },
    {
      callId: randomUUID(),
      productIds: [available[0]],
      productRefs: [{ id: available[1], title: "Wrong product" }],
    },
    {
      callId: randomUUID(),
      productIds: [available[0]],
      productRefs: [{ id: available[0], title: "" }],
    },
  ]) {
    const presentation = {
      ...selection,
      productRefs: selection.productRefs ?? productRefs(selection.productIds),
    };
    await assert.rejects(
      repository.finishTurn(id, turn.assistantId, terminalResponse({
        text: "This must not persist.",
        status: "complete",
        presentation,
      })),
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
    catalogQueries: [{ query: "blackout blinds", status: "succeeded", productIds: ["gid://shopify/Product/1"] }],
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
      repository.finishTurn(id, current.turn.assistantId, terminalResponse({
        text: "Stale or unknown recommendation.",
        status: "complete",
        presentation: {
          callId: randomUUID(),
          productIds: [`gid://shopify/Product/${productId}`],
          productRefs: productRefs([`gid://shopify/Product/${productId}`]),
        },
      })),
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
    await repository.finishTurn(id, turn.assistantId, terminalResponse({
      text: "An incomplete answer.",
      status: ended ? "complete" : "failed",
      error: ended ? undefined : "The reply failed.",
      presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
    }));
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

test("measurement questions with unknown units persist without inventing units or dimensions for free-text replies", async () => {
  const {conversationId:id}=await repository.createConversation(shop,origin);
  const turn=await repository.beginTurn(id,{requestId:randomUUID(),text:"I have some measurements"});
  const source=await guideLookup(id,turn.assistantId);
  await repository.finishTurn(id,turn.assistantId,{
    status:"complete",text:"",questionPresentation:{
      callId:randomUUID(),sourceCallId:source.sourceCallId,
      question:"What width have you measured?",answers:[],
      measurement:{productPath:guidePath,label:"Width",unit:null,instructions:""},
    },
  });
  const restarted=loadRepository();
  const snapshot=await restarted.getSnapshot(id);
  const question=snapshot.messages.at(-1).parts.find(part=>part.type==="question");
  assert.deepEqual(question.measurement,{productPath:guidePath,label:"Width",unit:null,instructions:""});
  const text='Width: 1 1/2 in, or about 38 mm';
  const next=await restarted.beginTurn(id,{requestId:randomUUID(),text});
  assert.deepEqual(next.history.at(-1),{role:"user",text,sequence:2,endSequence:2});
  assert.ok(next.history.some(item=>item.source==="roman_question"&&item.text.includes('"unit":null')));
  assert.equal(await database.measurementDraft.count(),0);
});


test("measurement questions persist verified product context and resume through the canonical text and voice history", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Help me measure.",
  });
  const source = await guideLookup(id, turn.assistantId);
  const selection = {
    question: "What is the handle clearance?",
    answers: [],
    measurement: {
      productPath: guidePath,
      label: "Handle clearance",
      unit: "mm",
      instructions: "Measure from the handle to the front of the recess.",
    },
  };
  const result = {
    status: "complete",
    text: "",
    questionPresentation: {
      ...selection,
      callId: randomUUID(),
      sourceCallId: source.sourceCallId,
    },
  };
  await repository.finishTurn(id, turn.assistantId, result);
  const restarted = loadRepository();
  const snapshot = await restarted.getSnapshot(id);
  const question = snapshot.messages.at(-1).parts[0];
  assert.deepEqual(question, {
    type: "question",
    version: 1,
    invocationId: question.invocationId,
    ...selection,
  });
  const saved = await database.toolInvocation.findUniqueOrThrow({
    where: { id: question.invocationId },
  });
  assert.equal(saved.name, "ask_measurement");
  assert.equal(saved.status, "complete");
  assert.equal(saved.claimClientId, null);
  assert.equal(
    JSON.parse(saved.argumentsJson).sourceCallId,
    source.sourceCallId,
  );
  await assert.rejects(restarted.getBrowserToolContext(id, saved.id), {
    status: 400,
  });
  await restarted.finishTurn(id, turn.assistantId, result);
  assert.equal(
    await database.toolInvocation.count({ where: { name: "ask_measurement" } }),
    1,
  );
  assert.equal(await database.measurementDraft.count(), 0);
  const history = await restarted.getModelHistory(id);
  assert.equal(history.at(-1).source, "application_state");
  assert.deepEqual(history.at(-1).pendingQuestion, selection);
  assert.equal(history.filter((row) => row.text.includes(selection.question)).length, 1);
  const next = await restarted.beginTurn(id, {
    requestId: randomUUID(),
    text: "Handle clearance: 0 mm",
  });
  assert.deepEqual(next.history.slice(-2), [
    { role: "user", source: "roman_question", text: `Roman question: ${JSON.stringify(selection)}`, sequence: 1, endSequence: 1 },
    { role: "user", text: "Handle clearance: 0 mm", sequence: 2, endSequence: 2 },
  ]);
});

test("measurement presentations reject missing, mismatched or historical guide provenance atomically", async () => {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Measure this blind.",
  });
  const source = await guideLookup(id, turn.assistantId);
  const selection = {
    callId: randomUUID(),
    sourceCallId: source.sourceCallId,
    question: "What is the width?",
    answers: [],
    measurement: {
      productPath: guidePath,
      label: "Width",
      unit: "mm",
      instructions: "Measure the width at the top.",
    },
  };
  for (const invalid of [
    { ...selection, sourceCallId: undefined },
    { ...selection, sourceCallId: "unknown-source" },
    {
      ...selection,
      measurement: { ...selection.measurement, productPath: "/products/other" },
    },
    { ...selection, answers: ["500"] },
  ]) {
    await assert.rejects(
      repository.finishTurn(id, turn.assistantId, {
        status: "complete",
        text: "",
        questionPresentation: invalid,
      }),
      { status: 400 },
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { name: "ask_measurement" },
      }),
      0,
    );
    assert.equal((await repository.getSnapshot(id)).busy, true);
  }
  await repository.finishTurn(id, turn.assistantId, {
    status: "complete",
    text: "Here is the guide.",
  });
  const next = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Continue.",
  });
  await assert.rejects(
    repository.finishTurn(id, next.assistantId, {
      status: "complete",
      text: "",
      questionPresentation: selection,
    }),
    { status: 400 },
  );
  await repository.finishTurn(id, next.assistantId, {
    status: "failed",
    text: "",
    error: "Interrupted",
    questionPresentation: selection,
  });
  assert.equal(
    await database.toolInvocation.count({ where: { name: "ask_measurement" } }),
    0,
  );
});

async function cachedGuideTurn() {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  await repository.appendJourney(id, pageView({ path: guidePath }));
  const original = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Help me measure.",
  });
  const source = await guideLookup(id, original.assistantId);
  await repository.finishTurn(id, original.assistantId, {
    status: "complete",
    text: "Use this product's original measuring guide.",
  });
  const current = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Continue with the next reading.",
  });
  const receipt = {
    sourceCallId: source.sourceCallId,
    sourceAssistantId: original.assistantId,
    productPath: guidePath,
    expiresAt: Date.now() + 30_000,
    kinds: ["measuring"],
  };
  const question = {
    callId: randomUUID(),
    sourceCallId: source.sourceCallId,
    question: "What is the width?",
    answers: [],
    measurement: {
      productPath: guidePath,
      label: "Width",
      unit: "mm",
      instructions: "Measure the width at the top.",
    },
  };
  return { id, original, current, source, receipt, question };
}

test("an unexpired original-guide receipt supports later numeric input without another lookup", async () => {
  const { id, current, receipt, question } = await cachedGuideTurn();
  await repository.appendJourney(
    id,
    pageView({
      path: "/en-gb/collections/roman/products/verified-shade",
    }),
  );
  const result = {
    status: "complete",
    text: "",
    cachedGuideSource: receipt,
    questionPresentation: question,
  };
  assert.equal(
    await repository.finishTurn(id, current.assistantId, result),
    true,
  );
  const state = await loadRepository().getSnapshot(id);
  const saved = state.messages.find(
    (message) => message.id === current.assistantId,
  );
  assert.deepEqual(
    saved.parts.map((part) => part.type),
    ["question"],
  );
  assert.deepEqual(saved.parts[0].measurement, question.measurement);
  assert.equal(JSON.stringify(state).includes("expiresAt"), false);
  assert.equal(
    await database.toolInvocation.count({
      where: { conversationId: id, name: "get_product_guides" },
    }),
    1,
  );
  assert.equal(
    await repository.finishTurn(id, current.assistantId, result),
    false,
  );
});

test("historical original-guide receipts reject expired, foreign, changed-page and unread sources atomically", async () => {
  for (const scenario of [
    "missing",
    "expired",
    "wrong-call",
    "wrong-assistant",
    "wrong-product",
    "empty-kinds",
    "unread-fitting",
    "failed-assistant",
    "failed-source",
    "foreign-conversation",
    "away",
    "away-return",
    "no-current-page",
  ]) {
    const { id, original, current, source, receipt, question } =
      await cachedGuideTurn();
    let cachedGuideSource = receipt;
    if (scenario === "missing") cachedGuideSource = undefined;
    if (scenario === "expired") receipt.expiresAt = Date.now() - 1;
    if (scenario === "wrong-call") receipt.sourceCallId = "another-call";
    if (scenario === "wrong-assistant")
      receipt.sourceAssistantId = randomUUID();
    if (scenario === "wrong-product") receipt.productPath = "/products/another";
    if (scenario === "empty-kinds") receipt.kinds = [];
    if (scenario === "unread-fitting")
      receipt.kinds = ["fitting"];
    if (scenario === "failed-assistant")
      await database.conversationMessage.update({
        where: { id: original.assistantId },
        data: { status: "failed" },
      });
    if (scenario === "failed-source")
      await database.toolInvocation.update({
        where: { id: source.tool.id },
        data: { status: "failed", error: "Unavailable" },
      });
    if (scenario === "foreign-conversation") {
      const other = await cachedGuideTurn();
      Object.assign(receipt, other.receipt);
      question.sourceCallId = other.source.sourceCallId;
    }
    if (scenario === "away" || scenario === "away-return") {
      await repository.appendJourney(
        id,
        pageView({ path: "/collections/roman" }),
      );
      if (scenario === "away-return")
        await repository.appendJourney(id, pageView({ path: guidePath }));
    }
    if (scenario === "no-current-page")
      await database.conversationMessage.deleteMany({
        where: { conversationId: id, role: "context" },
      });
    await assert.rejects(
      repository.finishTurn(id, current.assistantId, {
        status: "complete",
        text: "",
        cachedGuideSource,
        questionPresentation: question,
      }),
      { status: 400 },
      scenario,
    );
    assert.equal((await repository.getSnapshot(id)).busy, true, scenario);
    assert.equal(
      await database.toolInvocation.count({
        where: {
          assistantId: current.assistantId,
          name: "ask_measurement",
        },
      }),
      0,
      scenario,
    );
  }
});

test("guide results persist as evidence without creating display widgets", async () => {
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
  await repository.finishTurn(id, turn.assistantId, {status: "complete", text: "Let's walk through the measuring guide."});
  const snapshot = await repository.getSnapshot(id);
  assert.deepEqual(snapshot.messages[1].parts.map(part => part.type), ["text"]);
  assert.doesNotMatch(JSON.stringify(await repository.getModelHistory(id)), /"type":"guides"/);
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
  await repository.finishTurn(id, turn.assistantId, { status: "complete", text: "Grounded help." });
  // Historical guide rows remain readable for admin audit, but reject foreign sources.
  const historic = {type: "guides", version: 1, invocationId: randomUUID(), productPath: guidePath, guides: valid.guides};
  const parts = [{type: "text", text: "Earlier guide."}, historic];
  await database.conversationMessage.update({where: {id: turn.assistantId}, data: {partsJson: JSON.stringify(parts)}});
  assert.equal((await repository.getSnapshot(id)).messages[1].parts[1].type, "guides");
  historic.guides = foreign.guides;
  await database.conversationMessage.update({where: {id: turn.assistantId}, data: {partsJson: JSON.stringify(parts)}});
  await assert.rejects(repository.getSnapshot(id));
  await assert.rejects(repository.getModelHistory(id));
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
  for (let index = 1; index < 12; index++)
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
  assert.equal((await repository.getSnapshot(id)).tools.length, 12);
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
      catalogQueries: [{ query: "blackout blinds", status: "succeeded", productIds: [] }],
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
    for (const migration of (await readdir("prisma/migrations", {withFileTypes:true}))
      .filter(entry => entry.isDirectory() && entry.name > "20260915150000_conversation_catalog_journey")
      .map(entry => entry.name).sort()) await migrate(migration);
    const row = await legacy.conversation.findUniqueOrThrow({
      where: { id },
      include: { messages: true },
    });
    assert.equal(row.credentialHash, "a".repeat(64));
    assert.equal(row.nextSequence, 8);
    assert.equal(row.status, "active");
    assert.equal(row.memoJson, "{}");
    assert.equal(await legacy.conversationContext.count(), 0);
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

test("cart removal migration keeps completed history and pending actions readable without rewriting receipts", async () => {
  const completed = await cartInvocation("remove_from_cart", { lineKeys: ["123:abc"] });
  const claim = executor();
  await repository.claimToolInvocation(completed.id, completed.tool.id, claim);
  await repository.completeToolInvocation(completed.id, completed.tool.id, claim, {
    productIds: [],
    outcome: {
      status: "updated",
      message: "The shade was removed.",
      cart: { currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: [] },
    },
  });
  await repository.finishTurn(completed.id, completed.turn.assistantId, {
    text: "The shade was removed.", status: "complete",
  });
  const pending = await cartInvocation("remove_from_cart", { lineKeys: ["456:def"] });
  const batch = await cartInvocation("remove_from_cart", { lineKeys: ["123:abc", "456:def"] });
  const quantity = await cartInvocation("set_cart_quantity", { lineKey: "123:abc", quantity: 2 });
  // Recreate the stored shape before batch removal was introduced, including
  // the completed action's old approval evidence. No storefront action runs.
  await database.toolInvocation.update({
    where: { id: completed.tool.id },
    data: { argumentsJson: JSON.stringify({ lineKey: "123:abc" }), confirmedAt: new Date() },
  });
  await database.toolInvocation.update({
    where: { id: pending.tool.id },
    data: { argumentsJson: JSON.stringify({ lineKey: "456:def" }) },
  });
  const readRows = () => database.toolInvocation.findMany({ orderBy: { id: "asc" } });
  const originalRows = await readRows();
  const originalSnapshot = await repository.getSnapshot(completed.id);
  const conversation = await database.conversation.findUniqueOrThrow({ where: { id: completed.id } });
  const originalHistory = await repository.getHistoryPage(completed.id, conversation.nextSequence);
  await assert.rejects(repository.getModelHistory(completed.id));
  await assert.rejects(repository.getSnapshot(pending.id));

  const sql = await readFile("prisma/migrations/20261002170000_cart_removal_batches/migration.sql", "utf8");
  const migrate = async () => {
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean))
      await database.$executeRawUnsafe(statement);
  };
  await migrate();
  const expectedRows = originalRows.map((row) => {
    const lineKey = row.id === completed.tool.id ? "123:abc" : row.id === pending.tool.id ? "456:def" : undefined;
    return lineKey ? { ...row, argumentsJson: JSON.stringify({ lineKeys: [lineKey] }) } : row;
  });
  assert.deepEqual(await readRows(), expectedRows, "Only the two old argument representations change in place");
  for (const untouched of [batch.tool, quantity.tool])
    assert.deepEqual(
      await database.toolInvocation.findUniqueOrThrow({ where: { id: untouched.id } }),
      originalRows.find((row) => row.id === untouched.id),
    );
  await migrate();
  assert.deepEqual(await readRows(), expectedRows, "Reapplying the data conversion cannot alter migrated records");
  assert.deepEqual(await repository.getSnapshot(completed.id), originalSnapshot);
  assert.deepEqual(await repository.getHistoryPage(completed.id, conversation.nextSequence), originalHistory);
  assert.deepEqual((await repository.getSnapshot(pending.id)).tools[0].arguments, { lineKeys: ["456:def"] });
  assert.deepEqual((await repository.getBrowserToolContext(completed.id, completed.tool.id)).arguments, { lineKeys: ["123:abc"] });
  const restored = loadRepository();
  const history = await restored.getModelHistory(completed.id);
  const action = history.find((entry) => entry.text.startsWith("Storefront action:"));
  assert.ok(action, "The completed removal remains available to later model turns");
  assert.deepEqual(JSON.parse(action.text.slice("Storefront action: ".length)).arguments, { lineKeys: ["123:abc"] });
  await restored.getVoiceStartupContext(completed.id);
  const resumed = await restored.beginTurn(completed.id, { requestId: randomUUID(), text: "Show my cart now." });
  assert.ok(resumed.assistantId);
  assert.ok(resumed.history.some((entry) => entry.text === action.text));
  assert.deepEqual(await database.$queryRawUnsafe('PRAGMA foreign_key_check'), []);
});

const libraryResult = () => ({
  library: "blinds",
  pagePath: "/pages/measuring-blinds",
  title: "Measuring blinds",
  sections: [
    {
      id: "s_" + "1".repeat(24),
      title: "Angled bay",
      text: "Read each straight section separately using the matching method.",
    },
  ],
  guides: [
    {
      id: "g_" + "2".repeat(24),
      title: "Roller blinds in an angled bay",
      section: "s_" + "1".repeat(24),
      url: origin + "/cdn/shop/files/bay.pdf?v=123",
    },
  ],
  diagramNotice:
    "Diagrams and videos were not interpreted; do not infer instructions that depend on them.",
});
async function libraryTurn(voice = false) {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  await repository.appendJourney(id, pageView({ path: guidePath }));
  const voiceId = voice ? randomUUID() : undefined;
  if (voiceId)
    await database.voiceSession.create({
      data: {
        id: voiceId,
        conversationId: id,
        clientId: randomUUID(),
        status: "active",
        leaseExpiresAt: new Date(Date.now() + 45_000),
      },
    });
  const turn = await repository.beginTurn(
    id,
    {
      requestId: randomUUID(),
      text: voiceId ? "" : "Help with this bay.",
    },
    voiceId,
  );
  const sourceCallId = randomUUID();
  const tool = await repository.createToolInvocation(id, turn.assistantId, {
    providerCallId: sourceCallId,
    name: "discover_guides",
    arguments: { library: "blinds" },
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const outcome = libraryResult();
  await repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [],
    outcome,
  });
  const inventory = repository.saveLibraryDiscovery(id, origin, outcome, {
    sourceCallId,
    sourceAssistantId: turn.assistantId,
  });
  const page = repository.latestProductPage(
    (await repository.getSnapshot(id)).messages,
  );
  const bound = repository.bindLibrarySource(
    id,
    origin,
    inventory.source,
    page,
  );
  const question = {
    callId: randomUUID(),
    sourceCallId,
    librarySource: bound,
    question: "What is the width of this section?",
    answers: [],
    measurement: {
      productPath: guidePath,
      label: "Section width",
      unit: "mm",
      instructions:
        "Measure this straight section using the established method.",
    },
  };
  return {
    id,
    turn,
    tool,
    claim,
    outcome,
    inventory,
    bound,
    question,
    voiceId,
  };
}







test("verified library HTML supports a product-bound numeric question without exposing source receipts", async () => {
  const value = await libraryTurn();
  assert.equal(
    (await repository.getBrowserToolContext(value.id, value.tool.id)).name,
    "discover_guides",
  );
  await repository.finishTurn(value.id, value.turn.assistantId, {
    status: "complete",
    text: "",
    questionPresentation: value.question,
  });
  const snapshot = await repository.getSnapshot(value.id);
  const part = snapshot.messages.at(-1).parts[0];
  assert.equal(part.type, "question");
  assert.equal(part.measurement.productPath, guidePath);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /sourceAssistantId|librarySource|expiresAt|discoveryId/,
  );
  const next = await repository.beginTurn(value.id, {
    requestId: randomUUID(),
    text: "Next measurement please.",
  });
  await repository.finishTurn(value.id, next.assistantId, {
    status: "complete",
    text: "",
    questionPresentation: { ...value.question, callId: randomUUID() },
  });
  assert.equal(
    await database.toolInvocation.count({
      where: { conversationId: value.id, name: "discover_guides" },
    }),
    1,
  );
});

test("library measurement receipts reject unread PDFs, expiry, foreign sources and changed page episodes atomically", async () => {
  for (const scenario of [
    "unread-pdf",
    "expired",
    "wrong-call",
    "wrong-assistant",
    "different-product",
    "away-return",
    "evicted",
    "failed-source",
  ]) {
    const value = await libraryTurn();
    const question = structuredClone(value.question);
    if (scenario === "unread-pdf")
      question.librarySource.source.guideIds = [value.outcome.guides[0].id];
    if (scenario === "expired")
      question.librarySource.source.expiresAt = Date.now() - 1;
    if (scenario === "wrong-call") question.sourceCallId = randomUUID();
    if (scenario === "wrong-assistant")
      question.librarySource.source.sourceAssistantId = randomUUID();
    if (scenario === "different-product")
      question.measurement.productPath = "/products/another";
    if (scenario === "away-return") {
      await repository.appendJourney(value.id, pageView({ path: "/" }));
      await repository.appendJourney(value.id, pageView({ path: guidePath }));
    }
    if (scenario === "evicted") repository.clearLibrarySession(value.id);
    if (scenario === "failed-source")
      await database.toolInvocation.update({
        where: { id: value.tool.id },
        data: { status: "failed", error: "Failed discovery" },
      });
    await assert.rejects(
      repository.finishTurn(value.id, value.turn.assistantId, {
        status: "complete",
        text: "",
        questionPresentation: question,
      }),
      undefined,
      scenario,
    );
    assert.equal(
      await database.toolInvocation.count({
        where: { assistantId: value.turn.assistantId, name: "ask_measurement" },
      }),
      0,
      scenario,
    );
  }
});

test("footer support is a durable claimed read and cannot impersonate another library", async () => {
  const value = await libraryTurn();
  const tool = await repository.createToolInvocation(
    value.id,
    value.turn.assistantId,
    { providerCallId: randomUUID(), name: "get_store_support", arguments: {} },
  );
  const claim = executor();
  await repository.claimToolInvocation(value.id, tool.id, claim);
  const outcome = {
    status: "found",
    phone: "01 969 7247",
    hours: "9am - 5:30pm 7 days a week",
  };
  await repository.completeToolInvocation(value.id, tool.id, claim, {
    productIds: [],
    outcome,
  });
  assert.deepEqual(
    JSON.parse(
      (
        await database.toolInvocation.findUniqueOrThrow({
          where: { id: tool.id },
        })
      ).resultJson,
    ),
    outcome,
  );
  assert.equal(
    (await repository.getBrowserToolContext(value.id, tool.id)).name,
    "get_store_support",
  );
  const other = await repository.createToolInvocation(
    value.id,
    value.turn.assistantId,
    {
      providerCallId: randomUUID(),
      name: "discover_guides",
      arguments: { library: "curtains" },
    },
  );
  const otherClaim = executor();
  await repository.claimToolInvocation(value.id, other.id, otherClaim);
  await assert.rejects(
    repository.completeToolInvocation(value.id, other.id, otherClaim, {
      productIds: [],
      outcome: value.outcome,
    }),
    { status: 400 },
  );
});


test("Roman view switches persist independently of background navigation and reject mismatched views", async () => {
  const { id, tool } = await cartInvocation("show_view", { view: "cart" });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  await assert.rejects(repository.completeToolInvocation(id, tool.id, claim, {
    productIds: [], outcome: { status: "shown", view: "gallery" },
  }), { status: 400 });
  const result = { productIds: [], outcome: { status: "shown", view: "cart" } };
  await repository.completeToolInvocation(id, tool.id, claim, result);
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const stored = await database.toolInvocation.findUniqueOrThrow({ where: { id: tool.id } });
  assert.equal(stored.status, "complete");
  assert.deepEqual(JSON.parse(stored.resultJson), result.outcome);
  assert.equal((await repository.getSnapshot(id)).messages.some(row => row.parts.some(part => part.type === "navigation")), false);
});


async function savedProductChoice() {
  const { conversationId: id } = await repository.createConversation(
    shop,
    origin,
  );
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(),
    text: "Show roller blinds",
  });
  const productIds = ["gid://shopify/Product/123", "gid://shopify/Product/456"];
  await completedCatalog(id, turn.assistantId, productIds);
  const refs = [
    { id: productIds[0], title: "Green roller blind" },
    { id: productIds[1], title: "Blue roller blind" },
  ];
  await repository.finishTurn(id, turn.assistantId, terminalResponse({
    text: "Two options.",
    status: "complete",
    presentation: { callId: randomUUID(), productIds, productRefs: refs },
  }));
  const snapshot = await repository.getSnapshot(id);
  const carousel = snapshot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "products");
  return {
    id,
    snapshot,
    choice: {
      carouselId: carousel.invocationId,
      productId: productIds[0],
      title: "Green roller blind",
      productPath: "/products/green-roller",
    },
  };
}

test("text carousel selections persist exact reference data separately from their friendly customer message", async () => {
  const { id, choice } = await savedProductChoice();
  const input = {
    requestId: randomUUID(),
    text: "I'd like the Green roller blind.",
    productChoice: choice,
  };
  const toolsBefore = await database.toolInvocation.count();
  const turn = await repository.beginTurn(id, input);
  const selected = turn.snapshot.messages.find(
    (row) => row.requestId === input.requestId,
  );
  assert.deepEqual(selected.parts, [
    { type: "text", text: input.text, productChoice: choice },
  ]);
  assert.doesNotMatch(selected.parts[0].text, /\/products\//);
  const reference = turn.history.find((row) =>
    row.text.startsWith("Carousel choice"),
  );
  assert.equal(reference.role, "user");
  assert.ok(reference.text.includes(choice.productId));
  assert.ok(reference.text.includes(choice.productPath));
  assert.ok(reference.text.includes(choice.title));
  assert.deepEqual(JSON.parse(reference.text.slice("Carousel choice: ".length)), {
    productId: choice.productId, title: choice.title, productPath: choice.productPath,
  });
  assert.equal(
    await database.toolInvocation.count(),
    toolsBefore,
    "selection alone cannot execute navigation or cart actions",
  );
  assert.equal((await repository.beginTurn(id, input)).assistantId, null);
  for (const productChoice of [
    { ...choice, productPath: "/products/another-green-roller" },
    { ...choice, productId: "gid://shopify/Product/456" },
  ])
    await assert.rejects(
      repository.beginTurn(id, { ...input, productChoice }),
      { status: 400 },
    );
  await assert.rejects(
    repository.beginTurn(id, { requestId: input.requestId, text: input.text }),
    { status: 400 },
  );
  await repository.finishTurn(id, turn.assistantId, {
    status: "complete",
    text: "Ready to explore it.",
  });
  const restored = loadRepository();
  assert.equal((await restored.beginTurn(id, input)).assistantId, null);
  assert.deepEqual(
    (await restored.getSnapshot(id)).messages.find(
      (row) => row.requestId === input.requestId,
    ).parts,
    selected.parts,
  );
  assert.equal(
    await database.conversationMessage.count({
      where: { conversationId: id, requestId: input.requestId, role: "user" },
    }),
    1,
  );
});

test("text product choices reject unoffered products and forged metadata before creating a customer turn", async () => {
  const { id, choice, snapshot } = await savedProductChoice();
  const input = {
    requestId: randomUUID(),
    text: "I'd like the Green roller blind.",
    productChoice: choice,
  };
  for (const productChoice of [
    { ...choice, carouselId: randomUUID() },
    { ...choice, productId: "gid://shopify/Product/999" },
  ])
    await assert.rejects(
      repository.beginTurn(id, { ...input, productChoice }),
      { status: 409 },
    );
  await assert.rejects(
    repository.beginTurn(id, { ...input, text: "Add it to cart" }),
    { status: 400 },
  );
  await assert.rejects(
    repository.beginTurn(id, {
      ...input,
      productChoice: { ...choice, voiceId: randomUUID() },
    }),
    { status: 400 },
  );
  await assert.rejects(repository.beginTurn(id, input, randomUUID()), {
    status: 400,
  });
  const { conversationId: otherId } = await repository.createConversation(
    shop,
    origin,
  );
  await assert.rejects(repository.beginTurn(otherId, input), { status: 409 });
  assert.deepEqual(await repository.getSnapshot(id), snapshot);
});

test('checkout handoff is claimed once and persists only its bounded outcome', async()=>{
 for(const status of ['opened','blocked']){
 const {id,tool}=await cartInvocation('open_checkout',{});const claim=executor();
 assert.equal((await repository.claimToolInvocation(id,tool.id,claim)).claimed,true);
 assert.equal((await repository.claimToolInvocation(id,tool.id,executor())).claimed,false);
 const result={productIds:[],outcome:{status}};
 await repository.completeToolInvocation(id,tool.id,claim,result);await repository.completeToolInvocation(id,tool.id,claim,result);
 const stored=await database.toolInvocation.findUniqueOrThrow({where:{id:tool.id}});assert.deepEqual(JSON.parse(stored.resultJson),{status});
 const snapshot=await repository.getSnapshot(id);assert.equal(snapshot.status,'active');assert.equal(snapshot.messages.some(row=>row.parts.some(part=>part.type==='navigation')),false);
 }
});

// Build the two durable widget projections from one provider terminal call.
function terminalResponse(result) {
  const questionPresentation = result.questionPresentation ?? {
    callId: result.presentation.callId,
    question: "Which would you like to explore?",
    answers: ["Show more styles"],
  };
  return {
    ...result,
    presentation: { ...result.presentation, callId: questionPresentation.callId },
    questionPresentation,
  };
}

test("thirty catalog candidates ground a ten-card terminal response without sharing provider record IDs", async () => {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  const turn = await repository.beginTurn(id, {
    requestId: randomUUID(), text: "Show a range of blind categories.",
  });
  const candidates = Array.from({ length: 30 }, (_, i) => `gid://shopify/Product/${i + 1}`);
  await completedCatalog(id, turn.assistantId, candidates, {
    arguments: { queries: ["roller", "roman", "venetian"] },
  });
  const productIds = candidates.filter((_, i) => i % 3 === 2);
  const reply = terminalResponse({
    status: "complete", text: "Here are options from each style.",
    presentation: { callId: "x".repeat(200), productIds, productRefs: productRefs(productIds) },
  });
  assert.equal(await repository.finishTurn(id, turn.assistantId, reply), true);
  const records = await database.toolInvocation.findMany({
    where: { assistantId: turn.assistantId, name: { in: ["show_products", "ask_question"] } },
  });
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((row) => row.providerCallId)).size, 2);
  assert.ok(records.every((row) => row.providerCallId.length <= 200));
  assert.equal(records.find((row) => row.name === "ask_question").providerCallId, reply.questionPresentation.callId);
  const state = await loadRepository().getSnapshot(id);
  assert.deepEqual(state.messages[1].parts.map((part) => part.type), ["text", "products", "question"]);
  assert.deepEqual(state.messages[1].parts[1].productIds, productIds);
  assert.equal(await repository.finishTurn(id, turn.assistantId, reply), false);
});

test("terminal widgets reject separate ownership and roll back a provider-call collision", async () => {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  const turn = await repository.beginTurn(id, { requestId: randomUUID(), text: "Show styles." });
  const productIds = ["gid://shopify/Product/1"];
  const source = await completedCatalog(id, turn.assistantId, productIds);
  const reply = terminalResponse({
    status: "complete", text: "A recommendation.",
    presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
  });
  const before = await repository.getSnapshot(id);
  for (const questionPresentation of [undefined, { ...reply.questionPresentation, callId: randomUUID() }]) {
    await assert.rejects(repository.finishTurn(id, turn.assistantId, { ...reply, questionPresentation }), { status: 400 });
    assert.deepEqual(await repository.getSnapshot(id), before);
  }
  const savedSource = await database.toolInvocation.findUniqueOrThrow({ where: { id: source.id } });
  const colliding = terminalResponse({
    ...reply,
    questionPresentation: { ...reply.questionPresentation, callId: savedSource.providerCallId },
  });
  await assert.rejects(repository.finishTurn(id, turn.assistantId, colliding));
  assert.deepEqual(await repository.getSnapshot(id), before);
  assert.equal(await database.toolInvocation.count({ where: { name: "show_products" } }), 0);
});

test("a combined carousel and measurement rejects unverified guidance before writing any part", async () => {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  const turn = await repository.beginTurn(id, { requestId: randomUUID(), text: "Show and measure this blind." });
  const productIds = ["gid://shopify/Product/1"];
  await completedCatalog(id, turn.assistantId, productIds);
  const source = await guideLookup(id, turn.assistantId);
  const reply = terminalResponse({
    status: "complete", text: "Let's measure this blind.",
    presentation: { callId: randomUUID(), productIds, productRefs: productRefs(productIds) },
    questionPresentation: {
      callId: randomUUID(), question: "What is the width?", answers: [],
      measurement: { productPath: guidePath, label: "Width", unit: null, instructions: "Measure across the top." },
    },
  });
  const before = await repository.getSnapshot(id);
  await assert.rejects(repository.finishTurn(id, turn.assistantId, reply), { status: 400 });
  assert.deepEqual(await repository.getSnapshot(id), before);
  assert.equal(await database.toolInvocation.count({ where: { name: { in: ["show_products", "ask_measurement"] } } }), 0);
  reply.questionPresentation.sourceCallId = source.sourceCallId;
  assert.equal(await repository.finishTurn(id, turn.assistantId, reply), true);
  const restored = await loadRepository().getSnapshot(id);
  assert.deepEqual(restored.messages[1].parts.map((part) => part.type), ["text", "products", "question"]);
  assert.equal(restored.messages[1].parts.at(-1).measurement.unit, null);
});

test("search receipts retain partial outcomes and reject missing, mismatched or forged query provenance", async () => {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  const turn = await repository.beginTurn(id, { requestId: randomUUID(), text: "Compare styles." });
  const tool = await repository.createToolInvocation(id, turn.assistantId, {
    providerCallId: randomUUID(), name: "search_products", arguments: { queries: ["roller", "roman"] },
  });
  const claim = executor();
  await repository.claimToolInvocation(id, tool.id, claim);
  const productIds = ["gid://shopify/Product/1"];
  const queries = [
    { query: "roller", status: "succeeded", productIds },
    { query: "roman", status: "failed", productIds: [], error: "timeout" },
  ];
  for (const catalogQueries of [
    undefined,
    [...queries].reverse(),
    [{ ...queries[0], query: "venetian" }, queries[1]],
    [{ ...queries[0], productIds: [] }, queries[1]],
    [queries[0], { ...queries[1], productIds }],
    [queries[0], { ...queries[1], error: "private server text" }],
  ]) {
    await assert.rejects(repository.completeToolInvocation(id, tool.id, claim, { productIds, catalogQueries }), { status: 400 });
    assert.equal((await database.toolInvocation.findUniqueOrThrow({ where: { id: tool.id } })).status, "running");
  }
  const result = { productIds, catalogQueries: queries };
  await repository.completeToolInvocation(id, tool.id, claim, result);
  await repository.completeToolInvocation(id, tool.id, claim, result);
  const saved = await database.toolInvocation.findUniqueOrThrow({ where: { id: tool.id } });
  assert.deepEqual(JSON.parse(saved.resultJson), { queries });
  assert.deepEqual(JSON.parse(saved.productIdsJson), productIds);
});

test("history supplies application facts once while preserving corrections, earlier questions and page transitions", async () => {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  await repository.appendJourney(id, pageView({ path: "/products/original", title: "Original blind" }));
  await repository.appendJourney(id, pageView({ path: "/products/original", title: "Original blind" }));
  const first = await repository.beginTurn(id, { requestId: randomUUID(), text: "Find a blind for my bedroom." });
  const question = { question: "What matters most?", answers: ["Privacy", "Blackout"] };
  await repository.finishTurn(id, first.assistantId, {
    status: "complete", text: "Let's narrow it down.",
    questionPresentation: { callId: randomUUID(), ...question },
  });
  const waiting = await repository.getModelHistory(id);
  assert.equal(waiting.filter((row) => row.source === "application_state").length, 1);
  assert.equal(waiting.filter((row) => row.text.includes(question.question)).length, 1);
  assert.equal(waiting.filter((row) => row.text.includes("/products/original")).length, 1);
  assert.deepEqual(waiting.at(-1).pendingQuestion, question);
  await repository.appendJourney(id, pageView({ path: "/products/other", title: "Different blind" }));
  await repository.appendJourney(id, pageView({ path: "/products/other", title: "Different blind" }));
  const next = await repository.beginTurn(id, { requestId: randomUUID(), text: "Actually the kitchen, and I need no drilling." });
  assert.ok(next.history.some((row) => row.text === "Find a blind for my bedroom."));
  assert.ok(next.history.some((row) => row.text === "Let's narrow it down."));
  assert.ok(next.history.some((row) => row.text === "Actually the kitchen, and I need no drilling."));
  assert.ok(next.history.some((row) => row.source === "roman_question" && row.text.includes(question.question)));
  const state = JSON.parse(next.history.at(-1).text.slice("Application state: ".length));
  assert.equal(state.activeBlind, null, "a hidden PDP is not a customer selection");
  assert.equal(state.backgroundPage.path, "/products/other");
  assert.equal(state.pendingQuestion, null);
  assert.equal(next.history.filter((row) => row.text.includes("/products/original")).length, 1);
  assert.equal(next.history.filter((row) => row.text.includes("/products/other")).length, 1);
});

async function longCaptionHistory({ memo = false } = {}) {
  const { conversationId: id } = await repository.createConversation(shop, origin);
  const voiceId = randomUUID();
  await database.voiceSession.create({ data: {
    id: voiceId, conversationId: id, clientId: randomUUID(), status: "closed",
    leaseExpiresAt: new Date(), closedAt: new Date(),
  } });
  await database.voiceTranscript.createMany({ data: Array.from({ length: 5000 }, (_, sequence) => ({
    id: randomUUID(), voiceId, conversationId: id, providerEventId: `history-${sequence}`,
    sequence, role: sequence % 2 ? "assistant" : "user",
    text: `Synthetic original ${sequence}: ${"historical evidence ".repeat(12)}`,
    startMs: sequence * 4000, endMs: sequence * 4000 + 500,
  })) });
  await database.conversation.update({ where: { id }, data: {
    nextSequence: 5000,
    ...(memo ? { memoJson: JSON.stringify({ windows: "Kitchen blind unfinished; bedroom follows. No new action is authorized." }) } : {}),
  } });
  await database.conversationContext.create({ data: {
    conversationId: id, model: "gpt-6-luna", throughSequence: 4900,
    inputJson: JSON.stringify([{ type: "compaction", encrypted_content: "primary-only-encrypted-state" }]),
  } });
  return { id, voiceId };
}

test("post-compaction turns read bounded caption tails and load another model's raw history only on demand", async () => {
  const { id, voiceId } = await longCaptionHistory();
  queries.length = 0;
  queryDetails.length = 0;
  const turn = await repository.beginTurn(id, { requestId: randomUUID(), text: "Continue with the kitchen" });
  const captions = queryDetails.filter(({ query }) => /^SELECT/.test(query) && /FROM .*VoiceTranscript/.test(query));
  assert.ok(captions.length > 0);
  assert.ok(captions.every(({ query, params }) =>
    (params.at(-2) > 0 && params.at(-2) <= 256) ||
    (/sequence[`"] >/.test(query) && params.includes(4900))), "mutation reads have a positive row limit; model reads start at their saved checkpoint");
  assert.ok(turn.history.filter((item) => item.sequence !== undefined).every((item) => item.sequence > 4900));
  queries.length = 0;
  assert.deepEqual(await turn.memory.historyForModel("gpt-6-luna"), turn.history);
  assert.equal(queries.length, 0, "primary history was already read inside the turn transaction");
  await database.voiceTranscript.create({ data: {
    id: randomUUID(), voiceId, conversationId: id, providerEventId: "concurrent-later-caption",
    sequence: 5002, role: "user", text: "A later correction must not enter the earlier checkpoint", startMs: 21_000_000, endMs: 21_000_500,
  } });
  queries.length = 0;
  const fallback = await turn.memory.historyForModel("gpt-5.6-luna");
  assert.ok(fallback.some((item) => item.text.startsWith("Synthetic original 0:")), "empty memory cannot silently discard unsummarized history");
  assert.ok(!fallback.some((item) => item.text.includes("later correction")), "the callback pins the turn's inclusive source frontier");
  assert.ok(queries.some((query) => /VoiceTranscript/.test(query) && /sequence[`"] >/.test(query) && /sequence[`"] <=/.test(query)), queries.join("\n"));
  queries.length = 0;
  await repository.finishTurn(id, turn.assistantId, { status: "complete", text: "The current question follows." });
  assert.ok(queries.filter((query) => /^SELECT/.test(query) && /FROM .*VoiceTranscript/.test(query)).every((query) => /LIMIT/.test(query)), "finishing retains exact durable sources without rereading all captions");
});

test("cold fallback uses notes and explicitly bounded historical evidence; voice startup never reads the full caption log", async () => {
  const { id } = await longCaptionHistory({ memo: true });
  const turn = await repository.beginTurn(id, { requestId: randomUUID(), text: "Continue with the kitchen" });
  queries.length = 0;
  const fallback = await turn.memory.historyForModel("gpt-5.6-luna");
  assert.match(fallback[0].text, /Historical context boundary.*recall_history/);
  assert.ok(fallback.some((item) => item.source === "memory" && item.text.includes("bedroom")));
  assert.ok(fallback.filter((item) => item.sequence !== undefined).every((item) => item.sequence > turn.memory.throughSequence - 120));
  assert.ok(!JSON.stringify(fallback).includes("primary-only-encrypted-state"));
  assert.ok(fallback.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0) < 50_000);
  assert.ok(queries.filter((query) => /FROM .*VoiceTranscript/.test(query)).every((query) => /sequence[`"] >/.test(query)), queries.join("\n"));
  await repository.finishTurn(id, turn.assistantId, { status: "complete", text: "Continue." });
  queries.length = 0;
  queryDetails.length = 0;
  const startup = await repository.getVoiceStartupContext(id);
  assert.match(startup.history[0].text, /Context boundary/);
  assert.ok(startup.history.some((item) => item.source === "memory" && item.text.includes("bedroom")));
  assert.ok(!startup.history.some((item) => item.text.startsWith("Synthetic original 0:")));
  const startupCaptions = queryDetails.filter(({ query }) => /^SELECT/.test(query) && /FROM .*VoiceTranscript/.test(query));
  assert.equal(startupCaptions.length, 2, "latest customer context plus one bounded startup page");
  assert.ok(startupCaptions.every(({ params }) => params.at(-2) > 0 && params.at(-2) <= 256));
});
