import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setImmediate } from "node:timers";
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
const buildModelBundle = (withFallbackFixture = false) => build({
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
        if (withFallbackFixture) {
          // Keep existing failover scenarios meaningful independently of the
          // production configuration, whose optional fallback is now disabled.
          build.onResolve({ filter: /availability\.server(?:\.ts)?$/ }, () => ({
            path: path.resolve("admin/conversations/availability.server.ts"),
            namespace: "fallback-fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fallback-fixture" }, async (args) => ({
            contents: (await readFile(args.path, "utf8")).replace(
              /export const FALLBACK_TEXT_MODEL: string \| null = null;/,
              'export const FALLBACK_TEXT_MODEL: string | null = "gpt-5.6-luna";',
            ),
            loader: "ts",
            resolveDir: path.dirname(args.path),
          }));
        }
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
          contents: `export default class OpenAI { static APIError = mock.APIError; static APIConnectionError = mock.APIConnectionError; constructor(options) { mock.clients.push(options); this.responses={create:(...args)=>mock.create(...args)}; } }`,
        }));
      },
    },
  ],
});
const bundle = await buildModelBundle(true);
const singleModelBundle = await buildModelBundle();
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
        productIds: [],
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
      arguments: '{"queries":["synthetic blackout"]}',
    },
  ]);
const outputLimit = (usage = tokens(30, 8192, 10, 8000), output = []) => {
  const event = terminal("incomplete", usage, output);
  event.response.incomplete_details = { reason: "max_output_tokens" };
  return event;
};
function setup(scripts, initialAvailability = "healthy", singleModel = false) {
  const records = [];
  const requests = [];
  const incidents = [];
  const timers = [];
  const probeDeadlines = [];
  const clients = [];
  const controller = new AbortController();
  const mock = {
    APIError: StubAPIError,
    APIConnectionError: StubAPIConnectionError,
    availability: initialAvailability,
    incidents,
    clients,
    create: async (...args) => {
      requests.push(args);
      const script = scripts.shift();
      assert.ok(script, "Unexpected provider request");
      return script();
    },
  };
  const module = { exports: {} };
  runInNewContext((singleModel ? singleModelBundle : bundle).outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    AbortSignal: { timeout: (ms) => {
      const deadline = new AbortController();
      probeDeadlines.push({ ms, controller: deadline });
      return deadline.signal;
    } },
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
    probeDeadlines,
    clients,
    primaryModel: module.exports.PRIMARY_TEXT_MODEL,
    fallbackModel: module.exports.FALLBACK_TEXT_MODEL,
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
        options.onText ?? (() => {}),
        controller.signal,
        options.execute ?? (async () => ({ products: [], messages: [] })),
        options.mode ?? "text",
        onUsage,
        options.origin,
        options.resumeQuestion,
        undefined,
        undefined,
        undefined,
        undefined,
        "medium",
        undefined,
        undefined,
        options.visualizations,
      ),
  };
}
const events = (...values) =>
  async function* () {
    yield* values;
  };
const healthTerminal = (model = "gpt-6.1-sol", argumentsJson = '{"ok":true}') => ({
  type: "response.completed",
  response: {
    status: "completed",
    model,
    output: [{ type: "function_call", name: "report_api_health", arguments: argumentsJson }],
  },
});

