import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export * as bootstrap from "./admin/routes/api.storefront.bootstrap.ts";
      export * as availability from "./admin/routes/api.storefront.availability.ts";
      export * as conversation from "./admin/routes/api.conversations.$id.ts";
      export * as messages from "./admin/routes/api.conversations.$id.messages.ts";
      export * as journey from "./admin/routes/api.conversations.$id.journey.ts";
      export * as end from "./admin/routes/api.conversations.$id.end.ts";
      export * as claim from "./admin/routes/api.conversations.$id.tools.$invocationId.claim.ts";
      export * as result from "./admin/routes/api.conversations.$id.tools.$invocationId.result.ts";
      export { ConversationError, ServiceUnavailableError } from "./admin/conversations/errors.server.ts";
      export { parseCatalogResult } from "./shared/catalog.ts";
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
          {
            filter:
              /(?:shopify|repository|runner|browser-tools|service|availability)\.server$/,
          },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.endsWith("availability.server")
            ? `export const assertServiceAvailable=()=>mock.assertAvailable();
               export const getAvailabilityStatus=()=>mock.status;`
            : args.path.endsWith("shopify.server")
            ? "export const authenticate={public:{appProxy:(request)=>mock.proxy(request)}};"
            : args.path.endsWith("service.server")
              ? `export const stopConversationVoice=(...args)=>mock.stopVoice(...args);
                 export const noteVoicePageView=(...args)=>mock.voicePage(...args);`
              : args.path.endsWith("repository.server")
                ? `export const authorizeCredential=(...args)=>mock.authorize(...args);
              export const createConversation=(...args)=>mock.create(...args);
              export const getSnapshot=(...args)=>mock.snapshot(...args);
              export const appendJourney=(...args)=>mock.journey(...args);
              export const claimToolInvocation=(...args)=>mock.claim(...args);
              export const conversationApiBaseUrl=()=>mock.apiBaseUrl;`
                : args.path.endsWith("browser-tools.server")
                  ? `export const submitBrowserToolResult=(...args)=>mock.result(...args);`.concat(
                      `export const claimBrowserTool=(...args)=>mock.claim(...args);`,
                    )
                  : `export const endTurn=(...args)=>mock.end(...args);
              export const startTurn=(...args)=>mock.start(...args);
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
const SNAPSHOT = {
  id: ID,
  status: "active",
  revision: 0,
  messages: [],
  busy: false,
  tools: [],
};
const INVOCATION_ID = "1b65d343-3010-4f5e-b026-daa94a2e1087";
const CLAIM = { clientId: REQUEST_ID, claimToken: "C".repeat(43) };

function setup() {
  const logs = [];
  const calls = {
    proxy: 0,
    create: 0,
    authorize: 0,
    read: 0,
    start: [],
    journey: [],
    end: [],
    claim: [],
    result: [],
    voiceStops: [],
    voicePages: [],
  };
  let now = Date.now();
  let api;
  const mock = {
    apiBaseUrl: "https://roman.example/api/conversations",
    status: "available",
    assertAvailable: () => {
      if (mock.status === "suspended")
        throw new api.ServiceUnavailableError();
    },
    stopVoice: async (...args) => {
      calls.voiceStops.push(args);
    },
    voicePage: (...args) => {
      calls.voicePages.push(args);
    },
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
    journey: async (...args) => {
      calls.journey.push(args);
      return { ...SNAPSHOT, revision: 1 };
    },
    end: async (...args) => {
      calls.end.push(args);
      return { ...SNAPSHOT, status: "ended", revision: 1 };
    },
    claim: async (...args) => {
      calls.claim.push(args);
      return { claimed: true };
    },
    result: async (...args) => {
      calls.result.push(args);
    },
    read: async () => {
      calls.read++;
      return SNAPSHOT;
    },
    start: async (id, input) => {
      mock.assertAvailable();
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
  route.action({
    request,
    params: { id: ID, invocationId: INVOCATION_ID },
    context: {},
  });
const json = (value) => JSON.stringify(value);

test("conditional conversation reads validate both versions after independent authorization", async () => {
  const env = setup();
  env.mock.read = async (id, version) => {
    assert.equal(id, ID);
    assert.deepEqual(JSON.parse(JSON.stringify(version)), {
      revision: 12,
      streamRevision: 3,
    });
    return { id, ...version, unchanged: true };
  };
  const response = await run(
    env.api.conversation,
    request(`/api/conversations/${ID}?revision=12&streamRevision=3`),
  );
  assert.equal(response.status, 200);
  assert.equal(env.calls.authorize, 1);
  assert.deepEqual(await response.json(), {
    id: ID,
    revision: 12,
    streamRevision: 3,
    unchanged: true,
  });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  env.mock.read = () =>
    assert.fail("invalid versions must not reach the read owner");
  for (const query of [
    "revision=1",
    "streamRevision=1",
    "revision=-1&streamRevision=0",
    "revision=1&streamRevision=1.5",
    "revision=9007199254740992&streamRevision=0",
    "revision=1&revision=2&streamRevision=0",
    "revision=1&streamRevision=",
  ]) {
    const invalid = await run(
      env.api.conversation,
      request(`/api/conversations/${ID}?${query}`),
    );
    assert.equal(invalid.status, 400, query);
  }
  const denied = await run(
    env.api.conversation,
    request(`/api/conversations/${ID}?revision=12&streamRevision=3`, {
      authorization: false,
    }),
  );
  assert.equal(denied.status, 401);
});

test("shopper approval is a strict claim field and cannot be smuggled in result uploads", async () => {
  const env = setup();
  const path = `/api/conversations/${ID}/tools/${INVOCATION_ID}`;
  for (const confirmed of [true, false]) {
    const response = await run(
      env.api.claim,
      request(`${path}/claim`, {
        method: "POST",
        body: json({ ...CLAIM, confirmed }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(env.calls.claim.at(-1)[2].confirmed, confirmed);
  }
  for (const confirmed of ["true", 1, null, {}]) {
    const response = await run(
      env.api.claim,
      request(`${path}/claim`, {
        method: "POST",
        body: json({ ...CLAIM, confirmed }),
      }),
    );
    assert.equal(response.status, 400);
  }
  const result = await run(
    env.api.result,
    request(`${path}/result`, {
      method: "POST",
      body: json({ ...CLAIM, confirmed: true, result: {} }),
    }),
  );
  assert.equal(result.status, 400);
  assert.equal(env.calls.claim.length, 2);
  assert.equal(env.calls.result.length, 0);
});

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

test("signed availability remains readable while suspended and customer writes return the outage code", async () => {
  const env = setup();
  env.mock.status = "suspended";
  const status = await run(
    env.api.availability,
    request(`/api/storefront/availability?shop=${SHOP}&signature=fixture`, {
      authorization: false,
    }),
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: "suspended" });
  assert.equal(status.headers.get("Cache-Control"), "no-store");
  const blocked = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`, {
      method: "POST",
      body: json({ requestId: REQUEST_ID, text: "Continue" }),
    }),
  );
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), {
    error: { code: "SERVICE_UNAVAILABLE", message: "Roman is currently unavailable" },
  });
  const journey = await run(
    env.api.journey,
    request(`/api/conversations/${ID}/journey`, { method: "POST", body: "{}" }),
  );
  assert.equal(journey.status, 503);
  assert.equal(env.calls.journey.length, 0);
  const read = await run(env.api.conversation, request(`/api/conversations/${ID}`));
  assert.equal(read.status, 200);
  env.mock.proxy = async () => { throw new Response("invalid signature", { status: 400 }); };
  const unsigned = await run(
    env.api.availability,
    request(`/api/storefront/availability?shop=${SHOP}&signature=invalid`, {
      authorization: false,
    }),
  );
  assert.equal(unsigned.status, 401);
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

