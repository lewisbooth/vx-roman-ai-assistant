import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `export * from "./admin/routes/api.conversations.$id.measurements.ts";
      export { ConversationError } from "./admin/conversations/errors.server.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [
    {
      name: "measurement-http-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /(?:availability|shopify|repository|service)\.server$/ },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("availability.server")
            ? "export const assertServiceAvailable = async () => {};"
            : path.endsWith("shopify.server")
            ? "export const authenticate = {};"
            : path.endsWith("repository.server")
              ? "export const authorizeCredential = (...args) => mock.authorize(...args);"
              : "export const executeManualMeasurementTool = (...args) => mock.execute(...args);",
        }));
      },
    },
  ],
});

const id = "fc0b4e9e-5319-4504-8bd4-0ca0b7619b79";
const requestId = "fe742eed-c035-4b84-a79a-10fe1dba02d2";
const origin = "https://shopify-single-dev.hdecom.com";
const body = {
  requestId,
  name: "get_measurements",
  arguments: { productPath: "/products/lottie" },
};
const result = { status: "not_found", productPath: "/products/lottie" };

function setup() {
  const calls = { authorize: [], execute: [] };
  const mock = {
    async authorize(...args) {
      calls.authorize.push(args);
      return { id, shop: "hd-dev-single.myshopify.com", origin };
    },
    async execute(...args) {
      calls.execute.push(args);
      return result;
    },
  };
  const module = { exports: {} };
  new Function("mock", "module", "exports", bundle.outputFiles[0].text)(
    mock,
    module,
    module.exports,
  );
  return { api: module.exports, calls, mock };
}

function request(overrides = {}) {
  const { headers, ...rest } = overrides;
  return new Request(
    `https://roman.example.test/api/conversations/${id}/measurements`,
    {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${"A".repeat(43)}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...rest,
    },
  );
}

test("measurement endpoint independently authorizes the bearer and returns only the tool result", async () => {
  const { api, calls } = setup();
  const response = await api.action({ request: request(), params: { id } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result });
  assert.deepEqual(calls.authorize, [[id, "A".repeat(43)]]);
  assert.deepEqual(calls.execute, [[id, requestId, body.name, body.arguments]]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
});

test("missing credentials, unauthorized origins and mismatched stored origins never execute", async () => {
  for (const headers of [
    { Authorization: "" },
    { Origin: "https://attacker.test" },
    { Origin: "https://hd-dev-multi.myshopify.com" },
  ]) {
    const { api, calls } = setup();
    const response = await api.action({
      request: request({ headers }),
      params: { id },
    });
    assert.equal(response.status, 401);
    assert.equal(calls.execute.length, 0);
  }
  const { api, calls, mock } = setup();
  mock.authorize = async () => {
    throw new api.ConversationError(401, "Conversation authorization failed.");
  };
  assert.equal(
    (await api.action({ request: request(), params: { id } })).status,
    401,
  );
  assert.equal(calls.execute.length, 0);
});

test("measurement body is exact, bounded and parsed only after authorization", async () => {
  for (const invalid of [
    { ...body, shop: "another.myshopify.com" },
    { requestId, name: body.name },
    { ...body, requestId: 1 },
    { ...body, name: null },
  ]) {
    const { api, calls } = setup();
    const response = await api.action({
      request: request({ body: JSON.stringify(invalid) }),
      params: { id },
    });
    assert.equal(response.status, 400);
    assert.equal(calls.authorize.length, 1);
    assert.equal(calls.execute.length, 0);
  }
  for (const invalid of [
    "{",
    "[]",
    JSON.stringify({ ...body, padding: "x".repeat(32768) }),
  ]) {
    const { api, calls } = setup();
    assert.equal(
      (
        await api.action({
          request: request({ body: invalid }),
          params: { id },
        })
      ).status,
      400,
    );
    assert.equal(calls.execute.length, 0);
  }
});

test("preflight and unsupported methods do not execute measurements", async () => {
  const { api, calls } = setup();
  const preflight = await api.action({
    request: request({ method: "OPTIONS", body: undefined }),
    params: { id },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Max-Age"), "600");
  assert.equal(
    (
      await api.loader({
        request: request({ method: "GET", body: undefined }),
        params: { id },
      })
    ).status,
    405,
  );
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.execute.length, 0);
});

test("service conflicts remain actionable errors without leaking an internal result", async () => {
  const { api, mock } = setup();
  mock.execute = async () => {
    throw new api.ConversationError(409, "This conversation has ended.");
  };
  const response = await api.action({ request: request(), params: { id } });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: { code: "busy", message: "This conversation has ended." },
  });
});