test("saved-photo terminal has no question and uses server tools without a browser operation", async () => {
  const windowId = "abbf52a1-79c2-41b5-aafc-90089c6f3c34",
    calls = [];
  const app = setup([
    events(
      terminal("completed", tokens(20, 5), [
        {
          type: "function_call",
          name: "list_windows",
          call_id: "photos",
          arguments: '{"query":null,"cursor":null}',
        },
      ]),
    ),
    events(
      terminal("completed", tokens(25, 5), [
        {
          type: "function_call",
          name: "present_photos",
          call_id: "answer-with-photos",
          arguments: JSON.stringify({
            message: "Choose a saved window or upload a room photo.",
            photoPresentation: { kind: "windows", windowIds: [windowId] },
            clarification: null,
          }),
        },
      ]),
    ),
  ]);
  const reply = await app.run(undefined, {
    execute: () =>
      assert.fail("Photo selection must not use the storefront executor"),
    visualizations: {
      allows: () => true,
      execute: async (...args) => {
        calls.push(args);
        return { windows: [{ id: windowId, title: "Kitchen" }], total: 1 };
      },
      validatePresentation: async (input) => {
        assert.equal(input.windowIds[0], windowId);
        return input;
      },
    },
  });
  assert.equal(app.requests.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(reply.photoPresentation.callId, "answer-with-photos");
  assert.equal(reply.questionPresentation, undefined);
  assert.equal(reply.presentation, undefined);
  assert.equal(reply.photoPresentation.windowIds[0], windowId);
  const schema = app.requests[0][0].tools.find(
    (tool) => tool.name === "present_photos",
  ).parameters;
  assert.deepEqual(plain(schema.required), ["message", "photoPresentation", "clarification"]);
  assert.equal(schema.properties.question, undefined);
  const questionSchema = app.requests[0][0].tools.find(
    (tool) => tool.name === "ask_question",
  ).parameters;
  assert.equal(questionSchema.properties.photoPresentation, undefined);
});

test("a stale photo presentation repairs only the terminal answer without repeating a server action", async () => {
  let calls = 0;
  const base = {
    message: "Your preview has started.",
    productIds: [],
    question: "Would you like to keep shopping?",
    answers: ["Continue shopping"],
  };
  const app = setup([
    events(
      terminal("completed", tokens(20, 5), [
        {
          type: "function_call",
          name: "create_visualization",
          call_id: "start-preview",
          arguments:
            '{"windowId":"synthetic","productPath":"/products/blind","cleanup":null,"targetDescription":null}',
        },
      ]),
    ),
    events(
      terminal("completed", tokens(25, 5), [
        {
          type: "function_call",
          name: "present_photos",
          call_id: "stale-photo",
          arguments: JSON.stringify({
            message: "Choose a saved window or upload a room photo.",
            photoPresentation: { kind: "windows", windowIds: ["deleted"] },
            clarification: null,
          }),
        },
      ]),
    ),
    events(
      terminal("completed", tokens(25, 5), [
        {
          type: "function_call",
          name: "ask_question",
          call_id: "repaired",
          arguments: JSON.stringify(base),
        },
      ]),
    ),
  ]);
  const reply = await app.run(undefined, {
    visualizations: {
      allows: () => true,
      execute: async () => {
        calls++;
        return { id: "accepted", status: "awaiting_product" };
      },
      validatePresentation: async (input) => {
        if (input) throw new Error("A selected photo was deleted.");
        return null;
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(app.requests.length, 3);
  assert.equal(reply.photoPresentation, undefined);
  const repair = app.requests[2][0].tool_choice.tools;
  assert.ok(
    repair.every(
      (tool) => ["ask_question", "ask_measurement", "present_photos"].includes(tool.name),
    ),
  );
  assert.match(JSON.stringify(app.requests[2][0].input), /Use present_photos with message, photoPresentation and clarification:null/);
});

for (const mode of ["text", "voice"]) {
  test(`${mode} photo picker rejects mixed widgets and repairs to one upload carousel`, async () => {
    const photoPresentation = { kind: "upload", suggestedTitle: "Kitchen" };
    const photoReply = {
      message: "Choose a saved window or upload a room photo.",
      photoPresentation,
      clarification: null,
    };
    const app = setup([
      events(terminal("completed", tokens(20, 5), [{
        type: "function_call", name: "present_photos", call_id: "mixed-picker",
        arguments: JSON.stringify({ ...photoReply, question: "Choose a photo?", answers: ["Upload"] }),
      }])),
      events(terminal("completed", tokens(20, 5), [{
        type: "function_call", name: "present_photos", call_id: "clean-picker",
        arguments: JSON.stringify(photoReply),
      }])),
    ]);
    let validations = 0;
    const reply = await app.run(undefined, {
      mode,
      visualizations: {
        allows: () => true,
        execute: () => assert.fail("Photo picker must not execute an action"),
        validatePresentation: async (input) => { validations++; return input; },
      },
    });
    assert.equal(validations, 1);
    assert.equal(app.requests.length, 2);
    assert.equal(reply.text, photoReply.message);
    assert.deepEqual(plain(reply.photoPresentation), { ...photoPresentation, callId: "clean-picker" });
    assert.equal(reply.questionPresentation, undefined);
    assert.equal(reply.presentation, undefined);
    assert.match(JSON.stringify(app.requests[1][0].input), /no separate question, answers or measurement/);
  });
}

for (const mode of ["text", "voice"]) {
  test(`${mode} reference photos share one normal clarification with quick answers`, async () => {
    const windowId = "313171f9-923f-4b44-a12f-79b2a247cb0b";
    const message = "I’m comparing the fully visible window above the desk.";
    const clarification = {
      question: "Could the width and height labels have been swapped?",
      answers: ["My measurements are correct", "Swap width and height"],
    };
    const photoPresentation = {kind: "windows", windowIds: [windowId], purpose: "reference"};
    const app = setup([events(terminal("completed", tokens(20, 5), [{
      type: "function_call", name: "present_photos", call_id: "reference-check",
      arguments: JSON.stringify({message, photoPresentation, clarification}),
    }]))]);
    const reply = await app.run(undefined, {
      mode,
      execute: () => assert.fail("A reference question must not change the storefront"),
      visualizations: {
        allows: () => true,
        execute: () => assert.fail("Showing a reference must not select a photo or generate a preview"),
        validatePresentation: async (input) => input,
      },
    });
    assert.equal(app.requests.length, 1);
    assert.deepEqual(plain(reply.questionPresentation), {...clarification, callId: "reference-check"});
    assert.deepEqual(plain(reply.photoPresentation), {...photoPresentation, callId: "reference-check"});
    assert.equal(reply.presentation, undefined);
    assert.equal(reply.text, mode === "voice" ? `${message} ${clarification.question}` : message);
    const schema = app.requests[0][0].tools.find((tool) => tool.name === "present_photos").parameters;
    const questionSchema = app.requests[0][0].tools.find((tool) => tool.name === "ask_question").parameters;
    assert.deepEqual(plain(schema.properties.clarification.anyOf[1].properties.answers), plain(questionSchema.properties.answers));
  });
}

test("photo clarification rejects pickers, duplicate wording and malformed answers with terminal-only repair", async (t) => {
  const reference = {kind: "windows", windowIds: ["313171f9-923f-4b44-a12f-79b2a247cb0b"], purpose: "reference"};
  const clarification = {question: "Could the labels be swapped?", answers: ["Keep my readings", "Swap them"]};
  const valid = {message: "This is the window I’m comparing.", photoPresentation: reference, clarification};
  const variations = {
    upload: {...valid, photoPresentation: {kind: "upload", suggestedTitle: "Bedroom"}},
    selection: {...valid, photoPresentation: {...reference, purpose: "selection"}},
    preview: {...valid, photoPresentation: {...reference, purpose: "preview"}},
    "repeated question": {...valid, message: clarification.question},
    "duplicate answers": {...valid, clarification: {...clarification, answers: ["Keep", "keep"]}},
    "numeric field": {...valid, clarification: {...clarification, measurement: {label: "Width"}}},
    "missing answers": {...valid, clarification: {question: clarification.question}},
  };
  for (const [name, invalid] of Object.entries(variations)) await t.test(name, async () => {
    const app = setup([
      events(terminal("completed", tokens(20, 5), [{
        type: "function_call", name: "present_photos", call_id: "invalid-reference",
        arguments: JSON.stringify(invalid),
      }])),
      events(terminal("completed", tokens(20, 5), [{
        type: "function_call", name: "present_photos", call_id: "valid-reference",
        arguments: JSON.stringify(valid),
      }])),
    ]);
    const reply = await app.run(undefined, {
      visualizations: {
        allows: () => true,
        execute: () => assert.fail("Terminal repair must not perform an action"),
        validatePresentation: async (input) => input,
      },
    });
    assert.equal(app.requests.length, 2);
    assert.deepEqual(plain(reply.questionPresentation), {...clarification, callId: "valid-reference"});
    assert.ok(app.requests[1][0].tool_choice.tools.every((tool) => ["ask_question", "ask_measurement", "present_photos"].includes(tool.name)));
  });
});

test("the configured single advisor rejects outages without a lower-model attempt", async () => {
  const rejection = new StubAPIError(404, "model_not_found");
  const app = setup([async () => { throw rejection; }], "healthy", true);
  assert.equal(app.primaryModel, "gpt-6.1-sol");
  assert.equal(app.fallbackModel, null);
  await assert.rejects(app.run(), (error) => error === rejection);
  assert.deepEqual(app.requests.map(([request]) => request.model), [app.primaryModel]);
  assert.deepEqual(app.records.map((entry) => entry.status), ["pending", "unavailable"]);
  assert.deepEqual(app.incidents, ["outage"]);
  assert.equal(await app.status(), "suspended");
  await assert.rejects(app.run(), { status: 503 });
  assert.equal(app.requests.length, 1);
});

test("a saved retired fallback incident suspends until the sole current advisor recovers", async () => {
  const app = setup([events(healthTerminal())], "fallback", true);
  assert.equal(await app.status(), "suspended");
  assert.deepEqual(app.incidents, ["outage"]);
  await assert.rejects(app.run(), { status: 503 });
  assert.equal(app.requests.length, 0);
  assert.equal(await app.tick(), 1_000);
  assert.equal(await app.status(), "available");
  assert.deepEqual(app.requests.map(([request]) => request.model), [app.primaryModel]);
  assert.deepEqual(app.incidents, ["outage", "healthy"]);
});

test("single-advisor recovery keeps capped backoff and probes only the configured model", async () => {
  const unavailable = new StubAPIError(503, "server_error");
  const app = setup([
    ...Array.from({ length: 6 }, () => async () => { throw unavailable; }),
    events(healthTerminal()),
  ], "outage", true);
  assert.equal(await app.status(), "suspended");
  const delays = [];
  for (let index = 0; index < 6; index++) delays.push(await app.tick());
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  assert.equal(await app.status(), "suspended");
  assert.equal(await app.tick(), 30_000);
  assert.equal(await app.status(), "available");
  assert.deepEqual(app.incidents, ["healthy"]);
  assert.ok(app.requests.every(([request]) =>
    request.model === app.primaryModel && request.input === "Call report_api_health with ok set to true." &&
    request.reasoning.effort === "medium" && request.service_tier === "fast" &&
    request.store === false));
});

test("recovery exercises the advisor's strict streamed function envelope without executing it", async () => {
  const app = setup([events(healthTerminal("gpt-6.1-sol", ' { "ok" : true } '))], "outage", true);
  assert.equal(await app.status(), "suspended");
  await app.tick();
  assert.equal(await app.status(), "available");
  assert.equal(app.requests.length, 1);
  const [request, options] = app.requests[0];
  assert.equal(request.model, app.primaryModel);
  assert.equal(request.stream, true);
  assert.equal(request.service_tier, "fast");
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.max_output_tokens, 1024);
  assert.equal(request.store, false);
  assert.equal(request.parallel_tool_calls, false);
  assert.deepEqual(plain(request.prompt_cache_options), { mode: "implicit", ttl: "30m" });
  assert.ok(request.prompt_cache_key);
  assert.deepEqual(plain(request.include), ["reasoning.encrypted_content"]);
  assert.deepEqual(plain(request.tool_choice), {
    type: "allowed_tools", mode: "required",
    tools: [{ type: "function", name: "report_api_health" }],
  });
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].strict, true);
  assert.equal(request.tools[0].parameters.additionalProperties, false);
  assert.deepEqual(plain(request.tools[0].parameters.required), ["ok"]);
  assert.equal(request.context_management, undefined);
  assert.equal(options.signal, app.probeDeadlines[0].controller.signal);
  assert.equal(app.probeDeadlines[0].ms, 10_000);
  assert.deepEqual(plain(app.clients), [{ maxRetries: 0, timeout: 10_000 }]);
  assert.deepEqual(app.records, []);
});

test("plain, incomplete or incorrect health responses cannot reopen suspended input", async () => {
  const wrongModel = healthTerminal("gpt-6-luna");
  const wrongFunction = healthTerminal();
  wrongFunction.response.output[0].name = "add_to_cart";
  const multipleCalls = healthTerminal();
  multipleCalls.response.output.push({ ...multipleCalls.response.output[0] });
  const wrongStatus = healthTerminal();
  wrongStatus.response.status = "incomplete";
  const scripts = [
    async () => ({ status: "completed" }),
    events(),
    events({ type: "response.incomplete" }),
    events({ type: "response.failed" }),
    events({ type: "error" }),
    events(wrongModel),
    events(wrongFunction),
    events(multipleCalls),
    events(wrongStatus),
    ...['{"ok":false}', '{"ok":true,"other":true}', '{"ok":false,"ok":true}', 'not JSON'].map(
      (args) => events(healthTerminal("gpt-6.1-sol", args)),
    ),
  ];
  for (const script of scripts) {
    const app = setup([script], "outage", true);
    assert.equal(await app.status(), "suspended");
    await app.tick();
    assert.equal(await app.status(), "suspended");
    assert.deepEqual(app.incidents, []);
    assert.equal(app.requests.length, 1);
  }
});

test("the explicit health deadline cancels a started stream which never completes", async () => {
  let app;
  app = setup([async function* () {
    yield { type: "response.created" };
    const signal = app.requests[0][1].signal;
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }], "outage", true);
  assert.equal(await app.status(), "suspended");
  await app.tick();
  assert.equal(app.requests.length, 1);
  assert.equal(app.probeDeadlines[0].ms, 10_000);
  app.probeDeadlines[0].controller.abort(new Error("Synthetic deadline elapsed."));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await app.status(), "suspended");
  assert.deepEqual(app.incidents, []);
  assert.equal(app.requests.length, 1);
  assert.equal(app.timers.filter((timer) => !timer.ran && !timer.cancelled).length, 1);
  assert.equal(app.timers.find((timer) => !timer.ran && !timer.cancelled).ms, 2_000);
});

test("a sole-advisor failure after a tool result preserves the completed action without replay", async () => {
  const unavailable = new StubAPIError(503, "server_error");
  const app = setup([events(toolRound()), async () => { throw unavailable; }], "healthy", true);
  let actions = 0;
  await assert.rejects(app.run(undefined, { execute: async () => {
    actions++;
    return { products: [], messages: [] };
  } }), (error) => error === unavailable);
  assert.equal(actions, 1);
  assert.deepEqual(app.requests.map(([request]) => request.model), [app.primaryModel, app.primaryModel]);
  assert.equal(await app.status(), "suspended");
  assert.deepEqual(app.incidents, ["outage"]);
});

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
    [app.primaryModel, "gpt-5.6-luna"],
  );
  assert.deepEqual(
    app.records.map((entry) => entry.status),
    ["pending", "unavailable", "pending", "completed"],
  );
  assert.deepEqual(
    app.records.filter((entry) => entry.status === "pending").map((entry) => entry.model),
    [app.primaryModel, "gpt-5.6-luna"],
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
      app.primaryModel,
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
    events(healthTerminal("gpt-5.6-luna")),
    events(healthTerminal()),
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
  assert.equal(app.requests.slice(2).every(([request]) => request.input === "Call report_api_health with ok set to true."), true);
  assert.equal(app.requests.slice(2).every(([request]) => request.max_output_tokens === 1024), true);
  assert.equal(app.requests.slice(2).every(([request]) => request.reasoning.effort === "medium"), true);
  assert.equal(app.requests.slice(2).every(([request]) => request.service_tier === "fast" && request.store === false), true);
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
    app.primaryModel,
    app.primaryModel,
    "gpt-5.6-luna",
  ]);
  assert.equal(app.requests[2][0].input.some((item) => item.type === "function_call_output"), true);
  assert.equal(app.requests[1][0].input.some((item) => item.type === "reasoning"), true);
  assert.equal(app.requests[2][0].input.some((item) => item.type === "reasoning"), false);
});

