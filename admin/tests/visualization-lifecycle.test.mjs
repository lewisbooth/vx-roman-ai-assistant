import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { migrateTestDatabase } from "./helpers/database.mjs";
import sharp from "sharp";

// Real SQL transactions and private file I/O; only remote image dependencies are
// replaced. The provider stub still must persist a physical receipt first.
const bundle = await build({
  stdin: {
    contents: `export * from './admin/visualizations/repository.server';
      export * from './admin/visualizations/jobs.server';
      export * from './admin/visualizations/auth.server';
      export * from './admin/visualizations/storage.server';
      export { MODEL_PRICES } from './admin/pricing/rates.server';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client", "sharp"],
  plugins: [
    {
      name: "remote-image-boundary",
      setup(builder) {
        // Advisory photo analysis has its own durable lifecycle tests. Keep
        // these generation tests independent of background model requests.
        builder.onLoad({ filter: /visualizations[\\/]analysis\.server\.ts$/ }, () => ({
          contents: `export const kickRoomAnalysis=()=>{};`,
          loader: "ts",
        }));
        builder.onLoad(
          { filter: /visualizations[\\/]product-images\.server\.ts$/ },
          () => ({
            contents: `export const fetchProductReferences = (...args) => global.__romanImageTest.references(...args);`,
            loader: "ts",
          }),
        );
        builder.onLoad(
          { filter: /visualizations[\\/]provider\.server\.ts$/ },
          () => ({
            contents: `export const PRIMARY_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
          export const FALLBACK_IMAGE_MODEL = 'gpt-image-2.5-flare';
          export const generateVisualizationAttempt = (...args) => global.__romanImageTest.provider(...args);`,
            loader: "ts",
          }),
        );
      },
    },
  ],
});
const require = createRequire(import.meta.url);
const previousGlobal = global.prismaGlobal;
const previousRemote = global.__romanImageTest;
const names = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "ROMAN_MEDIA_ROOT",
  "ROMAN_VISUALIZATIONS_ENABLED",
  "ROMAN_VISUALIZATIONS_SHOPS",
  "OPENAI_API_KEY",
];
const previousEnvironment = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);
const shop = "hd-dev-single.myshopify.com";
const origin = "https://shopify-single-dev.hdecom.com";
const productPath = "/products/test-roman-blind";
const references = [
  {
    url: `${origin}/cdn/shop/files/blind.jpg`,
    role: "installation",
    alt: "Test blind",
  },
];
let directory, database, api, rawPhoto, calls;
const load = () => {
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  return module.exports;
};
const errorStatus = (status) => (error) => error.status === status;
const gate = () => {
  let resolve;
  const promise = new Promise((callback) => {
    resolve = callback;
  });
  return { promise, resolve };
};
async function settled(jobId) {
  for (let n = 0; n < 300; n++) {
    const job = await database.visualizationJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    if (
      ![
        "awaiting_product",
        "preparing_assets",
        "generating",
        "saving",
      ].includes(job.status)
    ) {
      // Let task-owned cleanup finish before resetting fixture state.
      await pause(25);
      return job;
    }
    await pause(10);
  }
  throw new Error("Image task did not settle");
}
function receipt(input, outcome = "succeeded", fallbackEligible = false) {
  return {
    model: input.model,
    outcome,
    providerRequestId: "provider-test-request",
    httpStatus: outcome === "succeeded" ? 200 : 503,
    errorCode: outcome === "succeeded" ? null : "server_is_overloaded",
    usage:
      outcome === "succeeded"
        ? {
            textInputTokens: 100,
            textCachedInputTokens: 0,
            imageInputTokens: 200,
            imageCachedInputTokens: 0,
            imageOutputTokens: 1000,
          }
        : {
            textInputTokens: null,
            textCachedInputTokens: null,
            imageInputTokens: null,
            imageCachedInputTokens: null,
            imageOutputTokens: null,
          },
    usageValid: true,
    usageEvidenceJson: "{}",
    fallbackEligible,
    retryAfterSeconds: null,
  };
}
async function success(input, options) {
  assert.equal(options.apiKey, "test-main-key", "generation uses the shared server-only OpenAI key");
  calls.push(input);
  const physical = receipt(input);
  await input.onReceipt(physical);
  const bytes = await sharp({
    create: {
      width: input.room.width,
      height: input.room.height,
      channels: 3,
      background: "#d7c3ad",
    },
  })
    .jpeg()
    .toBuffer();
  return {
    receipt: physical,
    image: {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: input.room.width,
      height: input.room.height,
    },
    imageErrorCode: null,
  };
}
async function fixture(pageKind = "navigation") {
  const owner = await database.galleryOwner.create({
    data: {
      id: randomUUID(),
      shop,
      origin,
      tokenHash: randomBytes(32).toString("hex"),
    },
  });
  const conversation = await database.conversation.create({
    data: {
      id: randomUUID(),
      shop,
      origin,
      credentialHash: randomBytes(32).toString("hex"),
      credentialExpiresAt: new Date(Date.now() + 3_600_000),
      galleryOwnerId: owner.id,
      nextSequence: 1,
    },
  });
  await database.conversationMessage.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      requestId: randomUUID(),
      sequence: 0,
      role: "context",
      status: "complete",
      partsJson: JSON.stringify([
        {
          type: pageKind,
          version: 1,
          ...(pageKind === "navigation"
            ? { invocationId: randomUUID() }
            : { occurredAt: new Date().toISOString() }),
          path: productPath,
          title: "Test Roman Blind",
        },
      ]),
    },
  });
  const upload = {
    requestId: randomUUID(),
    title: "Kitchen",
    cleanup: true,
    consent: true,
    bytes: rawPhoto,
    contentType: "image/jpeg",
  };
  const photo = await api.saveWindow(owner, conversation.id, upload);
  const input = {
    requestId: randomUUID(),
    windowId: photo.id,
    productPath,
    cleanup: true,
  };
  return { owner, conversation, photo, upload, input };
}
async function prepare(fixture, overrides = {}) {
  const job = await api.startVisualization(
    fixture.owner,
    fixture.conversation.id,
    fixture.input,
  );
  const { claim } = await api.claimPreparation(
    fixture.owner.id,
    job.id,
    randomUUID(),
  );
  assert.ok(claim);
  await api.completePreparation(fixture.owner, job.id, claim.token, {
    productPath,
    references,
    ...overrides,
  });
  return job;
}

before(async () => {
  directory = await mkdtemp(
    path.join(tmpdir(), "roman-visualization-lifecycle-"),
  );
  const databaseUrl = `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`;
  await migrateTestDatabase(databaseUrl);
  database = new PrismaClient({
    datasourceUrl: databaseUrl,
  });
  global.prismaGlobal = database;
  Object.assign(process.env, {
    SHOPIFY_API_KEY: "test-shopify-api-key",
    SHOPIFY_API_SECRET: "test-shopify-api-secret",
    SHOPIFY_APP_URL: "https://roman.example.test",
    SCOPES: "write_app_proxy",
    ROMAN_MEDIA_ROOT: path.join(directory, "media"),
    ROMAN_VISUALIZATIONS_ENABLED: "true",
    ROMAN_VISUALIZATIONS_SHOPS: "",
    OPENAI_API_KEY: "test-main-key",
  });
  rawPhoto = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#cab79d" },
  })
    .jpeg()
    .toBuffer();
});
beforeEach(async () => {
  await database.imageGenerationAttempt.deleteMany();
  await database.visualizationJob.deleteMany();
  await database.windowPhoto.deleteMany();
  await database.conversation.deleteMany();
  await database.galleryOwner.deleteMany();
  await database.session.deleteMany();
  process.env.ROMAN_MEDIA_ROOT = path.join(directory, "media");
  process.env.ROMAN_VISUALIZATIONS_ENABLED = "true";
  process.env.ROMAN_VISUALIZATIONS_SHOPS = "";
  await rm(process.env.ROMAN_MEDIA_ROOT, { recursive: true, force: true });
  calls = [];
  global.__romanImageTest = {
    references: async (refs) =>
      refs.map((ref) => ({
        ...ref,
        image: {
          bytes: rawPhoto,
          width: 32,
          height: 24,
          sha256: createHash("sha256").update(rawPhoto).digest("hex"),
        },
      })),
    provider: success,
  };
  api = load();
  await api.recoverImageJobs();
});
after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
  global.__romanImageTest = previousRemote;
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("window consent, owner isolation, idempotency, rename revisions and End Chat durability", async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(
    api.saveWindow(f.owner, f.conversation.id, {
      ...f.upload,
      requestId: randomUUID(),
      consent: false,
    }),
    errorStatus(400),
  );
  assert.deepEqual(
    await api.saveWindow(f.owner, f.conversation.id, f.upload),
    f.photo,
  );
  await assert.rejects(
    api.saveWindow(f.owner, f.conversation.id, {
      ...f.upload,
      title: "Changed",
    }),
    errorStatus(409),
  );
  await assert.rejects(
    api.saveWindow(other.owner, f.conversation.id, {
      ...f.upload,
      requestId: randomUUID(),
    }),
    errorStatus(409),
  );
  await assert.rejects(
    api.readGalleryAsset(other.owner.id, "window", f.photo.id),
    errorStatus(404),
  );
  await assert.rejects(
    api.renameWindow(other.owner.id, f.photo.id, "Renamed", 1),
    errorStatus(404),
  );
  await assert.rejects(
    api.renameWindow(f.owner.id, f.photo.id, "Renamed", 2),
    errorStatus(409),
  );
  const renamed = await api.renameWindow(
    f.owner.id,
    f.photo.id,
    "Kitchen window",
    1,
  );
  assert.equal(renamed.revision, 2);
  assert.equal(
    (
      await database.conversationMessage.findMany({
        where: {
          conversationId: f.conversation.id,
          partsJson: { contains: '"kind":"renamed"' },
        },
      })
    ).length,
    1,
  );
  await database.conversation.update({
    where: { id: f.conversation.id },
    data: { status: "ended", selectedWindowPhotoId: null },
  });
  assert.equal(
    (await api.gallerySnapshot(f.owner.id)).windows[0].title,
    "Kitchen window",
  );
  assert.ok(
    (await api.readGalleryAsset(f.owner.id, "window", f.photo.id)).bytes
      .length > 0,
  );
  await assert.rejects(
    api.saveWindow(f.owner, f.conversation.id, {
      ...f.upload,
      requestId: randomUUID(),
    }),
    errorStatus(409),
  );
});

test("selecting an already uploaded window does not duplicate its chat card", async () => {
  const f = await fixture();
  const countCards = (conversationId) => database.conversationMessage.count({
    where: { conversationId, partsJson: { contains: '"kind":"window"' } },
  });
  const initial = await database.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
  assert.equal(initial.selectedWindowPhotoId, f.photo.id);
  assert.equal(await countCards(f.conversation.id), 1);
  assert.deepEqual(await api.selectWindow(f.owner.id, f.conversation.id, f.photo.id), f.photo);
  assert.deepEqual(await api.selectWindow(f.owner.id, f.conversation.id, f.photo.id), f.photo);
  const selected = await database.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
  assert.equal(await countCards(f.conversation.id), 1);
  assert.equal(selected.revision, initial.revision);
  assert.equal(selected.nextSequence, initial.nextSequence);
  await assert.rejects(api.selectWindow(randomUUID(), f.conversation.id, f.photo.id), errorStatus(404));
  await database.conversation.update({ where: { id: f.conversation.id }, data: { status: "ended" } });
  await assert.rejects(api.selectWindow(f.owner.id, f.conversation.id, f.photo.id), errorStatus(409));
  const next = await database.conversation.create({ data: {
    id: randomUUID(), shop, origin, credentialHash: randomBytes(32).toString("hex"),
    credentialExpiresAt: new Date(Date.now() + 3_600_000), galleryOwnerId: f.owner.id,
  } });
  await api.selectWindow(f.owner.id, next.id, f.photo.id);
  await api.selectWindow(f.owner.id, next.id, f.photo.id);
  assert.equal(await countCards(next.id), 1);
});

test("generation needs an actively selected blind, admission is idempotent, and claims expire atomically", async () => {
  const f = await fixture("page_view");
  await assert.rejects(
    api.startVisualization(f.owner, f.conversation.id, f.input),
    errorStatus(409),
  );
  await database.conversationMessage.updateMany({
    where: { conversationId: f.conversation.id, sequence: 0 },
    data: {
      partsJson: JSON.stringify([
        {
          type: "navigation",
          version: 1,
          invocationId: randomUUID(),
          path: productPath,
          title: "Test Roman Blind",
        },
      ]),
    },
  });
  const job = await api.startVisualization(f.owner, f.conversation.id, f.input);
  assert.equal(
    (await api.startVisualization(f.owner, f.conversation.id, f.input)).id,
    job.id,
  );
  assert.equal((await api.startVisualization(f.owner, f.conversation.id, {
    ...f.input, cleanup: false,
  })).id, job.id, "the retired cleanup choice cannot change an existing request");
  await assert.rejects(api.startVisualization(f.owner, f.conversation.id, {
    ...f.input, targetDescription: "A different opening",
  }), errorStatus(409));
  assert.equal(await database.visualizationJob.count(), 1);
  assert.equal(
    await database.conversationMessage.count({ where: { id: job.id } }),
    1,
  );
  assert.equal(calls.length, 0);
  const firstClient = randomUUID();
  const { claim } = await api.claimPreparation(f.owner.id, job.id, firstClient);
  assert.ok(claim);
  assert.equal(
    (await api.claimPreparation(f.owner.id, job.id, randomUUID())).claim,
    null,
  );
  await database.visualizationJob.update({
    where: { id: job.id },
    data: { claimExpiresAt: new Date(Date.now() - 1) },
  });
  await assert.rejects(
    api.completePreparation(f.owner, job.id, claim.token, {
      productPath,
      references,
    }),
    errorStatus(409),
  );
  assert.equal(calls.length, 0);
});

test("new uploads and previews include cleanup while historical false records replay unchanged", async () => {
  const f = await fixture();
  const upload = {...f.upload, requestId: randomUUID(), cleanup: false};
  const photo = await api.saveWindow(f.owner, f.conversation.id, upload);
  const saved = await database.windowPhoto.findUniqueOrThrow({where: {id: photo.id}});
  assert.equal(saved.cleanup, true);
  assert.equal((await api.saveWindow(f.owner, f.conversation.id, {...upload, cleanup: true})).id, photo.id);

  const historicalUploadHash = api.requestHash({
    title: upload.title, cleanup: false,
    sha256: createHash("sha256").update(upload.bytes).digest("hex"),
    consent: saved.consentVersion,
  });
  await database.windowPhoto.update({where: {id: photo.id}, data: {cleanup: false, requestHash: historicalUploadHash}});
  assert.equal((await api.saveWindow(f.owner, f.conversation.id, upload)).cleanup, false);
  assert.equal((await database.windowPhoto.findUniqueOrThrow({where: {id: photo.id}})).cleanup, false);

  const input = {...f.input, windowId: photo.id, cleanup: false};
  const job = await api.startVisualization(f.owner, f.conversation.id, input);
  assert.equal((await database.visualizationJob.findUniqueOrThrow({where: {id: job.id}})).cleanup, true);
  const historicalJobHash = api.requestHash({
    windowId: photo.id, productPath: input.productPath, cleanup: false, targetDescription: null,
  });
  await database.visualizationJob.update({where: {id: job.id}, data: {cleanup: false, requestHash: historicalJobHash}});
  assert.equal((await api.startVisualization(f.owner, f.conversation.id, input)).id, job.id);
  assert.equal((await database.visualizationJob.findUniqueOrThrow({where: {id: job.id}})).cleanup, false);
  assert.equal(await database.visualizationJob.count(), 1);
  assert.equal(calls.length, 0, "a replay never dispatches another image request");
});

test("one paid receipt, one immutable result, no repeat generation and linked deletion", async () => {
  const f = await fixture();
  const job = await prepare(f);
  const completed = await settled(job.id);
  assert.equal(completed.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(completed.resultKey, `${job.id}.jpg`);
  assert.equal(completed.reservedBytes, 0);
  const attempts = await database.imageGenerationAttempt.findMany();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "succeeded");
  assert.equal(attempts[0].imageOutputTokens, 1000);
  assert.ok(attempts[0].costUsd > 0);
  assert.equal(attempts[0].costEvidence, "reported");
  assert.ok(JSON.parse(attempts[0].rateSnapshotJson).id);
  const result = await api.readGalleryAsset(f.owner.id, "result", job.id);
  assert.equal(result.bytes.length, completed.resultBytes);
  assert.equal(
    (await api.startVisualization(f.owner, f.conversation.id, f.input)).id,
    job.id,
  );
  assert.equal(
    (await api.completePreparation(f.owner, job.id, "expired-token")).status,
    "completed",
  );
  assert.equal(calls.length, 1);
  await api.deleteWindow(f.owner.id, f.photo.id);
  await assert.rejects(
    api.readGalleryAsset(f.owner.id, "result", job.id),
    errorStatus(404),
  );
  assert.equal(
    (
      await database.windowPhoto.findUniqueOrThrow({
        where: { id: f.photo.id },
      })
    ).bytes,
    0,
  );
  assert.equal(
    (
      await database.visualizationJob.findUniqueOrThrow({
        where: { id: job.id },
      })
    ).resultBytes,
    0,
  );
  assert.equal(await database.imageGenerationAttempt.count(), 1);
});

test("eligible Flare continuation keeps one job and two physical receipts, unknown attempts do not retry", async () => {
  const f = await fixture();
  global.__romanImageTest.provider = async (input, options) => {
    if (input.model.endsWith("sunburst")) {
      calls.push(input);
      const physical = receipt(input, "failed", true);
      await input.onReceipt(physical);
      return { receipt: physical, image: null, imageErrorCode: null };
    }
    return success(input, options);
  };
  const job = await prepare(f);
  assert.equal((await settled(job.id)).status, "completed");
  assert.deepEqual(
    calls.map((call) => call.model),
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
  );
  assert.equal(await database.visualizationJob.count(), 1);
  assert.equal(await database.imageGenerationAttempt.count(), 2);
  assert.equal(calls[0].room.sha256, calls[1].room.sha256);
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  global.__romanImageTest.provider = async (input, options) => {
    calls.push(input);
    const physical = receipt(input, "unknown", false);
    await input.onReceipt(physical);
    return { receipt: physical, image: null, imageErrorCode: null };
  };
  f.input.requestId = randomUUID();
  const uncertain = await prepare(f);
  assert.equal((await settled(uncertain.id)).status, "unknown");
  assert.equal(calls.length, 3);
});

test("missing configured pricing rejects dispatch before creating a provider attempt", async () => {
  const f = await fixture();
  const rates = api.MODEL_PRICES.splice(0);
  try {
    const job = await prepare(f);
    assert.equal((await settled(job.id)).status, "failed");
    assert.equal(calls.length, 0);
    assert.equal(await database.imageGenerationAttempt.count(), 0);
  } finally {
    api.MODEL_PRICES.push(...rates);
  }
});

test("deletion while the provider is running cannot publish late pixels or release in-flight capacity", async () => {
  const f = await fixture();
  const dispatched = gate(),
    release = gate();
  global.__romanImageTest.provider = async (input, options) => {
    const result = await success(input, options);
    dispatched.resolve();
    await release.promise;
    return result;
  };
  const job = await prepare(f);
  await dispatched.promise;
  await api.deleteWindow(f.owner.id, f.photo.id);
  const deleted = await database.visualizationJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(deleted.status, "generating");
  assert.ok(deleted.reservedBytes > 0);
  await assert.rejects(
    api.readGalleryAsset(f.owner.id, "before", job.id),
    errorStatus(404),
  );
  release.resolve();
  const cancelled = await settled(job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.reservedBytes, 0);
  assert.equal(cancelled.resultKey, null);
  assert.equal(
    (await database.imageGenerationAttempt.findFirstOrThrow()).status,
    "succeeded",
  );
  assert.equal(
    (await api.gallerySnapshot(f.owner.id)).visualizations.length,
    0,
  );
});

test("selected-product previews include older results and exclude other owners, products and unavailable images", async () => {
  const f = await fixture();
  const base = await api.startVisualization(f.owner, f.conversation.id, f.input);
  const original = await database.visualizationJob.findUniqueOrThrow({ where: { id: base.id } });
  const clone = (overrides = {}) => {
    const id = randomUUID();
    return database.visualizationJob.create({ data: {
      ...original, id, requestId: id, status: "completed", resultKey: `${id}.jpg`,
      createdAt: new Date(), ...overrides,
    } });
  };
  const older = await clone({ createdAt: new Date("2025-01-01T00:00:00Z") });
  for (let i = 0; i < 25; i++) await clone({ productPath: "/products/another-blind" });
  const newer = await clone();
  await clone({ deletedAt: new Date() });
  await clone({ status: "generating" });
  await clone({ resultKey: null });
  const otherOwner = await fixture();
  await database.visualizationJob.update({ where: { id: base.id }, data: { status: "failed" } });
  await database.visualizationJob.create({ data: {
    ...original, id: randomUUID(), ownerId: otherOwner.owner.id,
    windowId: otherOwner.photo.id, conversationId: otherOwner.conversation.id,
    requestId: randomUUID(), status: "completed", resultKey: "other-owner.jpg",
  } });
  const firstPage = await api.gallerySnapshot(f.owner.id);
  assert.ok(!firstPage.visualizations.some((job) => job.id === older.id));
  const selected = await api.productVisualizations(f.owner.id, productPath);
  assert.equal(selected.productPath, productPath);
  assert.deepEqual(selected.visualizations.map((job) => job.id), [newer.id, older.id]);
  assert.ok(selected.visualizations.every((job) => job.resultAvailable));
  assert.ok(!JSON.stringify(selected).includes("resultKey"));
  for (const invalid of [null, "https://other.example/products/test-roman-blind", "/products/test-roman-blind?x=1", "/products/" + "a".repeat(256)])
    await assert.rejects(api.productVisualizations(f.owner.id, invalid), errorStatus(400));
  await database.windowPhoto.update({ where: { id: f.photo.id }, data: { deletedAt: new Date() } });
  assert.deepEqual((await api.productVisualizations(f.owner.id, productPath)).visualizations, []);
  assert.equal(calls.length, 0);
});

test("storage failure after a known successful receipt remains failed with the provider cost intact", async () => {
  const f = await fixture();
  const brokenRoot = path.join(directory, "not-a-directory");
  await writeFile(brokenRoot, "not a folder");
  global.__romanImageTest.provider = async (input, options) => {
    const result = await success(input, options);
    process.env.ROMAN_MEDIA_ROOT = brokenRoot;
    return result;
  };
  const job = await prepare(f);
  try {
    const failed = await settled(job.id);
    assert.equal(failed.status, "failed");
    const attempt = await database.imageGenerationAttempt.findFirstOrThrow();
    assert.equal(attempt.status, "succeeded");
    assert.ok(attempt.costUsd > 0);
    assert.equal(calls.length, 1);
  } finally {
    process.env.ROMAN_MEDIA_ROOT = path.join(directory, "media");
    await api.cleanupDeletedMedia();
    await rm(brokenRoot);
  }
});

test("restart recovery preserves ambiguous receipts, reclaims durable file intent and never regenerates", async () => {
  const f = await fixture();
  const job = await api.startVisualization(f.owner, f.conversation.id, f.input);
  const key = `${job.id}.jpg`;
  await api.writeAsset(rawPhoto, key);
  await database.visualizationJob.update({
    where: { id: job.id },
    data: { status: "saving", resultKey: key, resultBytes: rawPhoto.length },
  });
  await database.imageGenerationAttempt.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      conversationId: f.conversation.id,
      ordinal: 1,
      model: "gpt-image-2.5-sunburst",
      status: "dispatched",
      rateSnapshotJson: "null",
    },
  });
  const pendingId = randomUUID();
  await api.writeAsset(rawPhoto, `${pendingId}.jpg`);
  await database.windowPhoto.create({
    data: {
      id: pendingId,
      ownerId: f.owner.id,
      conversationId: f.conversation.id,
      requestId: randomUUID(),
      requestHash: "test-hash",
      title: "Interrupted upload",
      assetKey: `${pendingId}.jpg`,
      sha256: "test-sha",
      width: 32,
      height: 24,
      bytes: rawPhoto.length,
      cleanup: true,
      consentVersion: "roman-window-photo-v1",
      consentAt: new Date(),
    },
  });
  const preparation = await fixture();
  const preparing = await api.startVisualization(
    preparation.owner,
    preparation.conversation.id,
    preparation.input,
  );
  await database.visualizationJob.update({
    where: { id: preparing.id },
    data: { status: "preparing_assets" },
  });
  api = load();
  await api.recoverImageJobs();
  const recovered = await database.visualizationJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.reservedBytes, 0);
  assert.equal(recovered.resultBytes, 0);
  assert.equal(
    (await database.imageGenerationAttempt.findFirstOrThrow()).status,
    "unknown",
  );
  const upload = await database.windowPhoto.findUniqueOrThrow({
    where: { id: pendingId },
  });
  assert.ok(upload.deletedAt);
  assert.equal(upload.uploadStatus, "failed");
  assert.equal(upload.bytes, 0);
  const interruptedPreparation =
    await database.visualizationJob.findUniqueOrThrow({
      where: { id: preparing.id },
    });
  assert.equal(interruptedPreparation.status, "failed");
  assert.equal(interruptedPreparation.reservedBytes, 0);
  assert.equal(calls.length, 0);
  await assert.rejects(api.readAsset(key), (error) => error.code === "ENOENT");
});

test("failed physical cleanup keeps bytes charged until a bounded retry actually removes files", async () => {
  const f = await fixture();
  const stored = await database.windowPhoto.findUniqueOrThrow({
    where: { id: f.photo.id },
  });
  const assetPath = path.join(process.env.ROMAN_MEDIA_ROOT, stored.assetKey);
  await rm(assetPath);
  await mkdir(assetPath);
  await api.deleteWindow(f.owner.id, f.photo.id);
  assert.equal(
    (
      await database.windowPhoto.findUniqueOrThrow({
        where: { id: f.photo.id },
      })
    ).bytes,
    stored.bytes,
  );
  await database.windowPhoto.update({
    where: { id: f.photo.id },
    data: { bytes: 500 * 1024 * 1024 },
  });
  await assert.rejects(
    database.$transaction((tx) => api.galleryCapacity(tx, f.owner, 1)),
    errorStatus(429),
  );
  await rm(assetPath, { recursive: true });
  await api.cleanupDeletedMedia();
  assert.equal(
    (
      await database.windowPhoto.findUniqueOrThrow({
        where: { id: f.photo.id },
      })
    ).bytes,
    0,
  );
  await database.$transaction((tx) => api.galleryCapacity(tx, f.owner, 1));
});

test("appearance is frozen from verified selected options without another tool call", async () => {
  const f = await fixture();
  const assistantId = randomUUID();
  await database.conversationMessage.create({
    data: {
      id: assistantId,
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      sequence: 2,
      role: "assistant",
      status: "complete",
      partsJson: "[]",
    },
  });
  await database.conversation.update({
    where: { id: f.conversation.id },
    data: { nextSequence: 3 },
  });
  const configuration = {
    status: "available",
    productPath,
    configurationId: randomUUID(),
    measurements: null,
    message: "Current native options",
    controls: [
      {
        id: "c0",
        label: "Lining",
        kind: "select",
        options: [
          {
            id: "o0",
            label: "Light filtering",
            selected: false,
            available: true,
          },
          { id: "o1", label: "Blackout", selected: true, available: true },
        ],
      },
      {
        id: "c1",
        label: "Control Options",
        kind: "radio",
        options: [
          {
            id: "o0",
            label: "Electric SmartView",
            selected: true,
            available: true,
          },
        ],
      },
      {
        id: "c2",
        label: "14 Channel Remote Control",
        kind: "select",
        options: [
          {
            id: "o0",
            label: "Remote selected",
            selected: true,
            available: true,
          },
        ],
      },
      {
        id: "c3",
        label: "Guarantee a Perfect Fit",
        kind: "radio",
        purpose: "measurement_guarantee",
        description: "Optional replacement cover",
        options: [
          {
            id: "o0",
            label: "Do not insure",
            selected: false,
            available: true,
          },
          {
            id: "o1",
            label: "Insure measurements",
            selected: true,
            available: true,
          },
        ],
      },
    ],
  };
  const tool = await database.toolInvocation.create({
    data: {
      id: randomUUID(),
      conversationId: f.conversation.id,
      assistantId,
      providerCallId: "configuration-call",
      name: "get_product_configuration",
      status: "complete",
      argumentsJson: JSON.stringify({ productPath }),
      resultJson: JSON.stringify(configuration),
      completedAt: new Date(),
    },
  });
  const job = await api.startVisualization(f.owner, f.conversation.id, f.input);
  const stored = await database.visualizationJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  const frozen = JSON.parse(stored.productJson).configurationSummary;
  assert.equal(frozen, "Lining: Blackout; Control Options: Electric SmartView");
  configuration.controls[0].options[1].label = "Thermal";
  await database.toolInvocation.update({
    where: { id: tool.id },
    data: { resultJson: JSON.stringify(configuration) },
  });
  const { claim } = await api.claimPreparation(
    f.owner.id,
    job.id,
    randomUUID(),
  );
  await api.completePreparation(f.owner, job.id, claim.token, {
    productPath,
    references,
  });
  assert.equal((await settled(job.id)).status, "completed");
  assert.equal(calls[0].configurationSummary, frozen);
  assert.equal(await database.toolInvocation.count(), 1);
});

test("admin can inspect a same-owner photo explicitly reused in another chat", async () => {
  const f = await fixture();
  const next = await database.conversation.create({
    data: {
      id: randomUUID(),
      shop,
      origin,
      credentialHash: randomBytes(32).toString("hex"),
      credentialExpiresAt: new Date(Date.now() + 3_600_000),
      galleryOwnerId: f.owner.id,
    },
  });
  await assert.rejects(
    api.readAdminAsset(shop, next.id, "window", f.photo.id),
    errorStatus(404),
  );
  await api.selectWindow(f.owner.id, next.id, f.photo.id);
  assert.ok(
    (await api.readAdminAsset(shop, next.id, "window", f.photo.id)).bytes
      .length > 0,
  );
  const other = await fixture();
  await assert.rejects(
    api.readAdminAsset(shop, other.conversation.id, "window", f.photo.id),
    errorStatus(404),
  );
  await assert.rejects(
    api.readAdminAsset(
      "different.myshopify.com",
      next.id,
      "window",
      f.photo.id,
    ),
    errorStatus(404),
  );
  await api.deleteWindow(f.owner.id, f.photo.id);
  await assert.rejects(
    api.readAdminAsset(shop, next.id, "window", f.photo.id),
    errorStatus(404),
  );
});

test("gallery bearer is scoped to installed shop, exact origin and revocation", async () => {
  await database.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "test",
      accessToken: "test-install-token",
      scope: "write_app_proxy",
    },
  });
  const credential = await api.createGalleryOwner(shop, origin);
  const request = new Request(
    `https://roman.example.test/api/gallery/${credential.ownerId}`,
    {
      headers: {
        Origin: origin,
        Authorization: `Bearer ${credential.token}`,
      },
    },
  );
  assert.deepEqual(await api.authenticateGallery(request, credential.ownerId), {
    id: credential.ownerId,
    shop,
    origin,
  });
  await assert.rejects(
    api.authenticateGallery(
      new Request(request.url, { headers: { Origin: origin } }),
      credential.ownerId,
    ),
    errorStatus(401),
  );
  assert.equal(
    (
      await api.authorizeGallery(
        credential.ownerId,
        credential.token,
        origin,
        shop,
      )
    ).id,
    credential.ownerId,
  );
  await assert.rejects(
    api.authorizeGallery(
      credential.ownerId,
      credential.token,
      "https://untrusted.example",
      shop,
    ),
    errorStatus(401),
  );
  await assert.rejects(
    api.authorizeGallery(
      credential.ownerId,
      credential.token,
      origin,
      "different.myshopify.com",
    ),
    errorStatus(401),
  );
  await database.galleryOwner.update({
    where: { id: credential.ownerId },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(
    api.authorizeGallery(credential.ownerId, credential.token, origin, shop),
    errorStatus(401),
  );
});

test("invalid customer window names are validation errors before persistence", async () => {
  const f = await fixture();
  for (const title of ["", " ", "x".repeat(101), "name\nline", null, 5]) {
    await assert.rejects(
      api.saveWindow(f.owner, f.conversation.id, {
        ...f.upload,
        requestId: randomUUID(),
        title,
      }),
      errorStatus(400),
    );
    await assert.rejects(
      api.renameWindow(f.owner.id, f.photo.id, title, 1),
      errorStatus(400),
    );
  }
  assert.equal(await database.windowPhoto.count(), 1);
});

test("disabled global or shop feature blocks claims, preparations and pre-dispatch", async () => {
  const f = await fixture();
  const job = await api.startVisualization(f.owner, f.conversation.id, f.input);
  process.env.ROMAN_VISUALIZATIONS_ENABLED = "false";
  await assert.rejects(
    api.claimPreparation(f.owner.id, job.id, randomUUID()),
    errorStatus(503),
  );
  process.env.ROMAN_VISUALIZATIONS_ENABLED = "true";
  const { claim } = await api.claimPreparation(
    f.owner.id,
    job.id,
    randomUUID(),
  );
  process.env.ROMAN_VISUALIZATIONS_SHOPS = "different.myshopify.com";
  await assert.rejects(
    api.claimPreparation(f.owner.id, job.id, randomUUID()),
    errorStatus(503),
  );
  await assert.rejects(
    api.completePreparation(f.owner, job.id, claim.token, {
      productPath,
      references,
    }),
    errorStatus(503),
  );
  assert.equal(
    (
      await database.visualizationJob.findUniqueOrThrow({
        where: { id: job.id },
      })
    ).status,
    "awaiting_product",
  );
  process.env.ROMAN_VISUALIZATIONS_SHOPS = "";
  const realReferences = global.__romanImageTest.references;
  global.__romanImageTest.references = async (...args) => {
    const result = await realReferences(...args);
    process.env.ROMAN_VISUALIZATIONS_ENABLED = "false";
    return result;
  };
  await api.completePreparation(f.owner, job.id, claim.token, {
    productPath,
    references,
  });
  assert.equal((await settled(job.id)).status, "failed");
  assert.equal(calls.length, 0);
  assert.equal(await database.imageGenerationAttempt.count(), 0);
  assert.ok(
    (await api.readGalleryAsset(f.owner.id, "window", f.photo.id)).bytes
      .length > 0,
  );
});

test("disabling the feature allows an already dispatched receipt and result to settle", async () => {
  const f = await fixture();
  const dispatched = gate(),
    release = gate();
  global.__romanImageTest.provider = async (input, options) => {
    const result = await success(input, options);
    dispatched.resolve();
    await release.promise;
    return result;
  };
  const job = await prepare(f);
  await dispatched.promise;
  process.env.ROMAN_VISUALIZATIONS_ENABLED = "false";
  release.resolve();
  assert.equal((await settled(job.id)).status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(
    (await database.imageGenerationAttempt.findFirstOrThrow()).status,
    "succeeded",
  );
});

test("disabling the shop after primary rejection prevents a new Flare dispatch", async () => {
  const f = await fixture();
  global.__romanImageTest.provider = async (input, options) => {
    calls.push(input);
    const physical = receipt(input, "failed", true);
    await input.onReceipt(physical);
    process.env.ROMAN_VISUALIZATIONS_SHOPS = "different.myshopify.com";
    return { receipt: physical, image: null, imageErrorCode: null };
  };
  const job = await prepare(f);
  assert.equal((await settled(job.id)).status, "failed");
  assert.equal(calls.length, 1);
  assert.equal(await database.imageGenerationAttempt.count(), 1);
});

test("saved photos with visualization-only v1 consent remain eligible without analysis backfill", async () => {
  const f = await fixture();
  await database.windowPhoto.update({ where: { id: f.photo.id }, data: {
    consentVersion: "roman-window-photo-v1", analysisStatus: null, analysisVersion: null, analysisQueuedAt: null,
  } });
  const job = await api.startVisualization(f.owner, f.conversation.id, f.input);
  assert.equal(job.status, "awaiting_product");
  assert.equal((await database.windowPhoto.findUniqueOrThrow({ where: { id: f.photo.id } })).analysisStatus, null);
});