test("the custom storefront bootstraps through signed shop identity even when Origin is omitted", async () => {
  const origin = "https://shopify-single-dev.hdecom.com";
  const env = setup();
  const path = `/api/storefront/bootstrap?shop=${SHOP}&storefront_origin=${encodeURIComponent(origin)}&signature=fixture`;
  env.mock.create = async (shop, receivedOrigin) => {
    assert.equal(shop, SHOP);
    assert.equal(receivedOrigin, origin);
    return { conversationId: ID };
  };
  for (const suppliedOrigin of [false, origin]) {
    const response = await run(
      env.api.bootstrap,
      request(path, {
        method: "POST",
        origin: suppliedOrigin,
        body: "{}",
        authorization: false,
      }),
    );
    assert.equal(response.status, 200);
  }
  env.mock.authorize = async () => ({
    id: ID,
    shop: SHOP,
    origin,
    expiresAt: new Date(),
  });
  assert.equal(
    (
      await run(
        env.api.bootstrap,
        request(path, {
          method: "POST",
          origin: false,
          body: json({ conversationId: ID, token: TOKEN }),
        }),
      )
    ).status,
    200,
  );
  const read = await run(
    env.api.conversation,
    request(`/api/conversations/${ID}`, { origin }),
  );
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(
    (await run(env.api.conversation, request(`/api/conversations/${ID}`)))
      .status,
    401,
  );
});

