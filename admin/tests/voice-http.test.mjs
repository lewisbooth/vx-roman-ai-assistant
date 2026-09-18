import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: `
      export * as start from "./admin/routes/api.conversations.$id.voice.ts";
      export * as ready from "./admin/routes/api.conversations.$id.voice.$voiceId.ready.ts";
      export * as heartbeat from "./admin/routes/api.conversations.$id.voice.$voiceId.heartbeat.ts";
      export * as stop from "./admin/routes/api.conversations.$id.voice.$voiceId.stop.ts";
      export * as answers from "./admin/routes/api.conversations.$id.voice.$voiceId.answers.ts";
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
      name: "voice-http-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /(?:shopify|repository|runner|service)\.server$/ },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.endsWith("shopify.server")
            ? "export const authenticate={};"
            : args.path.endsWith("repository.server")
              ? "export const authorizeCredential=(...args)=>mock.authorize(...args);"
              : args.path.endsWith("runner.server")
                ? "export const readConversation=(...args)=>mock.read(...args);"
                : `export const startVoice=(...args)=>mock.start(...args);
                 export const readyVoice=(...args)=>mock.ready(...args);
                 export const heartbeatVoice=(...args)=>mock.heartbeat(...args);
                 export const stopVoice=(...args)=>mock.stop(...args);
                 export const answerVoiceQuestion=(...args)=>mock.answers(...args);`,
        }));
      },
    },
  ],
});

const ID = "8e251a70-d0d7-456b-bc61-cfa7678bfc13";
const VOICE_ID = "1b65d343-3010-4f5e-b026-daa94a2e1087";
const REQUEST_ID = "68055cf5-a781-4c1d-a792-42861808b2c7";
const CLIENT_ID = "8c06c56e-5d17-47ec-b1ae-8d1d82088908";
const TOKEN = "A".repeat(43);
const ORIGIN = "https://hd-dev-single.myshopify.com";
const START = {
  requestId: REQUEST_ID,
  clientId: CLIENT_ID,
  sdp: "v=0\r\nsynthetic-offer\r\n",
};
const ANSWER = {
  clientId: CLIENT_ID,
  requestId: REQUEST_ID,
  questionId: "a6b2cb3f-6e6c-4607-a2ef-382d94d928e3",
  answer: "Kitchen",
};
const SNAPSHOT = {
  id: ID,
  status: "active",
  revision: 5,
  messages: [],
  tools: [],
  busy: false,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup() {
  const calls = {
    authorize: [],
    start: [],
    ready: [],
    heartbeat: [],
    stop: [],
    answers: [],
    read: [],
    order: [],
  };
  const logs = [];
  let api;
  const mock = {
    authorize: async (id, token) => {
      calls.authorize.push({ id, token });
      if (id !== ID || token !== TOKEN)
        throw new api.ConversationError(
          401,
          "Conversation authorization failed.",
        );
      return { id: ID, shop: "hd-dev-single.myshopify.com", origin: ORIGIN };
    },
    start: async (...args) => {
      calls.start.push(plain(args));
      return { voiceId: VOICE_ID, sdp: "synthetic-answer" };
    },
    ready: (...args) => {
      calls.ready.push(plain(args));
    },
    heartbeat: async (...args) => {
      calls.heartbeat.push(plain(args));
    },
    stop: async (...args) => {
      calls.stop.push(plain(args));
      calls.order.push("stop");
    },
    answers: async (...args) => {
      calls.answers.push(plain(args));
      calls.order.push("answers");
    },
    read: async (...args) => {
      calls.read.push(plain(args));
      calls.order.push("read");
      return SNAPSHOT;
    },
  };
  const module = { exports: {} };
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
    Buffer,
    console: { error: (...args) => logs.push(plain(args)) },
  });
  api = module.exports;
  return { api, mock, calls, logs };
}

function request(route, options = {}) {
  const {
    method = "POST",
    body = route === "start"
      ? START
      : route === "answers"
        ? ANSWER
        : { clientId: CLIENT_ID },
    origin = ORIGIN,
    authorization = `Bearer ${TOKEN}`,
    headers: extra = {},
  } = options;
  const suffix = route === "start" ? "" : `/${VOICE_ID}/${route}`;
  const headers = new Headers(extra);
  if (origin !== false) headers.set("Origin", origin);
  if (authorization !== false) headers.set("Authorization", authorization);
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  if (method !== "GET" && method !== "HEAD" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return new Request(
    `https://roman.example/api/conversations/${ID}/voice${suffix}`,
    {
      method,
      headers,
      ...(method !== "GET" && method !== "HEAD" ? { body: bodyText } : {}),
    },
  );
}

