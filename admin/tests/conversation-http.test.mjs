import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export * as bootstrap from "./admin/routes/api.storefront.bootstrap.ts";
      export * as conversation from "./admin/routes/api.conversations.$id.ts";
      export * as messages from "./admin/routes/api.conversations.$id.messages.ts";
      export { ConversationError } from "./admin/conversations/errors.server.ts";
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "http-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /(?:shopify|repository|runner)\.server$/ },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.endsWith("shopify.server")
            ? "export const authenticate={public:{appProxy:(request)=>mock.proxy(request)}};"
            : args.path.endsWith("repository.server")
              ? `export const authorizeCredential=(...args)=>mock.authorize(...args);
              export const createConversation=(...args)=>mock.create(...args);
              export const getSnapshot=(...args)=>mock.snapshot(...args);
              export const conversationApiBaseUrl=()=>mock.apiBaseUrl;`
              : `export const startTurn=(...args)=>mock.start(...args);
              export const readConversation=(...args)=>mock.read(...args);`,
        }));
      },
    },
  ],
});

const ID = "8e251a70-d0d7-456b-bc61-cfa7678bfc13";
const REQUEST_ID = "68055cf5-a781-4c1d-a792-42861808b2c7";
const TOKEN = "A".repeat(43);
const SHOP = "hd-dev-single.myshopify.com";
const ORIGIN = `https://${SHOP}`;
const SNAPSHOT = { id: ID, messages: [], busy: false };

