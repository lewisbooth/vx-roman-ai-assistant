import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: "export * from './admin/visualizations/tools.server'; export { ConversationError } from './admin/conversations/errors.server';",
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [
    {
      name: "private-media-tools",
      setup(build) {
        build.onResolve(
          { filter: /(?:db|repository|jobs|config)\.server$/ },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.includes("db.server")
            ? "export default mock.db;"
            : args.path.includes("config.server")
              ? "export const visualizationsEnabled=()=>mock.enabled;"
              : args.path.includes("jobs.server")
                ? "export const startVisualization=(...args)=>mock.start(...args);"
                : "export const ownedPhoto=(...args)=>mock.photo(...args); export const photoDto=p=>p; export const renameWindow=(...args)=>mock.rename(...args);",
        }));
      },
    },
  ],
});

function setup() {
  const owner = randomUUID(),
    conversationId = randomUUID(),
    assistantId = randomUUID(),
    photoId = randomUUID();
  const controller = new AbortController(),
    receipts = new Map(),
    calls = [];
  const photo = {
    id: photoId,
    title: "Kitchen",
    revision: 3,
    cleanup: true,
    width: 1000,
    height: 800,
    createdAt: new Date(),
  };
  const mock = {
    enabled: true,
    linked: true,
    present: true,
    db: {
      conversation: {
        findUnique: async () => ({
          shop: "shop.myshopify.com",
          origin: "https://shop.example",
          status: "active",
          galleryOwnerId: mock.linked ? owner : null,
          selectedWindowPhotoId: photoId,
          galleryOwner: { id: owner, revokedAt: null },
        }),
        findFirst: async (input) => {
          calls.push(["active", input]);
          return mock.linked ? {} : null;
        },
      },
      windowPhoto: {
        count: async (input) => {
          calls.push(["count", input]);
          return mock.present ? 1 : 0;
        },
        findMany: async (input) => {
          calls.push(["list", input]);
          return mock.present ? [photo] : [];
        },
      },
      toolInvocation: {
        findUnique: async (input) =>
          receipts.get(
            input.where.conversationId_providerCallId.providerCallId,
          ) ?? null,
        create: async ({ data }) => {
          receipts.set(data.providerCallId, data);
          return data;
        },
        update: async ({ where, data }) => {
          const receipt = [...receipts.values()].find(
            (value) => value.id === where.id,
          );
          Object.assign(receipt, data);
          return receipt;
        },
      },
    },
    photo: async (...args) => {
      calls.push(["photo", args]);
      assert.equal(args[0], owner);
      assert.equal(args[1], photoId);
      return photo;
    },
    rename: async (...args) => {
      calls.push(["rename", args]);
      if (args[3] !== photo.revision)
        throw new module.exports.ConversationError(409, "This image name changed in another tab.");
      return { ...photo, title: args[2], revision: 4 };
    },
    start: async (...args) => {
      calls.push(["start", args]);
      return {
        id: randomUUID(),
        windowId: photoId,
        status: "awaiting_product",
      };
    },
  };
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    "mock",
    "require",
    bundle.outputFiles[0].text,
  )(module, module.exports, mock, (value) => {
    if (value === "node:crypto") return { randomUUID };
    throw new Error(`Unexpected dependency ${value}`);
  });
  return {
    mock,
    receipts,
    calls,
    owner,
    conversationId,
    assistantId,
    photoId,
    photo,
    controller,
    create: () =>
      module.exports.createVisualizationTurn(
        conversationId,
        assistantId,
        controller.signal,
      ),
  };
}

test("photo tools require an enabled gallery linked to an active conversation", async () => {
  const app = setup();
  app.mock.enabled = false;
  assert.equal(await app.create(), undefined);
  app.mock.enabled = true;
  app.mock.linked = false;
  assert.equal(await app.create(), undefined);
});

test("window listing is owner-scoped and bounded, and terminal cards use current verified IDs", async () => {
  const app = setup(),
    turn = await app.create();
  const list = await turn.execute("list", "list_windows", {
    query: null,
    cursor: null,
  });
  assert.equal(list.windows[0].id, app.photoId);
  const query = app.calls.find(([name]) => name === "list")[1];
  assert.equal(query.where.ownerId, app.owner);
  assert.equal(query.where.uploadStatus, "ready");
  assert.equal(query.where.deletedAt, null);
  assert.equal(query.take, 11);
  const selected = await turn.validatePresentation({
    kind: "windows",
    windowIds: [app.photoId],
  });
  assert.equal(selected.windowIds[0], app.photoId);
  await assert.rejects(
    turn.validatePresentation({ kind: "windows", windowIds: [randomUUID()] }),
    /verified/,
  );
  app.mock.present = false;
  await assert.rejects(
    turn.validatePresentation({ kind: "windows", windowIds: [app.photoId] }),
    /no longer available/,
  );
});