test("a persisted outage remains suspended after restart until a probe succeeds", async () => {
  const app = setup([events(healthTerminal())], "outage");
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

test("output exhaustion before a tool decision retries once without retaining or executing partial output", async () => {
  const incomplete = outputLimit(undefined, [
    {
      type: "reasoning",
      id: "PRIVATE_INCOMPLETE_REASONING",
      encrypted_content: "PRIVATE_INCOMPLETE_STATE",
    },
    {
      type: "function_call",
      name: "clear_cart",
      call_id: "PRIVATE_INCOMPLETE_MUTATION",
      arguments: "{}",
    },
    {
      ...terminal().response.output[0],
      call_id: "PRIVATE_INCOMPLETE_QUESTION",
    },
    {
      type: "function_call",
      name: "search_products",
      call_id: "PRIVATE_INCOMPLETE_JSON",
      arguments: '{"queries":[',
    },
  ]);
  const app = setup([
    events(
      { type: "response.output_text.delta", delta: "PRIVATE_INCOMPLETE_TEXT" },
      incomplete,
    ),
    events(toolRound()),
    events(terminal()),
  ]);
  const executions = [], visible = [];
  const reply = await app.run(undefined, {
    onText: (text) => visible.push(text),
    execute: async (callId, name) => {
      executions.push([callId, name]);
      return { products: [], messages: [] };
    },
  });
  assert.deepEqual(executions, [["tool_call_1", "search_products"]]);
  assert.deepEqual(visible, [reply.text]);
  assert.equal(reply.questionPresentation.callId, "synthetic-question");
  assert.equal(app.requests.length, 3);
  assert.deepEqual(app.requests.map(([request]) => request.max_output_tokens), [8192, 16384, 16384]);
  const [initial, retry] = app.requests.map(([request]) => plain(request));
  assert.equal(initial.max_output_tokens, 8192);
  assert.equal(retry.max_output_tokens, 16384);
  assert.deepEqual(retry, { ...initial, max_output_tokens: 16384 });
  assert.doesNotMatch(JSON.stringify({ requests: app.requests, reply, visible }), /PRIVATE_INCOMPLETE/);
  assert.deepEqual(app.incidents, []);
  assert.equal(await app.status(), "available");
});

test("output exhaustion after a successful search retains catalogue evidence and every usage attempt", async () => {
  const product = {
    id: "gid://shopify/Product/123",
    title: "Verified catalogue shade",
    description: "",
    url: "https://shop.example/products/shade",
  };
  const search = toolRound();
  search.response.output.unshift({
    type: "reasoning",
    id: "completed-reasoning",
    encrypted_content: "completed-model-state",
  });
  const final = terminal("completed", tokens(40, 12, 25, 3));
  final.response.output[0].arguments = JSON.stringify({
    ...JSON.parse(final.response.output[0].arguments),
    productIds: [product.id],
  });
  const app = setup([
    events(search),
    events(outputLimit()),
    events(final),
  ]);
  const executions = [];
  const reply = await app.run(undefined, {
    execute: async (callId, name) => {
      executions.push([callId, name]);
      return { products: [product], messages: [] };
    },
  });
  assert.deepEqual(executions, [["tool_call_1", "search_products"]]);
  assert.deepEqual(plain(reply.presentation.productRefs), [{ id: product.id, title: product.title }]);
  assert.deepEqual(app.requests.map(([request]) => request.model), [app.primaryModel, app.primaryModel, app.primaryModel]);
  assert.deepEqual(app.requests.map(([request]) => request.max_output_tokens), [8192, 8192, 16384]);
  const previous = plain(app.requests[1][0]);
  const retry = plain(app.requests[2][0]);
  assert.deepEqual(retry, { ...previous, max_output_tokens: 16384 });
  const result = retry.input.find((item) => item.type === "function_call_output");
  assert.equal(result.call_id, "tool_call_1");
  assert.deepEqual(JSON.parse(result.output), { products: [product], messages: [] });
  assert.equal(retry.input.some((item) => item.encrypted_content === "completed-model-state"), true);
  assert.deepEqual(app.records.map((entry) => entry.status), [
    "pending", "completed", "pending", "incomplete", "pending", "completed",
  ]);
  const attempts = app.records.filter((entry) => entry.status === "pending");
  const reported = app.records.filter((entry) => entry.status !== "pending");
  assert.equal(new Set(attempts.map((entry) => entry.id)).size, 3);
  assert.deepEqual(attempts.map((entry) => entry.id), reported.map((entry) => entry.id));
  assert.deepEqual(reported.map((entry) => [entry.totalTokens, entry.reasoningTokens]), [
    [25, 2], [8222, 8000], [52, 3],
  ]);
  assert.deepEqual(app.incidents, []);
  assert.equal(await app.status(), "available");
});

test("a second exhausted output budget fails without fallback or another retry", async () => {
  const app = setup([
    events(outputLimit()),
    events(outputLimit(tokens(30, 16384, 10, 16000))),
    events(terminal()),
  ]);
  await assert.rejects(app.run(undefined, {
    onText: () => assert.fail("Incomplete output must not be published"),
    execute: async () => assert.fail("Incomplete output must not execute tools"),
  }), (error) => {
    assert.deepEqual(plain(app.diagnostics(error)), {
      providerStatus: "incomplete", incompleteReason: "max_output_tokens",
    });
    return true;
  });
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.requests.map(([request]) => request.max_output_tokens), [8192, 16384]);
  assert.deepEqual(app.records.map((entry) => entry.status), ["pending", "incomplete", "pending", "incomplete"]);
  assert.deepEqual(app.records.filter((entry) => entry.status === "incomplete").map((entry) => entry.outputTokens), [8192, 16384]);
  assert.deepEqual(app.incidents, []);
  assert.equal(await app.status(), "available");
});

test("a completed tool round cannot replenish the turn's exhausted output retry budget", async () => {
  const app = setup([
    events(outputLimit()),
    events(toolRound()),
    events(outputLimit(tokens(30, 16384, 10, 16000))),
    events(terminal()),
  ]);
  let executions = 0;
  await assert.rejects(app.run(undefined, {
    onText: () => assert.fail("Incomplete output must not be published"),
    execute: async () => {
      executions++;
      return { products: [], messages: [] };
    },
  }), /did not complete/);
  assert.equal(executions, 1);
  assert.equal(app.requests.length, 3);
  assert.deepEqual(app.requests.map(([request]) => request.max_output_tokens), [8192, 16384, 16384]);
  assert.deepEqual(app.records.map((entry) => entry.status), [
    "pending", "incomplete", "pending", "completed", "pending", "incomplete",
  ]);
  assert.deepEqual(app.incidents, []);
});

test("cancellation after exhausted-output usage is saved prevents a retry and keeps its counts", async () => {
  const app = setup([events(outputLimit()), events(terminal())]);
  await assert.rejects(app.run(async (usage) => {
    app.records.push(plain(usage));
    if (usage.status === "incomplete") app.controller.abort();
  }, {
    onText: () => assert.fail("Cancelled output must not be published"),
    execute: async () => assert.fail("Cancelled output must not execute tools"),
  }), { name: "AbortError" });
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.records.map((entry) => entry.status), ["pending", "incomplete"]);
  assert.equal(app.records[1].totalTokens, 8222);
  assert.equal(app.records[1].reasoningTokens, 8000);
  assert.deepEqual(app.incidents, []);
});

test("each new turn starts with its normal output limit and one available retry", async () => {
  const app = setup([
    events(outputLimit()), events(terminal()),
    events(outputLimit()), events(terminal()),
  ]);
  await app.run();
  await app.run();
  assert.deepEqual(app.requests.map(([request]) => request.max_output_tokens), [8192, 16384, 8192, 16384]);
  assert.deepEqual(app.incidents, []);
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
    assert.equal(app.requests[0][0].max_output_tokens, 8192);
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
              productIds: [],
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
            library: null,
            readOriginals: true,
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
            productIds: [],
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