function setup() {
  const logs = [];
  const calls = { proxy: 0, create: 0, authorize: 0, read: 0, start: [] };
  let now = Date.now();
  let api;
  const mock = {
    apiBaseUrl: "https://roman.example/api/conversations",
    proxy: async () => {
      calls.proxy++;
      return {
        session: {
          shop: SHOP,
          isOnline: false,
          accessToken: "offline-fixture",
          scope: "write_app_proxy",
        },
      };
    },
    authorize: async (id, token) => {
      calls.authorize++;
      if (id !== ID || token !== TOKEN)
        throw new api.ConversationError(
          401,
          "Conversation authorization failed.",
        );
      return {
        id: ID,
        shop: SHOP,
        origin: ORIGIN,
        expiresAt: new Date("2026-10-01T00:00:00Z"),
      };
    },
    create: async (shop, origin) => {
      calls.create++;
      assert.equal(shop, SHOP);
      assert.equal(origin, ORIGIN);
      return {
        conversationId: ID,
        token: TOKEN,
        expiresAt: "2026-10-01T00:00:00Z",
        apiBaseUrl: mock.apiBaseUrl,
        conversation: SNAPSHOT,
      };
    },
    snapshot: async () => SNAPSHOT,
    read: async () => {
      calls.read++;
      return SNAPSHOT;
    },
    start: async (id, input) => {
      calls.start.push({ id, input });
      return { ...SNAPSHOT, busy: true };
    },
  };
  const module = { exports: {} };
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    mock,
    Request,
    Response,
    Headers,
    URL,
    TextDecoder,
    Uint8Array,
    Date: Clock,
    console: { error: (...args) => logs.push(args) },
  });
  api = module.exports;
  return {
    api,
    mock,
    calls,
    logs,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

function request(
  path,
  {
    method = "GET",
    origin = ORIGIN,
    authorization = `Bearer ${TOKEN}`,
    body,
    headers: additions = {},
  } = {},
) {
  const headers = new Headers(additions);
  if (origin !== false) headers.set("Origin", origin);
  if (authorization !== false) headers.set("Authorization", authorization);
  if (body !== undefined && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return new Request(`https://roman.example${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

const bootstrapRequest = (options = {}) =>
  request(`/api/storefront/bootstrap?shop=${SHOP}&signature=fixture`, {
    method: "POST",
    body: "{}",
    authorization: false,
    ...options,
  });
const run = (route, request) =>
  route.action({ request, params: { id: ID }, context: {} });
const json = (value) => JSON.stringify(value);

test("signed bootstrap creates only for the authenticated offline development shop", async () => {
  const env = setup();
  const response = await run(
    env.api.bootstrap,
    bootstrapRequest({ origin: false }),
  );
  assert.equal(response.status, 200);
  assert.equal(env.calls.proxy, 1);
  assert.equal(env.calls.create, 1);
  const result = await response.json();
  assert.equal(result.token, TOKEN);
  assert.equal(result.apiBaseUrl, env.mock.apiBaseUrl);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("invalid proxy signatures and absent, online, unscoped or foreign sessions cannot bootstrap", async (t) => {
  for (const state of [
    "signature",
    "absent",
    "online",
    "no-token",
    "scope",
    "foreign",
    "mismatched-session",
  ]) {
    await t.test(state, async () => {
      const env = setup();
      env.mock.proxy = async () => {
        if (state === "signature")
          throw new Response("private SDK body", { status: 400 });
        if (state === "absent") return {};
        return {
          session: {
            shop:
              state === "foreign"
                ? "selectblinds.myshopify.com"
                : state === "mismatched-session"
                  ? "hd-dev-multi.myshopify.com"
                  : SHOP,
            isOnline: state === "online",
            accessToken: state === "no-token" ? undefined : "fixture",
            scope: state === "scope" ? "read_products" : "write_app_proxy",
          },
        };
      };
      const response = await run(env.api.bootstrap, bootstrapRequest());
      assert.equal(response.status, 401);
      assert.equal(env.calls.create, 0);
      assert.equal((await response.text()).includes("private"), false);
    });
  }
});

test("signed bootstrap rejects supplied null/foreign Origin and ignores forwarded identity", async () => {
  const env = setup();
  for (const origin of [
    "null",
    "https://hd-dev-multi.myshopify.com",
    "https://attacker.example",
  ])
    assert.equal(
      (await run(env.api.bootstrap, bootstrapRequest({ origin }))).status,
      401,
    );
  const response = await run(
    env.api.bootstrap,
    bootstrapRequest({
      origin: false,
      headers: { "X-Forwarded-Host": "attacker.example" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(env.calls.create, 1);
});

test("bootstrap resumes the same scoped credential and uses the current API base URL", async () => {
  const env = setup();
  const response = await run(
    env.api.bootstrap,
    bootstrapRequest({ body: json({ conversationId: ID, token: TOKEN }) }),
  );
  assert.equal(response.status, 200);
  assert.equal(env.calls.create, 0);
  const result = await response.json();
  assert.equal(result.conversationId, ID);
  assert.equal(result.token, TOKEN);
  assert.equal(result.expiresAt, "2026-10-01T00:00:00.000Z");
  assert.equal(result.apiBaseUrl, env.mock.apiBaseUrl);
});

test("bootstrap cannot resume another shop's conversation", async () => {
  const env = setup();
  env.mock.authorize = async () => ({
    id: ID,
    shop: "hd-dev-multi.myshopify.com",
    origin: "https://hd-dev-multi.myshopify.com",
    expiresAt: new Date(),
  });
  const response = await run(
    env.api.bootstrap,
    bootstrapRequest({ body: json({ conversationId: ID, token: TOKEN }) }),
  );
  assert.equal(response.status, 401);
  assert.equal(env.calls.create, 0);
});

test("new conversations have a bounded per-shop throttle but resumes remain possible", async () => {
  const env = setup();
  for (let index = 0; index < 20; index++)
    assert.equal(
      (await run(env.api.bootstrap, bootstrapRequest())).status,
      200,
    );
  assert.equal((await run(env.api.bootstrap, bootstrapRequest())).status, 429);
  assert.equal(env.calls.create, 20);
  assert.equal(
    (
      await run(
        env.api.bootstrap,
        bootstrapRequest({ body: json({ conversationId: ID, token: TOKEN }) }),
      )
    ).status,
    200,
  );
  env.advance(10 * 60 * 1000);
  assert.equal((await run(env.api.bootstrap, bootstrapRequest())).status, 200);
});

test("direct conversation reads require exact Origin, bearer credential and stored shop/origin", async (t) => {
  const env = setup();
  const success = await run(
    env.api.conversation,
    request(`/api/conversations/${ID}`),
  );
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(success.headers.get("Vary"), "Origin");
  assert.equal(success.headers.get("Access-Control-Allow-Credentials"), null);
  for (const options of [
    { origin: false },
    { origin: "null" },
    { origin: "http://localhost:5173" },
    { origin: `${ORIGIN}/` },
    { origin: "https://attacker.example" },
    { authorization: false },
    { authorization: "Bearer invalid" },
    { authorization: `Basic ${TOKEN}` },
    { authorization: `Bearer ${"B".repeat(43)}` },
    { origin: "https://hd-dev-multi.myshopify.com" },
  ]) {
    await t.test(json(options), async () => {
      assert.equal(
        (
          await run(
            env.api.conversation,
            request(`/api/conversations/${ID}`, options),
          )
        ).status,
        401,
      );
    });
  }
  assert.equal(env.calls.read, 1);
});

test("invalid route IDs and unauthorized rows are rejected before conversation data is read", async () => {
  const env = setup();
  const badId = await env.api.conversation.loader({
    request: request("/api/conversations/not-id"),
    params: { id: "not-id" },
    context: {},
  });
  assert.equal(badId.status, 401);
  env.mock.authorize = async () => ({
    id: ID,
    shop: SHOP,
    origin: "https://attacker.example",
    expiresAt: new Date(),
  });
  assert.equal(
    (await run(env.api.conversation, request(`/api/conversations/${ID}`)))
      .status,
    401,
  );
  assert.equal(env.calls.read, 0);
});

test("messages accept only the exact bounded request shape and return 202", async () => {
  const env = setup();
  const response = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`, {
      method: "POST",
      body: json({ requestId: REQUEST_ID, text: "  Hello Roman  " }),
    }),
  );
  assert.equal(response.status, 202);
  assert.equal(env.calls.start.length, 1);
  assert.equal(env.calls.start[0].id, ID);
  assert.equal(env.calls.start[0].input.text, "Hello Roman");
  assert.equal(env.calls.start[0].input.requestId, REQUEST_ID);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("invalid message JSON never starts a model turn", async (t) => {
  for (const value of [
    null,
    [],
    "hello",
    {},
    { requestId: REQUEST_ID },
    { requestId: "invalid", text: "hello" },
    { requestId: REQUEST_ID, text: " " },
    { requestId: REQUEST_ID, text: 4 },
    { requestId: REQUEST_ID, text: "a".repeat(4001) },
    { requestId: REQUEST_ID, text: "hello", shop: SHOP },
    { requestId: REQUEST_ID, text: "hello", role: "system" },
  ]) {
    await t.test(
      typeof value === "object"
        ? Object.keys(value ?? {}).join(",") || "empty"
        : typeof value,
      async () => {
        const env = setup();
        const response = await run(
          env.api.messages,
          request(`/api/conversations/${ID}/messages`, {
            method: "POST",
            body: json(value),
          }),
        );
        assert.equal(response.status, 400);
        assert.equal(env.calls.start.length, 0);
      },
    );
  }
});

test("bootstrap rejects mixed, partial and oversized credential bodies", async () => {
  const env = setup();
  for (const value of [
    { shop: SHOP },
    { token: TOKEN },
    { conversationId: ID },
    { conversationId: ID, token: TOKEN, shop: SHOP },
    { conversationId: ID, token: "x".repeat(44) },
  ])
    assert.equal(
      (await run(env.api.bootstrap, bootstrapRequest({ body: json(value) })))
        .status,
      400,
    );
  assert.equal(env.calls.create, 0);
});

test("body parser rejects wrong media type, malformed JSON, invalid UTF-8 and declared oversize", async () => {
  const env = setup();
  for (const options of [
    { body: "{}", headers: { "Content-Type": "text/plain" } },
    { body: "{" },
    { body: new Uint8Array([0xc3, 0x28]) },
    { body: "{}", headers: { "Content-Length": "32769" } },
  ])
    assert.equal(
      (await run(env.api.bootstrap, bootstrapRequest(options))).status,
      400,
    );
  assert.equal(env.calls.create, 0);
});

test("chunked bodies are byte-bounded and cancelled even without Content-Length", async () => {
  const env = setup();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"padding":"'));
      controller.enqueue(new Uint8Array(32768).fill(65));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(
    `https://roman.example/api/storefront/bootstrap?shop=${SHOP}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: stream,
      duplex: "half",
    },
  );
  const response = await run(env.api.bootstrap, request);
  assert.equal(response.status, 400);
  assert.equal(cancelled, true);
  assert.equal(env.calls.create, 0);
});

test("preflight is allowed only for the two development origins and needs no credential", async () => {
  const env = setup();
  for (const origin of [ORIGIN, "https://hd-dev-multi.myshopify.com"]) {
    const response = await run(
      env.api.messages,
      request(`/api/conversations/${ID}/messages`, {
        method: "OPTIONS",
        origin,
        authorization: false,
      }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, OPTIONS",
    );
    assert.equal(
      response.headers.get("Access-Control-Allow-Headers"),
      "Authorization, Content-Type",
    );
  }
  const rejected = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`, {
      method: "OPTIONS",
      origin: "https://attacker.example",
    }),
  );
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(env.calls.authorize, 0);
});

test("wrong methods are rejected without authenticating or starting work", async () => {
  const env = setup();
  const response = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
  assert.equal(env.calls.authorize, 0);
  assert.equal(env.calls.start.length, 0);
});

test("known errors retain safe status and CORS; unexpected failures expose no internal detail", async () => {
  const env = setup();
  for (const [status, code] of [
    [400, "invalid_request"],
    [401, "unauthorized"],
    [404, "not_found"],
    [409, "busy"],
    [429, "limit"],
  ]) {
    env.mock.read = async () => {
      throw new env.api.ConversationError(status, "Safe public message.");
    };
    const response = await run(
      env.api.conversation,
      request(`/api/conversations/${ID}`),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal((await response.json()).error.code, code);
  }
  env.mock.read = async () => {
    throw new Error("private SQL token body");
  };
  const response = await run(
    env.api.conversation,
    request(`/api/conversations/${ID}`),
  );
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal((await response.text()).includes("private"), false);
  assert.equal(env.logs.length, 1);
  assert.equal(JSON.stringify(env.logs).includes("private"), false);
  assert.equal(JSON.stringify(env.logs).includes(ID), false);
  assert.equal(JSON.stringify(env.logs).includes(TOKEN), false);
});