const run = (env, route, req = request(route), params = {}) =>
  env.api[route].action({
    request: req,
    params: { id: ID, voiceId: VOICE_ID, ...params },
    context: {},
  });

test("voice start authorizes the conversation and passes only the validated offer", async () => {
  const env = setup();
  const response = await run(env, "start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    voiceId: VOICE_ID,
    sdp: "synthetic-answer",
  });
  assert.deepEqual(env.calls.authorize, [{ id: ID, token: TOKEN }]);
  assert.deepEqual(env.calls.start, [[ID, { ...START, voice: "marin" }]]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("voice lifecycle routes authenticate independently and retain conversation/client scope", async () => {
  for (const route of ["ready", "heartbeat", "stop"]) {
    const env = setup();
    const response = await run(env, route);
    assert.equal(response.status, 200);
    assert.equal(env.calls.authorize.length, 1);
    assert.deepEqual(env.calls[route], [
      route !== "heartbeat"
        ? [ID, VOICE_ID, CLIENT_ID, null]
        : [ID, VOICE_ID, CLIENT_ID],
    ]);
    assert.deepEqual(
      await response.json(),
      route !== "stop" ? { ok: true } : SNAPSHOT,
    );
    assert.deepEqual(env.calls.order, route === "stop" ? ["stop", "read"] : []);
  }
});

test("every voice endpoint rejects absent or incorrect bearer/origin authorization before work", async (t) => {
  for (const route of ["start", "ready", "heartbeat", "stop", "answers"]) {
    for (const invalid of [
      { authorization: false },
      { authorization: `Bearer ${"B".repeat(43)}` },
      { origin: false },
      { origin: "https://untrusted.example" },
      { origin: "https://hd-dev-multi.myshopify.com" },
    ]) {
      await t.test(`${route}: ${JSON.stringify(invalid)}`, async () => {
        const env = setup();
        const response = await run(env, route, request(route, invalid));
        assert.equal(response.status, 401);
        assert.equal(
          env.calls.start.length +
            env.calls.ready.length +
            env.calls.heartbeat.length +
            env.calls.answers.length +
            env.calls.stop.length +
            env.calls.read.length,
          0,
        );
      });
    }
  }
});

test("each voice endpoint rejects an invalid conversation ID and only permits POST", async () => {
  for (const route of ["start", "ready", "heartbeat", "stop", "answers"]) {
    const env = setup();
    assert.equal(
      (await run(env, route, request(route), { id: "not-a-uuid" })).status,
      401,
    );
    const response = await env.api[route].loader({
      request: request(route, { method: "GET" }),
      params: { id: ID, voiceId: VOICE_ID },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
    assert.equal(
      env.calls.start.length +
        env.calls.ready.length +
        env.calls.heartbeat.length +
        env.calls.stop.length,
      0,
    );
  }
});

test("voice preflight remains restricted to allowed storefronts without issuing a session", async () => {
  for (const route of ["start", "ready", "heartbeat", "stop", "answers"]) {
    const env = setup();
    assert.equal(
      (
        await run(
          env,
          route,
          request(route, { method: "OPTIONS", authorization: false }),
        )
      ).status,
      204,
    );
    const denied = await run(
      env,
      route,
      request(route, {
        method: "OPTIONS",
        origin: "https://untrusted.example",
        authorization: false,
      }),
    );
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(env.calls.authorize.length, 0);
    assert.equal(
      env.calls.start.length +
        env.calls.ready.length +
        env.calls.heartbeat.length +
        env.calls.stop.length,
      0,
    );
  }
});

test("start accepts a bounded SDP offer and rejects unexpected fields or invalid voices", async (t) => {
  const invalid = [
    {},
    { ...START, requestId: "invalid" },
    { ...START, clientId: "invalid" },
    { clientId: CLIENT_ID, sdp: START.sdp },
    { requestId: REQUEST_ID, sdp: START.sdp },
    { ...START, sdp: "" },
    { ...START, sdp: "  " },
    { ...START, sdp: null },
    ...[null, "", "unknown", {}, { id: "custom" }].map((voice) => ({
      ...START,
      voice,
    })),
    { ...START, providerId: "live_forged" },
    { ...START, transcript: "forged caption" },
    { ...START, sdp: "x".repeat(48 * 1024 + 1) },
    { ...START, sdp: "中".repeat(16 * 1024 + 1) },
  ];
  for (let index = 0; index < invalid.length; index++) {
    await t.test(`invalid offer ${index}`, async () => {
      const env = setup();
      const response = await run(
        env,
        "start",
        request("start", { body: invalid[index] }),
      );
      assert.equal(response.status, 400);
      assert.equal(env.calls.start.length, 0);
      assert.equal(env.logs.length, 0);
      assert.doesNotMatch(await response.text(), /forged caption|live_forged/);
    });
  }
  const env = setup();
  const input = { ...START, sdp: "x".repeat(48 * 1024) };
  assert.equal(
    (await run(env, "start", request("start", { body: input }))).status,
    200,
  );
  assert.deepEqual(env.calls.start, [[ID, { ...input, voice: "marin" }]]);
});

test("start accepts each built-in voice and passes the validated selection", async () => {
  const source = await import("node:fs/promises");
  const sdk = await source.readFile(
    "node_modules/openai/src/resources/live/live.ts",
    "utf8",
  );
  const choices = sdk
    .match(/export type BuiltInVoice =([\s\S]*?);/)[1]
    .matchAll(/'([^']+)'/g);
  for (const [, voice] of choices) {
    const env = setup();
    const input = { ...START, voice };
    assert.equal(
      (await run(env, "start", request("start", { body: input }))).status,
      200,
    );
    assert.deepEqual(env.calls.start, [[ID, input]]);
  }
});

test("preflight permission is cached while actual data stays uncached and authenticated", async () => {
  const env = setup();
  const preflight = await run(
    env,
    "ready",
    request("ready", { method: "OPTIONS", authorization: false }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Max-Age"), "600");
  const denied = await run(
    env,
    "ready",
    request("ready", { authorization: false }),
  );
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("Cache-Control"), "no-store");
  assert.equal(denied.headers.get("Access-Control-Max-Age"), null);
  assert.equal(env.calls.ready.length, 0);
});

test("start enforces 64 KiB on streamed body and declared Content-Length", async () => {
  for (const headers of [
    { "Content-Length": String(64 * 1024 + 1) },
    { "Content-Length": "invalid" },
  ]) {
    const env = setup();
    assert.equal(
      (await run(env, "start", request("start", { headers }))).status,
      400,
    );
    assert.equal(env.calls.start.length, 0);
  }
  const env = setup();
  const response = await run(
    env,
    "start",
    request("start", { body: JSON.stringify(START) + " ".repeat(64 * 1024) }),
  );
  assert.equal(response.status, 400);
  assert.equal(env.calls.start.length, 0);
});

test("voice requests require valid JSON objects and an application/json content type", async () => {
  for (const route of ["start", "ready", "heartbeat", "stop", "answers"]) {
    for (const body of ["{bad", "[]", "null"]) {
      const env = setup();
      assert.equal(
        (await run(env, route, request(route, { body }))).status,
        400,
      );
      assert.equal(env.calls[route].length, 0);
    }
    const env = setup();
    assert.equal(
      (
        await run(
          env,
          route,
          request(route, { headers: { "Content-Type": "text/plain" } }),
        )
      ).status,
      400,
    );
    assert.equal(env.calls[route].length, 0);
  }
});

test("voice lifecycle routes require owned UUIDs and reject unrelated body fields", async () => {
  for (const route of ["ready", "heartbeat", "stop"]) {
    for (const voiceId of [undefined, "not-a-uuid", "live_provider_id"]) {
      const env = setup();
      assert.equal(
        (await run(env, route, request(route), { voiceId })).status,
        400,
      );
      assert.equal(env.calls[route].length, 0);
    }
    for (const body of [
      {},
      { clientId: "invalid" },
      { clientId: CLIENT_ID, sdp: "injected" },
      { clientId: CLIENT_ID, transcript: "injected" },
    ]) {
      const env = setup();
      assert.equal(
        (await run(env, route, request(route, { body }))).status,
        400,
      );
      assert.equal(env.calls[route].length, 0);
    }
  }
});

test("only stop accepts the categorical connection-lost reason, never client error text", async () => {
  const env = setup();
  const response = await run(
    env,
    "stop",
    request("stop", {
      body: { clientId: CLIENT_ID, reason: "connection_lost" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(env.calls.stop, [
    [ID, VOICE_ID, CLIENT_ID, "connection_lost"],
  ]);
  assert.deepEqual(env.calls.order, ["stop", "read"]);
  for (const route of ["ready", "heartbeat"])
    assert.equal(
      (
        await run(
          env,
          route,
          request(route, {
            body: { clientId: CLIENT_ID, reason: "connection_lost" },
          }),
        )
      ).status,
      400,
    );
  for (const body of [
    { clientId: CLIENT_ID, reason: "PRIVATE_ERROR" },
    { clientId: CLIENT_ID, reason: null },
    { clientId: CLIENT_ID, reason: false },
    { clientId: CLIENT_ID, reason: { type: "connection_lost" } },
    { clientId: CLIENT_ID, reason: "connection_lost", error: "PRIVATE_ERROR" },
    { reason: "connection_lost" },
  ]) {
    const rejected = await run(env, "stop", request("stop", { body }));
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(await rejected.text(), /PRIVATE_ERROR/);
  }
  assert.equal(env.calls.stop.length, 1);
  assert.deepEqual(env.logs, []);
});

test("ownership conflicts retain their status and stop cannot read after rejection", async () => {
  for (const route of ["start", "ready", "heartbeat", "stop", "answers"]) {
    const env = setup();
    env.mock[route] = () => {
      throw new env.api.ConversationError(
        409,
        "Voice belongs to another browser.",
      );
    };
    const response = await run(env, route);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "busy");
    assert.equal(env.calls.read.length, 0);
    assert.equal(env.logs.length, 0);
  }
});

test("unexpected provider failures do not expose connection data or customer text", async () => {
  const env = setup();
  env.mock.start = async () => {
    throw new Error("private-key SDP and customer caption");
  };
  const response = await run(env, "start");
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /private-key|SDP|caption/);
  assert.doesNotMatch(JSON.stringify(env.logs), /private-key|SDP|caption/);
  assert.equal(env.logs.length, 1);
});

test("voice answer authorizes independently, sends only a validated selection and returns its durable snapshot", async () => {
  const env = setup();
  const response = await run(env, "answers");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), SNAPSHOT);
  assert.deepEqual(env.calls.answers, [[ID, VOICE_ID, ANSWER]]);
  assert.deepEqual(env.calls.order, ["answers", "read"]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("voice product choices accept a bounded carousel reference and reject extra or unsafe fields", async () => {
  const choice = {
    clientId: CLIENT_ID,
    requestId: REQUEST_ID,
    carouselId: ANSWER.questionId,
    productId: "gid://shopify/Product/123",
    title: "Green roller blind",
    productPath: "/products/green-roller",
  };
  const env = setup();
  assert.equal(
    (await run(env, "answers", request("answers", { body: choice }))).status,
    200,
  );
  assert.deepEqual(env.calls.answers, [[ID, VOICE_ID, choice]]);
  for (const changed of [
    { productPath: "/cart/add" },
    { productPath: "https://foreign.test/products/example" },
    { title: "x".repeat(201) },
    { productId: "123" },
    { carouselId: "bad" },
    { questionId: ANSWER.questionId },
    { confirmed: true },
    { clientId: "bad" },
  ]) {
    const invalid = setup();
    assert.equal(
      (
        await run(
          invalid,
          "answers",
          request("answers", { body: { ...choice, ...changed } }),
        )
      ).status,
      400,
    );
    assert.equal(invalid.calls.answers.length, 0);
  }
});

test("voice accepts trimmed customer text without interpreting it as an offered answer or tool", async () => {
  const input = {
    clientId: CLIENT_ID,
    requestId: REQUEST_ID,
    text: "  Help me measure my windows.  ",
  };
  const env = setup();
  assert.equal(
    (await run(env, "answers", request("answers", { body: input }))).status,
    200,
  );
  assert.deepEqual(env.calls.answers, [
    [ID, VOICE_ID, { ...input, text: input.text.trim() }],
  ]);
  for (const changed of [
    { text: " " },
    { text: "x".repeat(4001) },
    { text: 42 },
    { requestId: "bad" },
    { clientId: "bad" },
    { questionId: ANSWER.questionId },
    { answer: "Kitchen" },
    { confirmed: true },
    { voiceId: VOICE_ID },
  ]) {
    const invalid = setup();
    assert.equal(
      (
        await run(
          invalid,
          "answers",
          request("answers", { body: { ...input, ...changed } }),
        )
      ).status,
      400,
    );
    assert.equal(invalid.calls.answers.length, 0);
  }
});

test("voice readiness accepts only a bounded first customer input alongside its owner", async () => {
  const body = {
    clientId: CLIENT_ID,
    input: { requestId: REQUEST_ID, text: "  Find my style. " },
  };
  const env = setup();
  assert.equal(
    (await run(env, "ready", request("ready", { body }))).status,
    200,
  );
  assert.deepEqual(env.calls.ready, [
    [
      ID,
      VOICE_ID,
      CLIENT_ID,
      { requestId: REQUEST_ID, text: "Find my style." },
    ],
  ]);
  for (const input of [
    null,
    [],
    {},
    { text: "Hello" },
    { requestId: REQUEST_ID, text: " " },
    { requestId: REQUEST_ID, text: "x".repeat(4001) },
    { requestId: "bad", text: "Hello" },
    { requestId: REQUEST_ID, text: "Hello", clientId: CLIENT_ID },
    { requestId: REQUEST_ID, text: "Hello", confirmed: true },
  ]) {
    const invalid = setup();
    assert.equal(
      (
        await run(
          invalid,
          "ready",
          request("ready", { body: { ...body, input } }),
        )
      ).status,
      400,
    );
    assert.equal(invalid.calls.ready.length, 0);
  }
  assert.equal(
    (
      await run(
        setup(),
        "ready",
        request("ready", { body: { ...body, extra: true } }),
      )
    ).status,
    400,
  );
});

test("voice answers reject forged fields, invalid IDs and non-offered input shapes before service work", async () => {
  for (const body of [
    {},
    { ...ANSWER, questionId: "invalid" },
    { ...ANSWER, clientId: "invalid" },
    { ...ANSWER, requestId: "invalid" },
    { ...ANSWER, answer: " " },
    { ...ANSWER, answer: "x".repeat(81) },
    { ...ANSWER, answer: 4 },
    { ...ANSWER, transcript: "forged voice caption" },
    { ...ANSWER, providerId: "live_forged" },
  ]) {
    const env = setup();
    const response = await run(env, "answers", request("answers", { body }));
    assert.equal(response.status, 400);
    assert.equal(env.calls.answers.length, 0);
    assert.equal(env.calls.read.length, 0);
  }
  const env = setup();
  assert.equal(
    (await run(env, "answers", request("answers"), { voiceId: "invalid" }))
      .status,
    400,
  );
});

test("accepted but unconfirmed voice answers report a safe actionable failure without issuing a second read or send", async () => {
  const env = setup();
  env.mock.answers = () => {
    throw new env.api.ConversationError(
      503,
      "Your answer was saved, but Roman could not confirm it reached voice.",
    );
  };
  const response = await run(env, "answers");
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /answer was saved/);
  assert.equal(env.calls.read.length, 0);
});