test("custom origin authorization rejects another shop, forwarded headers, and wildcard lookalikes", async () => {
  const custom = "https://shopify-single-dev.hdecom.com";
  for (const origin of [
    "https://attacker.hdecom.com",
    `${custom}.attacker.example`,
    `${custom}/`,
    "http://shopify-single-dev.hdecom.com",
    "https://hd-dev-multi.myshopify.com",
  ]) {
    const env = setup();
    assert.equal(
      (
        await run(
          env.api.bootstrap,
          request(
            `/api/storefront/bootstrap?shop=${SHOP}&storefront_origin=${encodeURIComponent(origin)}&signature=fixture`,
            { method: "POST", origin: false, body: "{}" },
          ),
        )
      ).status,
      401,
    );
    assert.equal(env.calls.create, 0);
  }
  const env = setup();
  const path = `/api/storefront/bootstrap?shop=${SHOP}&storefront_origin=${encodeURIComponent(custom)}&signature=fixture`;
  assert.equal(
    (
      await run(
        env.api.bootstrap,
        request(path, { method: "POST", body: "{}" }),
      )
    ).status,
    401,
  );
  env.mock.authorize = async () => ({
    id: ID,
    shop: "hd-dev-multi.myshopify.com",
    origin: custom,
    expiresAt: new Date(),
  });
  assert.equal(
    (
      await run(
        env.api.conversation,
        request(`/api/conversations/${ID}`, { origin: custom }),
      )
    ).status,
    401,
  );
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

test("text product choices carry a friendly message and validated structured reference", async () => {
  const choice = {
    carouselId: INVOCATION_ID,
    productId: "gid://shopify/Product/123",
    title: "Green roller blind",
    productPath: "/products/green-roller",
  };
  const input = {
    requestId: REQUEST_ID,
    text: "I'd like the Green roller blind.",
    productChoice: choice,
  };
  const env = setup();
  const response = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`, {
      method: "POST",
      body: json(input),
    }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.start[0].input)), input);
  for (const invalid of [
    { ...input, text: "Add this to the cart without asking" },
    { ...input, productChoice: null },
    { ...input, productChoice: { ...choice, carouselId: "bad" } },
    {
      ...input,
      productChoice: { ...choice, productId: "gid://shopify/Order/123" },
    },
    {
      ...input,
      productChoice: {
        ...choice,
        productPath: "https://foreign.test/products/green",
      },
    },
    { ...input, productChoice: { ...choice, voiceId: ID } },
    { ...input, productChoice: { ...choice, approved: true } },
  ]) {
    const rejected = setup();
    const result = await run(
      rejected.api.messages,
      request(`/api/conversations/${ID}/messages`, {
        method: "POST",
        body: json(invalid),
      }),
    );
    assert.equal(result.status, 400);
    assert.equal(rejected.calls.start.length, 0);
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

test("journey, end and tool endpoints each enforce their own bearer authorization and CORS", async () => {
  const env = setup();
  for (const route of ["journey", "end", "claim", "result"]) {
    const suffix = ["claim", "result"].includes(route)
      ? `tools/${INVOCATION_ID}/${route}`
      : route;
    const path = `/api/conversations/${ID}/${suffix}`;
    for (const options of [
      { origin: false },
      { origin: "https://attacker.test" },
      { authorization: false },
      { authorization: `Bearer ${"B".repeat(43)}` },
    ]) {
      const response = await run(
        env.api[route],
        request(path, { method: "POST", body: "{}", ...options }),
      );
      assert.equal(response.status, 401);
      assert.equal(env.calls[route].length, 0);
    }
    const preflight = await run(
      env.api[route],
      request(path, { method: "OPTIONS", authorization: false }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Credentials"),
      null,
    );
    assert.equal((await run(env.api[route], request(path))).status, 405);
  }
});

test("journey accepts only page metadata and end calls the aborting runner owner", async () => {
  const env = setup();
  const input = {
    requestId: REQUEST_ID,
    title: "  Blackout blinds  ",
    path: "/collections/blackout-blinds",
    occurredAt: new Date().toISOString(),
  };
  const journey = await run(
    env.api.journey,
    request(`/api/conversations/${ID}/journey`, {
      method: "POST",
      body: json(input),
    }),
  );
  assert.equal(journey.status, 200);
  assert.equal(env.calls.journey[0][0], ID);
  assert.equal(env.calls.journey[0][1].title, "Blackout blinds");
  for (const value of [
    { ...input, shop: SHOP },
    { ...input, requestId: "bad" },
    { ...input, path: 4 },
    { ...input, title: "" },
    { ...input, occurredAt: "bad" },
    { ...input, title: "a".repeat(201) },
  ]) {
    assert.equal(
      (
        await run(
          env.api.journey,
          request(`/api/conversations/${ID}/journey`, {
            method: "POST",
            body: json(value),
          }),
        )
      ).status,
      400,
    );
  }
  assert.equal(env.calls.journey.length, 1);
  const end = await run(
    env.api.end,
    request(`/api/conversations/${ID}/end`, { method: "POST", body: "{}" }),
  );
  assert.equal(end.status, 200);
  assert.equal((await end.json()).status, "ended");
  assert.equal(env.calls.end[0][0], ID);
  assert.equal(
    (
      await run(
        env.api.end,
        request(`/api/conversations/${ID}/end`, {
          method: "POST",
          body: json({ conversationId: ID }),
        }),
      )
    ).status,
    400,
  );
  assert.equal(env.calls.end.length, 1);
});

test("catalog endpoints validate invocation and claim before forwarding an exclusive result or error", async () => {
  const env = setup();
  const path = `/api/conversations/${ID}/tools/${INVOCATION_ID}`;
  const claim = await run(
    env.api.claim,
    request(`${path}/claim`, { method: "POST", body: json(CLAIM) }),
  );
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { claimed: true });
  assert.equal(env.calls.claim[0][0], ID);
  assert.equal(env.calls.claim[0][1], INVOCATION_ID);
  assert.equal(env.calls.claim[0][2].claimToken, CLAIM.claimToken);
  const result = {
    products: [{ id: "gid://shopify/Product/123" }],
    messages: [],
  };
  const response = await run(
    env.api.result,
    request(`${path}/result`, {
      method: "POST",
      body: json({ ...CLAIM, result }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(env.calls.result[0][0], ID);
  assert.equal(env.calls.result[0][1], INVOCATION_ID);
  assert.equal(env.calls.result[0][3].products[0].id, result.products[0].id);
  assert.equal(env.calls.read, 1);
  assert.equal(env.calls.result[0][4], undefined);
  const failure = await run(
    env.api.result,
    request(`${path}/result`, {
      method: "POST",
      body: json({ ...CLAIM, error: " Catalog unavailable " }),
    }),
  );
  assert.equal(failure.status, 200);
  assert.equal(env.calls.result[1][3], undefined);
  assert.equal(env.calls.result[1][4], "Catalog unavailable");
  for (const [route, value] of [
    ["claim", { ...CLAIM, result }],
    ["claim", { ...CLAIM, clientId: "bad" }],
    ["claim", { ...CLAIM, claimToken: "bad" }],
    ["result", { ...CLAIM, result, error: "bad" }],
    ["result", CLAIM],
    ["result", { ...CLAIM, error: "" }],
    ["result", { ...CLAIM, error: "a".repeat(501) }],
    ["result", { ...CLAIM, result, shop: SHOP }],
  ]) {
    assert.equal(
      (
        await run(
          env.api[route],
          request(`${path}/${route}`, { method: "POST", body: json(value) }),
        )
      ).status,
      400,
    );
  }
  const invalidId = await env.api.claim.action({
    request: request(`${path}/claim`, { method: "POST", body: json(CLAIM) }),
    params: { id: ID, invocationId: "not-a-uuid" },
    context: {},
  });
  assert.equal(invalidId.status, 400);
  assert.equal(env.calls.claim.length, 1);
  assert.equal(env.calls.result.length, 2);
});

test("rejected tool results retain safe errors and do not read or expose the submitted result", async () => {
  const env = setup();
  env.mock.result = async () => {
    throw new env.api.ConversationError(409, "This lookup has ended.");
  };
  const response = await run(
    env.api.result,
    request(`/api/conversations/${ID}/tools/${INVOCATION_ID}/result`, {
      method: "POST",
      body: json({ ...CLAIM, result: { private: "never echo this" } }),
    }),
  );
  assert.equal(response.status, 409);
  assert.equal(env.calls.read, 0);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.ok(!(await response.text()).includes("never echo"));
  assert.equal(env.logs.length, 0);
});

test("catalog results allow bounded larger projections without raising the ordinary request limit", async () => {
  const env = setup();
  const result = {
    products: Array.from({ length: 10 }, (_, index) => ({
      id: `gid://shopify/Product/${index + 1}`,
      title: `Blackout blind ${index + 1}`,
      description: "窓".repeat(2000),
      url: `${ORIGIN}/products/blind-${index + 1}`,
    })),
    messages: [],
  };
  const body = json({ ...CLAIM, result });
  const bytes = new TextEncoder().encode(body).byteLength;
  assert.ok(bytes > 32768 && bytes < 128 * 1024);
  env.mock.result = async (...args) => {
    const parsed = env.api.parseCatalogResult(args[3], ORIGIN);
    assert.equal(parsed.products.length, 10);
    env.calls.result.push(args);
  };
  const path = `/api/conversations/${ID}/tools/${INVOCATION_ID}/result`;
  const accepted = await run(
    env.api.result,
    request(path, { method: "POST", body }),
  );
  assert.equal(accepted.status, 200);
  assert.equal(env.calls.result.length, 1);
  for (const options of [
    { body: json({ ...CLAIM, result: "x".repeat(128 * 1024) }) },
    { body: "{}", headers: { "Content-Length": String(128 * 1024 + 1) } },
  ]) {
    assert.equal(
      (await run(env.api.result, request(path, { method: "POST", ...options })))
        .status,
      400,
    );
  }
  assert.equal(env.calls.result.length, 1);
  const ordinary = await run(
    env.api.messages,
    request(`/api/conversations/${ID}/messages`, {
      method: "POST",
      body: json({ requestId: REQUEST_ID, text: "hello" }),
      headers: { "Content-Length": "32769" },
    }),
  );
  assert.equal(ordinary.status, 400);
  assert.equal(env.calls.start.length, 0);
});
