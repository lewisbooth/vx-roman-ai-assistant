import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
class StubAPIError extends Error {
  constructor(status, code) {
    super("Provider error body must not be logged.");
    this.status = status;
    this.code = code;
  }
}
class StubAPIConnectionError extends StubAPIError {
  constructor() {
    super(undefined, undefined);
    this.name = "Error"; // The installed SDK uses this generic name.
  }
}
const bundle = await build({
  stdin: {
    contents: `export * from "./admin/conversations/model.server.ts";
      export * from "./admin/conversations/availability.server.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "model-api",
      setup(build) {
        build.onResolve({ filter: /api-errors\/repository\.server$/ }, (args) => ({
          path: args.path,
          namespace: "incidents",
        }));
        build.onLoad({ filter: /.*/, namespace: "incidents" }, () => ({
          contents: `export const getApiAvailability=async()=>mock.availability;
            export const setApiAvailability=async(state)=>{mock.availability=state;mock.incidents.push(state)};`,
        }));
        build.onResolve({ filter: /^openai$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export default class OpenAI { static APIError = mock.APIError; static APIConnectionError = mock.APIConnectionError; constructor() { this.responses={create:(...args)=>mock.create(...args)}; } }`,
        }));
      },
    },
  ],
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const tokens = (input, output, cached = 0, reasoning = 0) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
  input_tokens_details: { cached_tokens: cached },
  output_tokens_details: { reasoning_tokens: reasoning },
});
const terminal = (
  status = "completed",
  usage = tokens(10, 5),
  output = [
    {
      type: "function_call",
      name: "ask_question",
      call_id: "synthetic-question",
      arguments: JSON.stringify({
        message: "Synthetic reply.",
        question: "Which room are you shopping for?",
        answers: ["Bedroom", "Kitchen"],
      }),
    },
  ],
) => ({
  type: `response.${status}`,
  response: {
    model: "gpt-5.6-terra-observed",
    service_tier: "priority",
    usage,
    output,
  },
});
const toolRound = () =>
  terminal("completed", tokens(20, 5, 10, 2), [
    {
      type: "function_call",
      name: "search_products",
      call_id: "tool_call_1",
      arguments: '{"query":"synthetic blackout"}',
    },
  ]);
function setup(scripts, initialAvailability = "healthy") {
  const records = [];
  const requests = [];
  const incidents = [];
  const timers = [];
  const controller = new AbortController();
  const mock = {
    APIError: StubAPIError,
    APIConnectionError: StubAPIConnectionError,
    availability: initialAvailability,
    incidents,
    create: async (...args) => {
      requests.push(args);
      const script = scripts.shift();
      assert.ok(script, "Unexpected provider request");
      return script();
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, unref() {}, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cancelled = true;
    },
  });
  const record = async (value) => records.push(plain(value));
  return {
    records,
    requests,
    incidents,
    timers,
    status: () => module.exports.getAvailabilityStatus(),
    tick: async () => {
      const timer = timers.find((item) => !item.cancelled && !item.ran);
      assert.ok(timer, "Expected a pending recovery probe");
      timer.ran = true;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return timer.ms;
    },
    controller,
    diagnostics: module.exports.providerFailureDiagnostics,
    run: (onUsage = record, options = {}) =>
      module.exports.generateReply(
        [{ role: "user", text: "Private synthetic test request." }],
        () => {},
        controller.signal,
        options.execute ?? (async () => ({ products: [], messages: [] })),
        options.mode ?? "text",
        onUsage,
        options.origin,
        options.resumeQuestion,
      ),
  };
}
const events = (...values) =>
  async function* () {
    yield* values;
  };

