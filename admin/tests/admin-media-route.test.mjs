import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { cwd } from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export {loader,action} from './admin/routes/app.conversations.$id.media.$assetType.$assetId'; export {ConversationError} from './admin/conversations/errors.server';`,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [
    {
      name: "admin-media-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /(?:shopify|repository|db)\.server$/ },
          (args) => ({ path: args.path, namespace: "mock" }),
        );
        build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: args.path.endsWith("shopify.server")
            ? `export const authenticate={admin:request=>mock.authenticate(request)};`
            : args.path.endsWith("db.server")
              ? `export default mock.db;`
              : `export const readAdminAsset=(...args)=>mock.read(...args); export const deleteWindow=(...args)=>mock.remove('window',...args); export const deleteVisualization=(...args)=>mock.remove('result',...args);`,
        }));
      },
    },
  ],
});
const ID = "aeb3aafb-0559-4cb1-9c47-45408071424b",
  ASSET = "b1182482-7fd4-41ef-8ba5-e061cf1bcc46";
function setup() {
  const calls = [],
    mock = {
      authenticate: async (request) => {
        calls.push(["auth", request.method]);
        return { session: { shop: "own.myshopify.com" } };
      },
      read: async (...args) => {
        calls.push(["read", ...args]);
        return { bytes: Buffer.from([1, 2, 3]), width: 1024, height: 1024 };
      },
      remove: async (...args) => calls.push(["remove", ...args]),
      db: {
        conversation: {
          findFirst: async (query) => {
            calls.push(["conversation", query]);
            return { galleryOwnerId: "owner" };
          },
        },
        windowPhoto: {
          findFirst: async (query) => {
            calls.push(["window", query]);
            return { id: ASSET };
          },
        },
        visualizationJob: {
          findFirst: async (query) => {
            calls.push(["job", query]);
            return { id: ASSET };
          },
        },
      },
    };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    mock,
    Request,
    Response,
    Uint8Array,
  });
  const args = (method = "GET", extra = {}) => ({
    request: new Request("https://roman.example/app/conversations/media", {
      method,
    }),
    params: { id: ID, assetType: "window", assetId: ASSET, ...extra },
  });
  return { ...module.exports, mock, calls, args };
}
test("admin media read authenticates independently and returns private bytes with no cache", async () => {
  const { loader, calls, args } = setup();
  const response = await loader(args());
  assert.deepEqual(calls, [
    ["auth", "GET"],
    ["read", "own.myshopify.com", ID, "window", ASSET],
  ]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [1, 2, 3],
  );
});
test("invalid media type and unavailable files return no-store 404 after auth", async () => {
  const s = setup();
  await assert.rejects(
    s.loader(s.args("GET", { assetType: "private" })),
    (e) => e.status === 404,
  );
  assert.deepEqual(s.calls, [["auth", "GET"]]);
  s.mock.read = async () => {
    throw new s.ConversationError(404, "private path");
  };
  let failure;
  try { await s.loader(s.args()); } catch (error) { failure = error; }
  assert.equal(failure.status, 404);
  assert.equal(failure.headers.get("cache-control"), "no-store");
  assert.equal(await failure.text(), "Image not found.");
});
test("admin deletion scopes conversation and exact originating asset before domain service", async () => {
  for (const assetType of ["window", "result"]) {
    const s = setup();
    const response = await s.action(s.args("DELETE", { assetType }));
    assert.equal(response.status, 204);
    assert.deepEqual(JSON.parse(JSON.stringify(s.calls[1])), [
      "conversation",
      {
        where: { id: ID, shop: "own.myshopify.com" },
        select: { galleryOwnerId: true },
      },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(s.calls[2][1].where)), {
      id: ASSET,
      ownerId: "owner",
      conversationId: ID,
    });
    assert.deepEqual(s.calls[3], ["remove", assetType, "owner", ASSET]);
  }
});
test("authentication, foreign conversation, foreign asset and unsupported method stop deletion", async () => {
  const s = setup(),
    failure = new Error("auth failed");
  s.mock.authenticate = async () => {
    throw failure;
  };
  await assert.rejects(s.action(s.args("DELETE")), (e) => e === failure);
  assert.equal(s.calls.length, 0);
  for (const field of ["conversation", "windowPhoto"]) {
    const s = setup();
    s.mock.db[field].findFirst = async () => null;
    await assert.rejects(s.action(s.args("DELETE")), (e) => e.status === 404);
    assert.ok(!s.calls.some((c) => c[0] === "remove"));
  }
  const q = setup();
  await assert.rejects(q.action(q.args("POST")), (e) => e.status === 405);
  assert.deepEqual(q.calls, [["auth", "POST"]]);
});