test("cached observations are retrievable and reference cards cannot resurrect deleted photos", async () => {
  const app = setup();
  const observations = { image_kind: "room_photo", summary: "A cream room.", colours: ["cream"], decor_style: [], notable_features: [],
    windows: { visible_count: 0, count_confidence: "low", count_note: "No clear opening.", items: [] }, limitations: ["Window hidden."] };
  Object.assign(app.photo, { analysisStatus: "completed", analysisVersion: "test", analysisQueuedAt: new Date(), analysisStartedAt: new Date(), analysisCompletedAt: new Date(), analysisJson: JSON.stringify(observations) });
  const turn = await app.create();
  const args = { query: null, cursor: null };
  const result = await turn.execute("analysis-list", "list_windows", args);
  assert.deepEqual(result.windows[0].analysis.observations, observations);
  assert.equal((await turn.validatePresentation({ kind: "windows", windowIds: [app.photoId], purpose: "reference" })).purpose, "reference");
  app.mock.present = false;
  const replay = await turn.execute("analysis-list", "list_windows", args);
  assert.deepEqual(replay.windows, []);
  await assert.rejects(turn.validatePresentation({ kind: "windows", windowIds: [app.photoId], purpose: "reference" }), /no longer available/);
});

test("unknown photo IDs cannot rename or dispatch generation; renaming uses the supplied observed revision", async () => {
  const app = setup(),
    turn = await app.create();
  const refused = await turn.execute("foreign", "rename_window", {
    windowId: randomUUID(),
    title: "Other",
    revision: 3,
  });
  assert.match(refused.error, /known saved window/);
  assert.equal(app.calls.filter(([name]) => name === "rename").length, 0);
  const renamed = await turn.execute("rename", "rename_window", {
    windowId: app.photoId,
    title: "  Nursery  ",
    revision: 3,
  });
  assert.equal(renamed.title, "Nursery");
  assert.deepEqual(app.calls.find(([name]) => name === "rename")[1], [
    app.owner,
    app.photoId,
    "Nursery",
    3,
  ]);
});

test("a Gallery rename after the naming decision conflicts rather than overwriting the customer's title", async () => {
  const app = setup();
  const turn = await app.create();
  const observedRevision = app.photo.revision;
  Object.assign(app.photo, {title: "My daughter's bedroom", revision: observedRevision + 1});
  const result = await turn.execute("inferred-name", "rename_window", {
    windowId: app.photoId, title: "Blush bedroom", revision: observedRevision,
  });
  assert.match(result.error, /name changed/);
  assert.equal(app.photo.title, "My daughter's bedroom");
  assert.equal(app.photo.revision, observedRevision + 1);
  assert.equal(app.calls.find(([name]) => name === "rename")[1][3], observedRevision,
    "the tool must not silently replace the observed revision with a fresh one");
  assert.equal(app.receipts.get("inferred-name").status, "failed");
});

test("rename requires a valid observed revision without guessing it from a newer photo read", async () => {
  for (const revision of [undefined, 0, -1, 1.5, "3"]) {
    const app = setup();
    const turn = await app.create();
    const result = await turn.execute("invalid-revision", "rename_window", {
      windowId: app.photoId, title: "Bedroom", ...(revision === undefined ? {} : {revision}),
    });
    assert.ok(result.error);
    assert.equal(app.calls.filter(([name]) => name === "rename").length, 0);
  }
});

test("generation includes cleanup even for historical photos and uses one durable request on replay", async () => {
  const app = setup();
  app.photo.cleanup = false;
  const turn = await app.create();
  const args = {
    windowId: app.photoId,
    productPath: "/products/blind",
    targetDescription: null,
  };
  const job = await turn.execute("create", "create_visualization", args);
  const replay = await turn.execute("create", "create_visualization", args);
  assert.equal(replay.id, job.id);
  const starts = app.calls.filter(([name]) => name === "start");
  assert.equal(starts.length, 1);
  const [owner, conversationId, request] = starts[0][1];
  assert.equal(owner.id, app.owner);
  assert.equal(conversationId, app.conversationId);
  assert.equal(request.cleanup, true);
  assert.equal(request.requestId, app.receipts.get("create").id);
  assert.equal(request.productPath, args.productPath);
});

test("unconfirmed failures are not replayed and cancellation preserves already accepted work", async () => {
  const app = setup(),
    turn = await app.create();
  const args = {
    windowId: app.photoId,
    productPath: "/products/blind",
    targetDescription: null,
  };
  app.mock.start = async () => {
    throw new Error("Private provider body");
  };
  const failed = await turn.execute("failed", "create_visualization", args);
  assert.equal(failed.error, "The photo request could not be completed.");
  assert.deepEqual(
    await turn.execute("failed", "create_visualization", args),
    failed,
  );
  app.mock.start = async () => {
    app.controller.abort();
    return { id: randomUUID(), status: "awaiting_product" };
  };
  const accepted = await turn.execute("accepted", "create_visualization", args);
  assert.equal(accepted.status, "awaiting_product");
  assert.equal(app.receipts.get("accepted").status, "complete");
  await assert.rejects(
    turn.execute("after-abort", "list_windows", { query: null, cursor: null }),
    { name: "AbortError" },
  );
  assert.equal(app.receipts.has("after-abort"), false);
});