test("a primary access rejection falls back before output and records both attempts", async () => {
  const rejection = new StubAPIError(403, "model_not_found");
  const app = setup([
    async () => {
      throw rejection;
    },
    events(terminal()),
  ]);
  const reply = await app.run();
  assert.equal(
    reply.questionPresentation.question,
    "Which room are you shopping for?",
  );
  assert.equal(app.requests.length, 2);
  assert.deepEqual(
    app.requests.map(([request]) => request.model),
    ["gpt-6-luna", "gpt-5.6-luna"],
  );
  assert.deepEqual(
    app.records.map((entry) => entry.status),
    ["pending", "unavailable", "pending", "completed"],
  );
  assert.deepEqual(
    app.records.filter((entry) => entry.status === "pending").map((entry) => entry.model),
    ["gpt-6-luna", "gpt-5.6-luna"],
  );
  assert.deepEqual(app.incidents, ["fallback"]);
  assert.equal(await app.status(), "degraded");
  assert.deepEqual(plain(app.diagnostics(rejection)), {
    providerHttpStatus: 403,
    providerCode: "model_not_found",
  });
  assert.doesNotMatch(
    JSON.stringify(app.diagnostics(rejection)),
    /Provider error body/,
  );
});

test("both model rejections suspend service without losing usage attempts", async () => {
  const rejection = new StubAPIError(403, "model_not_found");
  const app = setup([
    async () => {
      throw rejection;
    },
    async () => {
      throw rejection;
    },
  ]);
  await assert.rejects(app.run(), (error) => error === rejection);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(
    app.records.map((entry) => entry.status),
    ["pending", "unavailable", "pending", "unavailable"],
  );
  assert.deepEqual(app.incidents, ["fallback", "outage"]);
  assert.equal(await app.status(), "suspended");
  await assert.rejects(app.run(), { status: 503 });
  assert.equal(app.requests.length, 2);
});

test("provider rate limits use the fallback, but invalid prompts do not", async () => {
  const rejection = new StubAPIError(429, "rate_limit_exceeded");
  const app = setup([
    async () => {
      throw rejection;
    },
    events(terminal()),
  ]);
  await app.run();
  assert.equal(app.requests.length, 2);
  assert.deepEqual(plain(app.diagnostics(rejection)), {
    providerHttpStatus: 429,
    providerCode: "rate_limit_exceeded",
  });
  const invalid = new StubAPIError(400, "invalid_prompt");
  const rejected = setup([async () => { throw invalid; }]);
  await assert.rejects(rejected.run(), (error) => error === invalid);
  assert.equal(rejected.requests.length, 1);
  assert.deepEqual(rejected.incidents, []);
});

test("connection, authentication and model access failures trigger fallback, while policy failures do not", async () => {
  const failures = [
    new StubAPIConnectionError(),
    new StubAPIError(401, "invalid_api_key"),
    new StubAPIError(403, "permission_denied"),
    new StubAPIError(404, "model_not_found"),
  ];
  for (const failure of failures) {
    const app = setup([
      async () => { throw failure; },
      events(terminal()),
    ]);
    await app.run();
    assert.deepEqual(app.requests.map(([request]) => request.model), [
      "gpt-6-luna",
      "gpt-5.6-luna",
    ]);
    assert.equal(await app.status(), "degraded");
  }
  const policy = new StubAPIError(403, "bio_policy");
  const blocked = setup([async () => { throw policy; }]);
  await assert.rejects(blocked.run(), (error) => error === policy);
  assert.equal(blocked.requests.length, 1);
  assert.equal(await blocked.status(), "available");
});

test("suspended service probes both models with capped backoff and resumes on fallback recovery", async () => {
  const unavailable = new StubAPIError(503, "server_error");
  const scripts = [
    async () => { throw unavailable; },
    async () => { throw unavailable; },
    ...Array.from({ length: 6 }, () => [
      async () => { throw unavailable; },
      async () => { throw unavailable; },
    ]).flat(),
    async () => { throw unavailable; },
    async () => ({ status: "completed" }),
    async () => ({ status: "completed" }),
  ];
  const app = setup(scripts);
  await assert.rejects(app.run(), (error) => error === unavailable);
  assert.equal(await app.status(), "suspended");
  const delays = [];
  for (let index = 0; index < 6; index++) delays.push(await app.tick());
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  assert.equal(await app.status(), "suspended");
  assert.equal(await app.tick(), 30_000);
  assert.equal(await app.status(), "degraded");
  assert.equal(await app.tick(), 1_000);
  assert.equal(await app.status(), "available");
  assert.deepEqual(app.incidents, ["fallback", "outage", "fallback", "healthy"]);
  assert.equal(app.requests.slice(2).every(([request]) => request.input === "Reply with OK."), true);
  assert.equal(app.requests.slice(2).every(([request]) => request.max_output_tokens === 256), true);
});

test("a later provider round falls back using prior tool results without replaying the action", async () => {
  const unavailable = new StubAPIError(503, "server_error");
  const first = toolRound();
  first.response.output.unshift({
    type: "reasoning",
    id: "reasoning-from-primary",
    encrypted_content: "opaque-model-specific-state",
  });
  const app = setup([
    events(first),
    async () => { throw unavailable; },
    events(terminal()),
  ]);
  let actions = 0;
  await app.run(undefined, {
    execute: async () => {
      actions++;
      return { products: [], messages: [] };
    },
  });
  assert.equal(actions, 1);
  assert.deepEqual(app.requests.map(([request]) => request.model), [
    "gpt-6-luna",
    "gpt-6-luna",
    "gpt-5.6-luna",
  ]);
  assert.equal(app.requests[2][0].input.some((item) => item.type === "function_call_output"), true);
  assert.equal(app.requests[1][0].input.some((item) => item.type === "reasoning"), true);
  assert.equal(app.requests[2][0].input.some((item) => item.type === "reasoning"), false);
});

test("a persisted outage remains suspended after restart until a probe succeeds", async () => {
  const app = setup([async () => ({ status: "completed" })], "outage");
  assert.equal(await app.status(), "suspended");
  assert.equal(app.requests.length, 0);
  assert.equal(await app.tick(), 1_000);
  assert.equal(await app.status(), "available");
  assert.deepEqual(app.incidents, ["healthy"]);
});

test("every tool round records a durable attempt and its own provider-reported usage", async () => {
  const app = setup([
    events(toolRound()),
    events(terminal("completed", tokens(40, 8, 25, 3))),
  ]);
  await app.run(async (usage) => {
    app.records.push(plain(usage));
    if (usage.status === "pending")
      assert.equal(
        app.requests.length,
        app.records.filter((r) => r.status === "pending").length - 1,
      );
  });
  assert.deepEqual(
    app.records.map((r) => r.status),
    ["pending", "completed", "pending", "completed"],
  );
  assert.equal(app.records[0].id, app.records[1].id);
  assert.equal(app.records[2].id, app.records[3].id);
  assert.notEqual(app.records[0].id, app.records[2].id);
  const reported = app.records.filter((r) => r.status === "completed");
  assert.equal(
    reported.reduce((sum, r) => sum + r.totalTokens, 0),
    73,
  );
  assert.deepEqual(
    reported.map((r) => [r.cachedInputTokens, r.reasoningTokens]),
    [
      [10, 2],
      [25, 3],
    ],
  );
  assert.ok(
    reported.every(
      (r) =>
        r.model === "gpt-5.6-terra-observed" && r.serviceTier === "priority",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(app.records),
    /Private synthetic|Synthetic reply|tool_call_1|blackout/,
  );
});

for (const status of ["failed", "incomplete"]) {
  test(`a ${status} terminal event preserves its usage and earlier successful tool rounds`, async () => {
    const app = setup([
      events(toolRound()),
      events(terminal(status, tokens(30, 4, 10, 1))),
    ]);
    await assert.rejects(app.run(), /did not complete/);
    assert.deepEqual(
      app.records.map((r) => r.status),
      ["pending", "completed", "pending", status],
    );
    assert.equal(app.records[1].totalTokens, 25);
    assert.equal(app.records[3].totalTokens, 34);
  });
}

test("missing and invalid numeric usage remains unavailable while genuine zero is preserved", async () => {
  for (const [usage, expected] of [
    [null, [null, null, null, null, null]],
    [tokens(0, 0), [0, 0, 0, 0, 0]],
    [
      {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: -1,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: NaN },
      },
      [5, null, 2, null, null],
    ],
  ]) {
    const app = setup([events(terminal("completed", usage))]);
    await app.run();
    const last = app.records.at(-1);
    assert.deepEqual(
      [
        last.inputTokens,
        last.cachedInputTokens,
        last.outputTokens,
        last.reasoningTokens,
        last.totalTokens,
      ],
      expected,
    );
  }
});

test("lost streaming replies retain known rounds and record the final attempt as unavailable", async () => {
  const app = setup([
    events(toolRound()),
    async function* () {
      yield {
        type: "response.output_text.delta",
        delta: "A private partial reply",
      };
      throw new Error("Provider disconnected");
    },
  ]);
  await assert.rejects(app.run(), /disconnected/);
  assert.deepEqual(
    app.records.map((r) => r.status),
    ["pending", "completed", "pending", "unavailable"],
  );
  assert.equal(app.records[1].totalTokens, 25);
  assert.equal(app.records[3].totalTokens, null);
});

test("cache-write usage is a separate input subset, with missing and invalid values left unknown", async () => {
  for (const [write, expected] of [
    [undefined, null],
    [0, 0],
    [6, 6],
    [11, null],
    [-1, null],
    [NaN, null],
  ]) {
    const usage = tokens(20, 5, 10, 2);
    if (write !== undefined)
      usage.input_tokens_details.cache_write_tokens = write;
    const app = setup([events(terminal("completed", usage))]);
    await app.run();
    assert.equal(app.records[0].cacheWriteInputTokens, null);
    assert.equal(app.records.at(-1).cacheWriteInputTokens, expected);
    assert.equal(app.records.at(-1).cachedInputTokens, 10);
    assert.equal(app.records.at(-1).inputTokens, 20);
  }
});

test("cancellation after terminal usage receipt cannot erase the reported counts", async () => {
  const app = setup([events(terminal())]);
  await assert.rejects(
    app.run(async (usage) => {
      app.records.push(plain(usage));
      if (usage.status === "completed") app.controller.abort();
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    app.records.map((r) => r.status),
    ["pending", "completed"],
  );
  assert.equal(app.records[1].totalTokens, 15);
});

test("an attempt persistence failure prevents the provider request", async () => {
  const app = setup([events(terminal())]);
  await assert.rejects(
    app.run(async () => {
      throw new Error("Database unavailable");
    }),
    /Database unavailable/,
  );
  assert.equal(app.requests.length, 0);
});

test("terminal text and voice replies preserve authored questions and usage without a narration round", async () => {
  for (const mode of ["text", "voice"]) {
    const app = setup([events(terminal())]);
    const reply = plain(await app.run(undefined, { mode }));
    assert.equal(app.requests.length, 1);
    assert.deepEqual(
      app.records.map((usage) => usage.status),
      ["pending", "completed"],
    );
    assert.equal(app.records.at(-1).totalTokens, 15);
    assert.equal(reply.questionPresentation.callId, "synthetic-question");
    assert.deepEqual(reply.questionPresentation.answers, [
      "Bedroom",
      "Kitchen",
    ]);
    assert.equal(
      reply.questionPresentation.question,
      "Which room are you shopping for?",
    );
    assert.equal(
      reply.text,
      mode === "text"
        ? "Synthetic reply."
        : "Synthetic reply. Which room are you shopping for?",
    );
    assert.equal(reply.model, "gpt-5.6-terra-observed");
    assert.equal(reply.serviceTier, "priority");
  }
});

test("a model-selected follow-up remains authoritative instead of becoming a generic menu", async () => {
  const question = {
    question: "Which room are you measuring?",
    answers: ["Kitchen", "Bedroom"],
  };
  for (const mode of ["text", "voice"]) {
    const overview =
      mode === "text"
        ? "Let's start with your room."
        : `Let's start with your room. ${question.question}`;
    const app = setup([
      events(
        terminal("completed", tokens(20, 5), [
          {
            type: "function_call",
            name: "ask_question",
            call_id: "chosen-question",
            arguments: JSON.stringify({
              message: "Let's start with your room.",
              ...question,
            }),
          },
        ]),
      ),
    ]);
    const reply = plain(await app.run(undefined, { mode }));
    assert.deepEqual(reply.questionPresentation, {
      callId: "chosen-question",
      ...question,
    });
    assert.equal(reply.text, overview);
    assert.equal(app.requests.length, 1);
    assert.deepEqual(
      app.records.map((entry) => entry.status),
      ["pending", "completed"],
    );
    assert.equal(app.records.at(-1).totalTokens, 25);
    assert.doesNotMatch(
      JSON.stringify(reply),
      /next-actions-|What would you like to do next/,
    );
  }
});

test("failed, cancelled and empty replies cannot turn into successful next-action menus", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const outcome of ["failed", "incomplete", "empty", "cancelled"]) {
      await t.test(`${mode}: ${outcome}`, async () => {
        const app = setup([
          events(
            outcome === "empty"
              ? terminal("completed", tokens(10, 0), [])
              : terminal(outcome === "cancelled" ? "completed" : outcome),
          ),
        ]);
        let reply;
        await assert.rejects(
          async () => {
            reply = await app.run(
              async (usage) => {
                app.records.push(plain(usage));
                if (outcome === "cancelled" && usage.status === "completed")
                  app.controller.abort();
              },
              { mode },
            );
          },
          outcome === "cancelled"
            ? { name: "AbortError" }
            : outcome === "empty"
              ? /empty reply/
              : /did not complete/,
        );
        assert.equal(reply, undefined);
        assert.equal(app.requests.length, 1);
        assert.equal(app.records.length, 2);
        assert.equal(
          app.records.at(-1).status,
          outcome === "empty" || outcome === "cancelled"
            ? "completed"
            : outcome,
        );
      });
    }
  }
});

test("an invalid saved-question resume records its bounded repair without inventing a replacement menu", async () => {
  const resumeQuestion = {
    type: "question",
    version: 1,
    invocationId: "saved-question",
    question: "Which room are you measuring?",
    answers: ["Kitchen", "Bedroom"],
  };
  const app = setup([events(terminal()), events(terminal())]);
  await assert.rejects(
    app.run(undefined, { mode: "voice", resumeQuestion }),
    /did not finish with a valid answer request/,
  );
  assert.equal(app.requests.length, 2);
  assert.deepEqual(
    app.records.map((entry) => entry.status),
    ["pending", "completed", "pending", "completed"],
  );
  assert.equal(
    app.records
      .filter((entry) => entry.status === "completed")
      .reduce((sum, entry) => sum + entry.totalTokens, 0),
    30,
  );
  assert.match(
    JSON.stringify(app.requests[1][0].input),
    /Resume only the saved unanswered question/,
  );
});

test("unreadable PDP guides preserve usage while the model chooses a supported next step", async () => {
  const app = setup([
    events(
      terminal("completed", tokens(20, 5), [
        {
          type: "function_call",
          name: "get_product_guides",
          call_id: "unavailable-guide",
          arguments: JSON.stringify({
            productPath: "/products/blind",
            kinds: ["measuring"],
            refresh: false,
          }),
        },
      ]),
    ),
    events(
      terminal("completed", tokens(30, 7), [
        {
          type: "function_call",
          name: "ask_question",
          call_id: "supported-next-step",
          arguments: JSON.stringify({
            message: "I couldn't read this product's measuring guide.",
            question: "Would you like another product?",
            answers: ["Explore products", "Find my style"],
          }),
        },
      ]),
    ),
  ]);
  const reply = plain(
    await app.run(undefined, {
      mode: "voice",
      origin: "https://shop.example",
      execute: async () => ({
        status: "unavailable",
        productPath: "/products/blind",
        guides: [],
      }),
    }),
  );
  assert.equal(reply.questionPresentation.callId, "supported-next-step");
  assert.deepEqual(reply.questionPresentation.answers, [
    "Explore products",
    "Find my style",
  ]);
  assert.equal(app.requests.length, 2);
  assert.equal(
    app.records
      .filter((entry) => entry.status === "completed")
      .reduce((sum, entry) => sum + entry.totalTokens, 0),
    62,
  );
  const output = app.requests[1][0].input.find(
    (entry) =>
      entry.call_id === "unavailable-guide" &&
      entry.type === "function_call_output",
  );
  assert.equal(JSON.parse(output.output).documentStatus, "unavailable");
  assert.match(JSON.parse(output.output).instruction, /Try discover_guides/);
});
