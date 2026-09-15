import assert from "node:assert/strict";
import process from "node:process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const bundle = await build({
  stdin: {
    contents: `
      export * from "./admin/conversations/runner.server.ts";
      export * from "./admin/conversations/model.server.ts";
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
      name: "runner-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /repository\.server$|browser-tools\.server$|^openai$/ },
          (args) => ({
            path: args.path,
            namespace: "stub",
          }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents:
            args.path === "openai"
              ? `export default class OpenAI {
              constructor(options) {
                mock.clients.push(options);
                this.responses={create:(...args)=>mock.createResponse(...args)};
              }
            }`
              : args.path.endsWith("browser-tools.server")
                ? `export const requestBrowserTool=(...args)=>mock.browserTool(...args);`
                : args.path.includes("usage")
                  ? `export const recordModelUsage=(...args)=>mock.usage(...args);`
                  : `export const beginTurn=(...args)=>mock.begin(...args);
             export const failPending=(...args)=>mock.recover(...args);
             export const finishTurn=(...args)=>mock.finish(...args);
             export const getSnapshot=(...args)=>mock.snapshot(...args);
             export const endConversation=(...args)=>mock.end(...args);`,
        }));
      },
    },
  ],
});

const firstInput = {
  requestId: "68055cf5-a781-4c1d-a792-42861808b2c7",
  text: "Help me choose a blind.",
};
const secondInput = {
  requestId: "2bd71077-fddd-40c2-9207-5489ab6238f9",
  text: "It is for my bedroom.",
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const completed = (text = "A completed reply.", extra = {}) => ({
  type: "response.completed",
  response: {
    model: "gpt-5.6-luna-actual",
    service_tier: "fast",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    ...extra,
  },
});

function pendingReply(text = "A partial reply.") {
  const gate = deferred();
  let closed = false;
  const stream = (async function* () {
    try {
      yield { type: "response.output_text.delta", delta: text };
      yield await gate.promise;
    } finally {
      closed = true;
    }
  })();
  return {
    stream,
    complete: (text) => gate.resolve(completed(text)),
    fail: (error = new Error("private provider failure")) => gate.reject(error),
    closed: () => closed,
  };
}

function setup() {
  const rows = new Map();
  const streams = [];
  const logs = [];
  const calls = {
    requests: [],
    begins: [],
    finishes: [],
    recoveries: [],
    deadlines: [],
    browserTools: [],
    ends: [],
    usage: [],
  };
  const ensure = (id) => {
    if (!rows.has(id))
      rows.set(id, { status: "active", revision: 0, messages: [], tools: [] });
    return rows.get(id);
  };
  const snapshot = (id) => {
    const row = ensure(id);
    return {
      id,
      status: row.status ?? "active",
      revision: row.revision ?? 0,
      tools: row.tools ?? [],
      messages: row.messages.map(
        ({ id, role, status, text, error, extraParts }) => ({
          id,
          role,
          status,
          parts: [{ type: "text", text }, ...(extraParts ?? [])],
          createdAt: "2026-09-15T10:00:00Z",
          ...(error ? { error } : {}),
        }),
      ),
      busy: row.messages.some((message) => message.status === "pending"),
    };
  };
  let api;
  const mock = {
    clients: [],
    usage: async (...args) => calls.usage.push(plain(args)),
    beforeBegin: undefined,
    afterFinish: undefined,
    createResponse: async (input, options) => {
      calls.requests.push({ input: plain(input), options });
      const stream = streams.shift();
      assert.ok(stream, "A test must supply each expected provider response");
      return stream;
    },
    begin: async (id, input) => {
      calls.begins.push({ id, input });
      await mock.beforeBegin?.(id, input);
      const row = ensure(id);
      if (row.status === "ended")
        throw new api.ConversationError(409, "This chat has ended.");
      const existing = row.messages.find(
        (message) =>
          message.role === "user" && message.requestId === input.requestId,
      );
      if (existing) {
        if (existing.text !== input.text)
          throw new api.ConversationError(
            400,
            "The request ID has different text.",
          );
        return { snapshot: snapshot(id), assistantId: null, history: [] };
      }
      if (row.messages.some((message) => message.status === "pending"))
        throw new api.ConversationError(409, "Wait for the current reply.");
      const assistantId = `${id}-assistant-${row.messages.length + 1}`;
      row.messages.push(
        {
          id: `${id}-user-${row.messages.length}`,
          role: "user",
          status: "complete",
          text: input.text,
          requestId: input.requestId,
        },
        {
          id: assistantId,
          role: "assistant",
          status: "pending",
          text: "",
          requestId: input.requestId,
        },
      );
      row.revision = (row.revision ?? 0) + 1;
      return {
        snapshot: snapshot(id),
        assistantId,
        history: row.messages
          .filter((message) => message.status === "complete")
          .map(({ role, text }) => ({ role, text })),
      };
    },
    recover: async (id) => {
      calls.recoveries.push(id);
      ensure(id).messages.forEach((message) => {
        if (message.status === "pending" && message.abandoned) {
          message.status = "failed";
          message.error = "The server restarted before this reply finished.";
        }
      });
    },
    finish: async (id, assistantId, result) => {
      calls.finishes.push({ id, assistantId, result });
      const message = ensure(id).messages.find(
        (message) => message.id === assistantId,
      );
      if (message?.status === "pending") Object.assign(message, result);
      await mock.afterFinish?.(id, assistantId, result);
    },
    snapshot: async (id) => snapshot(id),
    browserTool: async (...args) => {
      calls.browserTools.push(args);
      return mock.executeTool(...args);
    },
    executeTool: async () => {
      throw new Error("No browser tool result supplied.");
    },
    end: async (id) => {
      calls.ends.push(id);
      const row = ensure(id);
      row.status = "ended";
      row.revision = (row.revision ?? 0) + 1;
      row.messages.forEach((message) => {
        if (message.status === "pending")
          Object.assign(message, {
            status: "failed",
            error: "Conversation ended.",
          });
      });
      row.tools = [];
      return snapshot(id);
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    URL,
    AbortController,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        calls.deadlines.push(milliseconds);
        return new AbortController().signal;
      },
    },
    console: { error: (...args) => logs.push(args) },
  });
  api = module.exports;
  return { api, mock, rows, streams, calls, logs, snapshot };
}

test("simultaneous same-request posts create one generation and replay its durable messages", async () => {
  const env = setup();
  const generation = pendingReply();
  env.streams.push(generation.stream);
  const gate = deferred();
  env.mock.beforeBegin = () => gate.promise;
  const first = env.api.startTurn("one", firstInput);
  const second = env.api.startTurn("one", firstInput);
  await flush();
  assert.equal(env.calls.requests.length, 0);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.busy, true);
  assert.deepEqual(plain(a), plain(b));
  assert.equal(env.calls.requests.length, 1);
  assert.equal(env.rows.get("one").messages.length, 2);
  generation.complete();
  await flush();
  assert.equal(env.calls.finishes.length, 1);
  assert.equal((await env.api.readConversation("one")).busy, false);
});

test("a different request cannot enter a conversation while its generation is active", async () => {
  const env = setup();
  const generation = pendingReply();
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  await assert.rejects(env.api.startTurn("one", secondInput), { status: 409 });
  assert.equal(env.calls.requests.length, 1);
  assert.equal(env.rows.get("one").messages.length, 2);
  generation.complete();
  await flush();
});

test("the active owner remains exclusive after persistence commits but before finishing returns", async () => {
  const env = setup();
  const generation = pendingReply();
  env.streams.push(generation.stream);
  const commit = deferred();
  env.mock.afterFinish = () => commit.promise;
  await env.api.startTurn("one", firstInput);
  generation.complete();
  await flush();
  assert.equal(
    env.snapshot("one").busy,
    false,
    "the durable reply is already complete",
  );
  await assert.rejects(env.api.startTurn("one", secondInput), { status: 409 });
  assert.equal(
    env.rows.get("one").messages.length,
    2,
    "no orphan assistant is created",
  );
  assert.equal(env.calls.requests.length, 1);
  commit.resolve();
  await flush();
});

test("a persisted completed reply is never overwritten by stale streaming text", async () => {
  const env = setup();
  const generation = pendingReply("Draft streaming text.");
  env.streams.push(generation.stream);
  const commit = deferred();
  env.mock.afterFinish = () => commit.promise;
  await env.api.startTurn("one", firstInput);
  generation.complete("Canonical completed answer.");
  await flush();
  try {
    const result = await env.api.readConversation("one");
    assert.equal(result.messages[1].status, "complete");
    assert.equal(
      result.messages[1].parts[0].text,
      "Canonical completed answer.",
    );
  } finally {
    commit.resolve();
    await flush();
  }
});

test("the global concurrency bound counts initializing owners and releases finished slots", async () => {
  const env = setup();
  const generations = Array.from({ length: 5 }, () => pendingReply());
  generations.forEach((generation) => env.streams.push(generation.stream));
  const gate = deferred();
  env.mock.beforeBegin = () => gate.promise;
  const starts = Array.from({ length: 4 }, (_, index) =>
    env.api.startTurn(`chat-${index}`, firstInput),
  );
  await assert.rejects(env.api.startTurn("chat-4", firstInput), {
    status: 429,
  });
  assert.equal(env.calls.requests.length, 0);
  gate.resolve();
  await Promise.all(starts);
  assert.equal(env.calls.requests.length, 4);
  generations[0].complete();
  await flush();
  await env.api.startTurn("chat-4", firstInput);
  await flush();
  assert.equal(env.calls.requests.length, 5);
  generations.slice(1).forEach((generation) => generation.complete());
  await flush();
});

test("partial snapshots belong to the active assistant while HTTP acceptance stays independent", async () => {
  const env = setup();
  const generation = pendingReply("For a bedroom, start with privacy.");
  env.streams.push(generation.stream);
  const accepted = await env.api.startTurn("one", firstInput);
  assert.equal(accepted.busy, true);
  assert.equal(
    env.calls.finishes.length,
    0,
    "the POST completes while the provider is still streaming",
  );
  await flush();
  const partial = await env.api.readConversation("one");
  assert.equal(partial.messages[0].parts[0].text, firstInput.text);
  assert.equal(
    partial.messages[1].parts[0].text,
    "For a bedroom, start with privacy.",
  );
  assert.equal(
    env.rows.get("one").messages[1].text,
    "",
    "partial text is process-owned until final persistence",
  );
  assert.equal(
    env.calls.recoveries.length,
    1,
    "reads do not recover an active generation",
  );
  assert.deepEqual(env.calls.deadlines, [90000]);
  assert.equal(env.calls.requests[0].options.signal.aborted, false);
  generation.complete("Which direction does your bedroom face?");
  await flush();
  const finished = await env.api.readConversation("one");
  assert.equal(finished.busy, false);
  assert.equal(finished.messages[1].status, "complete");
  assert.equal(
    finished.messages[1].parts[0].text,
    "Which direction does your bedroom face?",
  );
  assert.equal(env.calls.finishes[0].result.model, "gpt-5.6-luna-actual");
  assert.equal(env.calls.finishes[0].result.serviceTier, "fast");
});

test("model failure persists safe failed state and releases ownership without an automatic retry", async () => {
  const env = setup();
  const generation = pendingReply("A useful partial answer.");
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  await flush();
  generation.fail();
  await flush();
  const result = await env.api.readConversation("one");
  assert.equal(result.busy, false);
  assert.equal(result.messages[1].status, "failed");
  assert.equal(result.messages[1].parts[0].text, "A useful partial answer.");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(env.logs).includes("private"), false);
  assert.equal(env.calls.requests.length, 1);
  const next = pendingReply();
  env.streams.push(next.stream);
  await env.api.startTurn("one", secondInput);
  await flush();
  assert.equal(env.calls.requests.length, 2);
  next.complete();
  await flush();
});

test("a failed initialization releases its owner and permits a later explicit attempt", async () => {
  const env = setup();
  env.mock.beforeBegin = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(
    env.api.startTurn("one", firstInput),
    /database unavailable/,
  );
  assert.equal(env.calls.requests.length, 0);
  env.mock.beforeBegin = undefined;
  const generation = pendingReply();
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  await flush();
  assert.equal(env.calls.requests.length, 1);
  generation.complete();
  await flush();
});

test("restart reads ask persistence to fail abandoned replies without generating another answer", async () => {
  const env = setup();
  env.rows.set("restored", {
    messages: [
      {
        id: "restored-user",
        role: "user",
        status: "complete",
        text: firstInput.text,
      },
      {
        id: "restored-assistant",
        role: "assistant",
        status: "pending",
        text: "",
        abandoned: true,
      },
    ],
  });
  const result = await env.api.readConversation("restored");
  assert.equal(result.busy, false);
  assert.equal(result.messages[1].status, "failed");
  assert.match(result.messages[1].error, /restarted/);
  assert.deepEqual(env.calls.recoveries, ["restored"]);
  assert.equal(env.calls.requests.length, 0);
});

test("reported usage retains its original assistant owner after the chat is ended", async () => {
  const env = setup();
  const terminal = deferred();
  env.streams.push(
    (async function* () {
      yield await terminal.promise;
    })(),
  );
  await env.api.startTurn("one", firstInput);
  await flush();
  assert.equal(env.calls.usage.length, 1);
  const [conversationId, assistantId, initial] = env.calls.usage[0];
  assert.equal(conversationId, "one");
  assert.equal(initial.status, "pending");
  await env.api.endTurn("one");
  terminal.resolve(
    completed("Late response", {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    }),
  );
  await flush();
  assert.equal(env.calls.usage.length, 2);
  assert.equal(env.calls.usage[1][0], conversationId);
  assert.equal(env.calls.usage[1][1], assistantId);
  assert.equal(env.calls.usage[1][2].id, initial.id);
  assert.equal(env.calls.usage[1][2].totalTokens, 15);
  assert.equal(env.rows.get("one").status, "ended");
  assert.equal(env.calls.finishes.length, 0);
});

test("completed request replays never call the model again or duplicate messages", async () => {
  const env = setup();
  const generation = pendingReply();
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  generation.complete();
  await flush();
  const replay = await env.api.startTurn("one", firstInput);
  assert.equal(replay.busy, false);
  assert.equal(replay.messages.length, 2);
  assert.equal(env.calls.requests.length, 1);
  await assert.rejects(
    env.api.startTurn("one", { ...firstInput, text: "Different text." }),
    { status: 400 },
  );
});

test("the actual model client sets fast/low/store=false, passes the signal and keeps customer text out of instructions", async () => {
  const env = setup();
  env.streams.push(
    (async function* () {
      yield completed();
    })(),
  );
  const signal = new AbortController().signal;
  const history = [
    { role: "user", text: "Private room preference." },
    { role: "assistant", text: "What matters most?" },
  ];
  const reply = await env.api.generateReply(history, () => {}, signal);
  assert.equal(reply.text, "A completed reply.");
  const { input, options } = env.calls.requests[0];
  assert.equal(input.model, "gpt-5.6-luna");
  assert.equal(input.service_tier, "fast");
  assert.deepEqual(plain(input.reasoning), { effort: "low" });
  assert.equal(input.store, false);
  assert.equal(input.stream, true);
  assert.equal(input.max_output_tokens, 1600);
  assert.equal(
    input.tools,
    undefined,
    "tools are exposed only when a browser executor is supplied",
  );
  assert.equal(options.signal, signal);
  assert.equal(input.instructions.includes("Private room preference"), false);
  assert.match(input.instructions, /untrusted|not instructions/i);
  assert.match(input.instructions, /Never invent manufacturer tolerances/);
  assert.deepEqual(
    plain(input.input),
    history.map(({ role, text }) => ({ role, content: text })),
  );
  assert.deepEqual(plain(env.mock.clients), [
    { maxRetries: 0, timeout: 90000 },
  ]);
});

test("streaming and completed output show text/refusal content but never reasoning or tool data", async () => {
  const env = setup();
  let closed = false;
  env.streams.push(
    (async function* () {
      try {
        yield {
          type: "response.reasoning_summary_text.delta",
          delta: "private reasoning",
        };
        yield { type: "response.output_text.delta", delta: "Hello " };
        yield { type: "response.output_text.delta", delta: "there." };
        yield completed("ignored", {
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "private reasoning" }],
            },
            {
              type: "message",
              content: [
                { type: "output_text", text: "Final text. " },
                {
                  type: "refusal",
                  refusal: "I cannot help with that request.",
                },
              ],
            },
          ],
        });
      } finally {
        closed = true;
      }
    })(),
  );
  const partials = [];
  const reply = await env.api.generateReply(
    [],
    (text) => partials.push(text),
    new AbortController().signal,
  );
  assert.deepEqual(partials, ["Hello ", "Hello there."]);
  assert.equal(reply.text, "Final text. I cannot help with that request.");
  assert.equal(JSON.stringify({ partials, reply }).includes("private"), false);
  assert.equal(
    closed,
    true,
    "returning on completion releases the stream iterator",
  );
});

test("refusal-only replies are retained as displayable assistant responses", async () => {
  const env = setup();
  env.streams.push(
    (async function* () {
      yield completed("", {
        output: [
          {
            type: "message",
            content: [
              { type: "refusal", refusal: "I cannot assist with that." },
            ],
          },
        ],
      });
    })(),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
  );
  assert.equal(reply.text, "I cannot assist with that.");
});

test("provider failure, incomplete output, empty output and premature stream end cannot appear successful", async (t) => {
  for (const mode of [
    "failed",
    "incomplete",
    "error",
    "empty",
    "reasoning-only",
    "end",
  ]) {
    await t.test(mode, async () => {
      const env = setup();
      env.streams.push(
        (async function* () {
          if (mode === "empty") yield completed("   ");
          else if (mode === "reasoning-only")
            yield completed("", {
              output: [{ type: "reasoning", summary: [] }],
            });
          else if (mode !== "end")
            yield {
              type: mode === "error" ? "error" : `response.${mode}`,
              message: "private provider body",
            };
        })(),
      );
      await assert.rejects(
        env.api.generateReply([], () => {}, new AbortController().signal),
        (error) => !error.message.includes("private"),
      );
      assert.equal(env.calls.requests.length, 1);
    });
  }
});

function events(...values) {
  return (async function* () {
    yield* values;
  })();
}

function catalogCall(
  callId,
  name = "search_products",
  args = { query: "no drill" },
) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

test("catalog loops preserve encrypted reasoning within the turn without exposing or reusing it", async () => {
  const env = setup();
  const reasoning = {
    type: "reasoning",
    id: "reasoning-1",
    encrypted_content: "ENCRYPTED_PRIVATE_REASONING",
    summary: [],
  };
  env.streams.push(
    events(completed("", { output: [reasoning, catalogCall("call-1")] })),
    events(
      { type: "response.output_text.delta", delta: "Here is an option." },
      completed("Here is an option."),
    ),
    events(completed("A fresh turn.")),
  );
  const executions = [];
  const partials = [];
  const execute = async (...args) => {
    executions.push(args);
    return {
      products: [
        {
          id: "gid://shopify/Product/123",
          title: "Catalog shade",
          description: "",
          url: "https://hd-dev-multi.myshopify.com/products/shade",
        },
      ],
      messages: [],
    };
  };
  const reply = await env.api.generateReply(
    [{ role: "user", text: "Show no-drill shades" }],
    (text) => partials.push(text),
    new AbortController().signal,
    execute,
  );
  assert.deepEqual(plain(executions), [
    ["call-1", "search_products", { query: "no drill" }],
  ]);
  for (const { input } of env.calls.requests) {
    assert.equal(input.service_tier, "fast");
    assert.deepEqual(input.reasoning, { effort: "low" });
    assert.deepEqual(input.include, ["reasoning.encrypted_content"]);
    assert.equal(input.store, false);
    assert.equal(input.parallel_tool_calls, false);
    assert.deepEqual(
      input.tools.map(({ name }) => name),
      [
        "search_products",
        "get_product",
        "lookup_catalog",
        "navigate",
        "show_products",
      ],
    );
  }
  assert.ok(
    env.calls.requests[1].input.input.some(
      (item) => item.encrypted_content === reasoning.encrypted_content,
    ),
  );
  const output = env.calls.requests[1].input.input.find(
    (item) => item.type === "function_call_output",
  );
  assert.equal(output.call_id, "call-1");
  assert.equal(JSON.parse(output.output).products[0].title, "Catalog shade");
  assert.doesNotMatch(
    JSON.stringify({ reply, partials }),
    /ENCRYPTED|reasoning|function_call/,
  );
  assert.equal(
    reply.presentation,
    undefined,
    "Reading products does not select cards",
  );
  await env.api.generateReply(
    [{ role: "user", text: "A separate turn" }],
    () => {},
    new AbortController().signal,
    execute,
  );
  assert.doesNotMatch(
    JSON.stringify(env.calls.requests[2].input.input),
    /ENCRYPTED|Catalog shade|call-1/,
  );
});

test("catalog call budget leaves only presentation after four lookups and rejects an extra browser call", async () => {
  for (const extraCall of [false, true]) {
    const env = setup();
    for (let index = 0; index < 4; index++)
      env.streams.push(
        events(completed("", { output: [catalogCall(`call-${index}`)] })),
      );
    env.streams.push(
      events(
        extraCall
          ? completed("", { output: [catalogCall("call-extra")] })
          : completed("These are the current options."),
      ),
    );
    let executions = 0;
    const generation = env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => {
        executions++;
        return { products: [], messages: [] };
      },
    );
    if (extraCall) await assert.rejects(generation, /storefront tool limit/);
    else
      assert.equal((await generation).text, "These are the current options.");
    assert.equal(executions, 4);
    assert.equal(env.calls.requests.length, 5);
    assert.deepEqual(
      env.calls.requests[4].input.tools.map((tool) => tool.name),
      ["show_products"],
    );
    assert.equal(env.calls.requests[4].input.tool_choice, "auto");
  }
});

test("invalid or failed catalog calls return a safe error to the model without fabricated products", async () => {
  for (const call of [
    catalogCall("call-1", "add_to_cart", {}),
    catalogCall("call-1", "search_products", "not JSON"),
    catalogCall("call-1"),
  ]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [call] })),
      events(completed("", { output: [showCall([123])] })),
      events(completed("I could not check that catalog.")),
    );
    let executions = 0;
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => {
        executions++;
        throw new Error("PRIVATE_BROWSER_ERROR");
      },
    );
    const output = env.calls.requests[1].input.input.find(
      (item) => item.type === "function_call_output",
    );
    assert.deepEqual(Object.keys(JSON.parse(output.output)), ["error"]);
    assert.match(
      JSON.parse(output.output).error,
      /Do not claim product availability or invent/,
    );
    assert.doesNotMatch(output.output, /PRIVATE_BROWSER_ERROR/);
    assert.equal(
      executions,
      call.name === "search_products" && call.arguments !== "not JSON" ? 1 : 0,
    );
    assert.equal(reply.text, "I could not check that catalog.");
    assert.equal(reply.presentation, undefined);
    assert.ok(
      env.calls.requests[1].input.tools.some(
        (tool) => tool.name === "show_products",
      ),
      "Failed catalog calls do not hide the carousel capability",
    );
    const selectionOutput = env.calls.requests[2].input.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "show-1",
    );
    assert.match(
      JSON.parse(selectionOutput.output).error,
      /No product cards were selected/,
    );
  }
});

const productGid = (id) => `gid://shopify/Product/${id}`;
const catalogResult = (...ids) => ({
  products: ids.map((id) => ({
    id: productGid(id),
    title: `Shade ${id}`,
    description: "",
    url: `https://hd-dev-single.myshopify.com/products/shade-${id}`,
  })),
  messages: [],
});
const showCall = (ids, callId = "show-1") =>
  catalogCall(callId, "show_products", { productIds: ids.map(productGid) });

test("explicit product presentation selects only the requested ordered subset without browser dispatch", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [catalogCall("catalog-1")] })),
    events(completed("", { output: [showCall([456, 123])] })),
    events(completed("These two blackout options fit your preferences.")),
  );
  const dispatched = [];
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      dispatched.push(args);
      return catalogResult(123, 456, 789);
    },
  );
  assert.equal(dispatched.length, 1, "Presentation is a server-local tool");
  assert.deepEqual(plain(reply.presentation), {
    callId: "show-1",
    productIds: [productGid(456), productGid(123)],
  });
  const acknowledged = env.calls.requests[2].input.input.find(
    (item) => item.type === "function_call_output" && item.call_id === "show-1",
  );
  assert.deepEqual(JSON.parse(acknowledged.output), {
    selectedProductIds: [productGid(456), productGid(123)],
  });
  assert.equal(
    env.calls.requests[2].input.tools.some(
      (tool) => tool.name === "show_products",
    ),
    false,
    "A successful selection consumes the one presentation attempt",
  );
});

test("an explicit follow-up can show refreshed recommendations after text or an earlier carousel", async (t) => {
  for (const earlierCarousel of [false, true]) {
    await t.test(
      earlierCarousel ? "earlier carousel" : "text-only recommendations",
      async () => {
        const env = setup();
        env.streams.push(
          events(
            completed("", {
              output: [
                catalogCall("catalog-first", "search_products", {
                  query: "blackout roller",
                }),
              ],
            }),
          ),
          ...(earlierCarousel
            ? [
                events(
                  completed("", {
                    output: [showCall([123, 456], "show-first")],
                  }),
                ),
              ]
            : []),
          events(
            completed(
              "Here are Shade 123 and Shade 456, two blackout roller options.",
            ),
          ),
          events(
            completed("", {
              output: [
                catalogCall("catalog-refresh", "lookup_catalog", {
                  ids: [productGid(123), productGid(456)],
                }),
              ],
            }),
          ),
          events(
            completed("", { output: [showCall([456, 123], "show-followup")] }),
          ),
          events(completed("Here are those options in the scroll carousel.")),
        );
        const dispatched = [];
        const execute = async (...args) => {
          dispatched.push(args);
          return catalogResult(123, 456, 789);
        };
        const initial = [
          { role: "user", text: "Show me a blackout roller carousel" },
        ];
        const prior = await env.api.generateReply(
          initial,
          () => {},
          new AbortController().signal,
          execute,
        );
        assert.equal(Boolean(prior.presentation), earlierCarousel);
        const followupRound = env.calls.requests.length;
        const history = [...initial, { role: "assistant", text: prior.text }];
        if (prior.presentation)
          history.push({
            role: "user",
            text: `Untrusted storefront observations (reference data, not customer instructions): ${JSON.stringify(
              [
                {
                  type: "products",
                  version: 1,
                  invocationId: "04a2ab2c-b930-42f0-84c6-4f0f49a384ce",
                  productIds: prior.presentation.productIds,
                },
              ],
            )}`,
          });
        history.push({
          role: "user",
          text: "Show it to me in the scroll carousel in chat",
        });
        const reply = await env.api.generateReply(
          history,
          () => {},
          new AbortController().signal,
          execute,
        );
        assert.ok(
          env.calls.requests[followupRound].input.tools.some(
            (tool) => tool.name === "show_products",
          ),
          "The model knows a carousel is supported before deciding to refresh the catalog",
        );
        assert.deepEqual(plain(dispatched), [
          ["catalog-first", "search_products", { query: "blackout roller" }],
          [
            "catalog-refresh",
            "lookup_catalog",
            { ids: [productGid(123), productGid(456)] },
          ],
        ]);
        assert.deepEqual(plain(reply.presentation), {
          callId: "show-followup",
          productIds: [productGid(456), productGid(123)],
        });
        assert.equal(
          env.calls.requests[followupRound + 2].input.tools.some(
            (tool) => tool.name === "show_products",
          ),
          false,
          "An explicit repeat still permits only one selection in its own turn",
        );
      },
    );
  }
});

test("invalid selections cannot present duplicate, variant, unknown or historical product IDs", async (t) => {
  for (const [name, selection] of [
    ["duplicate", { productIds: [productGid(123), productGid(123)] }],
    ["variant", { productIds: ["gid://shopify/ProductVariant/123"] }],
    ["unknown", { productIds: [productGid(999)] }],
    ["empty", { productIds: [] }],
    ["too many", { productIds: [1, 2, 3, 4, 5, 6, 7].map(productGid) }],
    ["extra fields", { productIds: [productGid(123)], title: "Forged" }],
    ["invalid JSON", "not JSON"],
  ]) {
    await t.test(name, async () => {
      const env = setup();
      env.streams.push(
        events(completed("", { output: [catalogCall("catalog-1")] })),
        events(
          completed("", {
            output: [catalogCall("show-1", "show_products", selection)],
          }),
        ),
        events(completed("I can explain the available option.")),
      );
      const reply = await env.api.generateReply(
        [
          {
            role: "assistant",
            text: `Earlier product reference: ${productGid(999)}`,
          },
        ],
        () => {},
        new AbortController().signal,
        async () => catalogResult(123, 1, 2, 3, 4, 5, 6, 7),
      );
      assert.equal(reply.presentation, undefined);
      const result = env.calls.requests[2].input.input.find(
        (item) =>
          item.type === "function_call_output" && item.call_id === "show-1",
      );
      assert.deepEqual(Object.keys(JSON.parse(result.output)), ["error"]);
      assert.equal(
        env.calls.requests[2].input.tools.some(
          (tool) => tool.name === "show_products",
        ),
        false,
        "An invalid selection also consumes the presentation attempt",
      );
    });
  }
});

test("a second presentation attempt fails without replacing the first selection", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [catalogCall("catalog-1")] })),
    events(completed("", { output: [showCall([123])] })),
    events(completed("", { output: [showCall([456], "show-2")] })),
  );
  await assert.rejects(
    env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => catalogResult(123, 456),
    ),
    /presentation limit/,
  );
  assert.equal(env.calls.requests.length, 3);
});

test("four browser calls and one local presentation leave a final answer round without tools", async () => {
  const env = setup();
  for (let index = 0; index < 3; index++)
    env.streams.push(
      events(
        completed("", {
          output: [catalogCall(`catalog-${index}`)],
        }),
      ),
    );
  env.streams.push(
    events(
      completed("", {
        output: [
          catalogCall("navigate-1", "navigate", {
            path: "/products/shade-123",
          }),
        ],
      }),
    ),
    events(completed("", { output: [showCall([123])] })),
    events(completed("I opened the product and selected this option.")),
  );
  const dispatched = [];
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      dispatched.push(args);
      return args[1] === "navigate"
        ? { status: "navigated", path: "/products/shade-123" }
        : catalogResult(123);
    },
  );
  assert.equal(dispatched.length, 4);
  assert.deepEqual(plain(dispatched[3]), [
    "navigate-1",
    "navigate",
    { path: "/products/shade-123" },
  ]);
  assert.deepEqual(
    env.calls.requests[4].input.tools.map((tool) => tool.name),
    ["show_products"],
  );
  assert.equal(env.calls.requests[5].input.tools, undefined);
  assert.equal(reply.presentation.productIds[0], productGid(123));
});

test("navigation success is passed to the model without creating product evidence", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", {
        output: [catalogCall("navigate-1", "navigate", { path: "/cart" })],
      }),
    ),
    events(completed("The cart is open.")),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => ({ status: "navigated", path: "/cart" }),
  );
  const result = env.calls.requests[1].input.input.find(
    (item) => item.type === "function_call_output",
  );
  assert.deepEqual(JSON.parse(result.output), {
    status: "navigated",
    path: "/cart",
  });
  assert.equal(reply.presentation, undefined);
  assert.equal(
    env.calls.requests[1].input.tools.some(
      (tool) => tool.name === "show_products",
    ),
    true,
  );
});

test("invalid or interrupted navigation yields an honest error without automatic replay", async (t) => {
  for (const path of ["https://other-store.test/products/shade", "/cart"]) {
    await t.test(path, async () => {
      const env = setup();
      env.streams.push(
        events(
          completed("", {
            output: [catalogCall("navigate-1", "navigate", { path })],
          }),
        ),
        events(completed("I could not confirm that navigation.")),
      );
      let dispatched = 0;
      const reply = await env.api.generateReply(
        [],
        () => {},
        new AbortController().signal,
        async () => {
          dispatched++;
          throw new Error("PRIVATE_NAVIGATION_FAILURE");
        },
      );
      assert.equal(dispatched, path === "/cart" ? 1 : 0);
      const result = env.calls.requests[1].input.input.find(
        (item) => item.type === "function_call_output",
      );
      assert.match(JSON.parse(result.output).error, /could not be confirmed/);
      assert.doesNotMatch(result.output, /PRIVATE_NAVIGATION_FAILURE/);
      assert.equal(reply.presentation, undefined);
    });
  }
});

test("product evidence does not survive into another model turn", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [catalogCall("catalog-1")] })),
    events(completed("", { output: [showCall([123])] })),
    events(completed("Here is a shade.")),
    events(completed("", { output: [showCall([123], "show-later")] })),
    events(completed("I need a fresh lookup to recommend it again.")),
  );
  const execute = async () => catalogResult(123);
  await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    execute,
  );
  const reply = await env.api.generateReply(
    [{ role: "assistant", text: `Earlier product: ${productGid(123)}` }],
    () => {},
    new AbortController().signal,
    execute,
  );
  assert.equal(reply.presentation, undefined);
  assert.equal(
    env.calls.requests[3].input.tools.some(
      (tool) => tool.name === "show_products",
    ),
    true,
    "Advertising the carousel capability does not trust historical IDs",
  );
});

test("a selected carousel is not returned when the final answer fails or is cancelled", async (t) => {
  for (const mode of ["failed", "cancelled"]) {
    await t.test(mode, async () => {
      const env = setup();
      const controller = new AbortController();
      env.streams.push(
        events(completed("", { output: [catalogCall("catalog-1")] })),
        events(completed("", { output: [showCall([123])] })),
        (async function* () {
          if (mode === "cancelled") controller.abort(new Error("Ended"));
          yield mode === "failed"
            ? { type: "response.failed" }
            : completed("A late answer.");
        })(),
      );
      await assert.rejects(
        env.api.generateReply(
          [],
          () => {},
          controller.signal,
          async () => catalogResult(123),
        ),
      );
      assert.equal(env.calls.requests.length, 3);
    });
  }
});

test("cancellation between function calls prevents another browser dispatch or provider round", async () => {
  const env = setup();
  const controller = new AbortController();
  env.streams.push(
    events(
      completed("", { output: [catalogCall("call-1"), catalogCall("call-2")] }),
    ),
  );
  let executions = 0;
  await assert.rejects(
    env.api.generateReply(
      [],
      () => {},
      controller.signal,
      async () => {
        executions++;
        controller.abort(new Error("Conversation ended"));
        return { products: [], messages: [] };
      },
    ),
    /Conversation ended/,
  );
  assert.equal(executions, 1);
  assert.equal(env.calls.requests.length, 1);
});

test("an aborted turn cannot accept a late provider completion", async () => {
  const env = setup();
  const controller = new AbortController();
  env.streams.push(
    (async function* () {
      controller.abort(new Error("Conversation ended"));
      yield completed("A late completed answer.");
    })(),
  );
  await assert.rejects(
    env.api.generateReply([], () => {}, controller.signal),
    /Conversation ended/,
  );
  assert.equal(env.calls.requests.length, 1);
});

test("End aborts a pending browser lookup and cannot start another model round", async () => {
  const env = setup();
  env.streams.push(events(completed("", { output: [catalogCall("call-1")] })));
  env.mock.executeTool = async (...args) => {
    const signal = args.at(-1);
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  await env.api.startTurn("one", firstInput);
  await flush();
  assert.equal(env.calls.browserTools.length, 1);
  const ended = await env.api.endTurn("one");
  await flush();
  assert.equal(ended.status, "ended");
  assert.equal((await env.api.readConversation("one")).busy, false);
  assert.equal(env.calls.browserTools[0].at(-1).aborted, true);
  assert.equal(env.calls.requests.length, 1);
  await assert.rejects(env.api.startTurn("one", secondInput), { status: 409 });
});

test("streaming text preserves an already-persisted product widget", async () => {
  const env = setup();
  const generation = pendingReply("Here are current options.");
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  const widget = {
    type: "products",
    version: 1,
    invocationId: "test-invocation",
    productIds: ["gid://shopify/Product/123"],
  };
  env.rows.get("one").messages[1].extraParts = [widget];
  await flush();
  const current = await env.api.readConversation("one");
  assert.deepEqual(plain(current.messages[1].parts), [
    { type: "text", text: "Here are current options." },
    widget,
  ]);
  generation.complete();
  await flush();
});

const VOICE_ID = "b3d1a5c9-814c-458f-a2a6-33c91b5f1d05";

function voiceHistory(env, history) {
  const textBegin = env.mock.begin;
  env.mock.begin = async (id, input, voiceId) => {
    if (!voiceId) return textBegin(id, input);
    env.calls.begins.push({ id, input, voiceId });
    await env.mock.beforeBegin?.(id, input, voiceId);
    let row = env.rows.get(id);
    if (!row) {
      row = { status: "active", revision: 0, messages: [], tools: [] };
      env.rows.set(id, row);
    }
    if (row.messages.some((message) => message.status === "pending"))
      throw new env.api.ConversationError(409, "Wait for the current reply.");
    const assistantId = `${id}-voice-${row.messages.length}`;
    row.messages.push({
      id: assistantId,
      role: "context",
      status: "pending",
      text: "",
      requestId: input.requestId,
    });
    return { snapshot: env.snapshot(id), assistantId, history: plain(history) };
  };
}

test("voice delegation forwards canonical caption history to Luna without a fabricated customer message", async () => {
  const env = setup();
  const history = [
    { role: "user", text: "I need blinds for my kitchen." },
    { role: "assistant", text: "Would you prefer blackout?" },
    { role: "user", text: "Yes, show a blackout roller carousel." },
  ];
  voiceHistory(env, history);
  env.streams.push(events(completed("These are verified blackout rollers.")));
  const reply = await env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  assert.equal(reply.text, "These are verified blackout rollers.");
  assert.deepEqual(plain(env.calls.begins), [
    {
      id: "voice",
      input: { requestId: firstInput.requestId, text: "" },
      voiceId: VOICE_ID,
    },
  ]);
  assert.deepEqual(
    env.calls.requests[0].input.input,
    history.map(({ role, text }) => ({ role, content: text })),
  );
  assert.match(
    env.calls.requests[0].input.instructions,
    /latest spoken request/,
  );
  assert.match(
    env.calls.requests[0].input.instructions,
    /not a second chat message/,
  );
  assert.equal(env.calls.requests[0].input.model, "gpt-5.6-luna");
  assert.equal(env.calls.requests[0].input.service_tier, "fast");
  assert.equal(env.calls.requests[0].input.store, false);
  assert.equal(env.rows.get("voice").messages.length, 1);
  assert.equal(env.rows.get("voice").messages[0].role, "context");
  assert.equal(env.calls.finishes[0].result.status, "complete");
});

test("voice partial briefings never overlay transcript snapshots", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Show me blackout blinds." }]);
  const generation = pendingReply("PRIVATE_UNSPOKEN_BRIEFING");
  env.streams.push(generation.stream);
  const pending = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  const snapshot = await env.api.readConversation("voice");
  assert.equal(snapshot.busy, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_UNSPOKEN_BRIEFING/);
  assert.equal(env.calls.recoveries.length, 0);
  generation.complete("Confirmed product facts for Roman to communicate.");
  await pending;
});

test("voice and text share one global concurrency budget", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Find blackout blinds." }]);
  const generations = Array.from({ length: 4 }, () => pendingReply());
  generations.forEach((generation) => env.streams.push(generation.stream));
  await env.api.startTurn("text", firstInput);
  const delegates = Array.from({ length: 3 }, (_, index) =>
    env.api.runVoiceDelegation(
      `voice-${index}`,
      VOICE_ID,
      firstInput.requestId,
      new AbortController().signal,
    ),
  );
  await flush();
  await assert.rejects(
    env.api.runVoiceDelegation(
      "extra-voice",
      VOICE_ID,
      firstInput.requestId,
      new AbortController().signal,
    ),
    { status: 429 },
  );
  await assert.rejects(env.api.startTurn("extra-text", firstInput), {
    status: 429,
  });
  assert.equal(env.calls.requests.length, 4);
  generations.forEach((generation) => generation.complete());
  await Promise.all(delegates);
  await flush();
});

test("voice delegation uses the existing browser executor and local carousel presentation", async () => {
  const env = setup();
  voiceHistory(env, [
    { role: "user", text: "Show blackout rollers in a carousel." },
  ]);
  env.streams.push(
    events(completed("", { output: [catalogCall("voice-search")] })),
    events(completed("", { output: [showCall([456, 123], "voice-show")] })),
    events(
      completed("Two blackout rollers are displayed in the chat carousel."),
    ),
  );
  env.mock.executeTool = async () => catalogResult(123, 456, 789);
  const reply = await env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  assert.deepEqual(plain(reply.presentation), {
    callId: "voice-show",
    productIds: [productGid(456), productGid(123)],
  });
  assert.equal(env.calls.browserTools.length, 1);
  assert.deepEqual(plain(env.calls.browserTools[0].slice(0, 5)), [
    "voice",
    "voice-voice-0",
    "voice-search",
    "search_products",
    { query: "no drill" },
  ]);
  assert.equal(env.calls.browserTools[0].at(-1).aborted, false);
  assert.deepEqual(
    plain(env.calls.finishes[0].result.presentation),
    plain(reply.presentation),
  );
});

test("stopping voice aborts a waiting navigation and never retries the action", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Open the selected product." }]);
  env.streams.push(
    events(
      completed("", {
        output: [
          catalogCall("voice-navigate", "navigate", {
            path: "/products/shade-123",
          }),
        ],
      }),
    ),
  );
  env.mock.executeTool = async (...args) =>
    new Promise((_resolve, reject) => {
      const signal = args.at(-1);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const pending = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  const signal = env.calls.browserTools[0].at(-1);
  await env.api.cancelVoiceDelegation("voice", VOICE_ID);
  assert.equal(signal.aborted, true);
  assert.equal(await pending, undefined);
  assert.equal(env.calls.browserTools.length, 1);
  assert.equal(env.calls.requests.length, 1);
  assert.equal(env.calls.finishes.at(-1).result.status, "failed");
  assert.equal((await env.api.readConversation("voice")).busy, false);
  assert.equal(env.logs.length, 0);
});

test("cancel during voice initialization finishes the reserved work without calling Luna", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Open a product." }]);
  const begin = deferred();
  env.mock.beforeBegin = () => begin.promise;
  const controller = new AbortController();
  const pending = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    controller.signal,
  );
  await flush();
  controller.abort();
  const cancelled = env.api.cancelVoiceDelegation("voice", VOICE_ID);
  begin.resolve();
  await Promise.all([pending, cancelled]);
  assert.equal(env.calls.requests.length, 0);
  assert.equal(env.calls.browserTools.length, 0);
  assert.equal((await env.api.readConversation("voice")).busy, false);
});

test("stale cancelled voice completion cannot remove or overwrite a newer text owner", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Find me a roller." }]);
  const voice = pendingReply("Old private briefing.");
  const text = pendingReply("New text answer in progress.");
  env.streams.push(voice.stream, text.stream);
  const old = env.api.runVoiceDelegation(
    "one",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  await env.api.cancelVoiceDelegation("one", VOICE_ID);
  await env.api.startTurn("one", secondInput);
  await flush();
  voice.complete("A late obsolete answer.");
  assert.equal(await old, undefined);
  const snapshot = await env.api.readConversation("one");
  assert.equal(snapshot.busy, true);
  assert.equal(
    snapshot.messages.at(-1).parts[0].text,
    "New text answer in progress.",
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /late obsolete/);
  await assert.rejects(
    env.api.startTurn("one", { requestId: "third", text: "Do not overlap." }),
    { status: 409 },
  );
  await env.api.cancelVoiceDelegation("one", VOICE_ID);
  assert.equal(
    env.calls.requests[1].options.signal.aborted,
    false,
    "Cancelling an old voice ID cannot abort a text turn",
  );
  text.complete();
  await flush();
});

test("a different voice ID cannot cancel the active delegated work", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Find me a blind." }]);
  const generation = pendingReply();
  env.streams.push(generation.stream);
  const pending = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  await env.api.cancelVoiceDelegation(
    "voice",
    "47f730c4-40c7-4b82-93d1-1966c8babfb9",
  );
  assert.equal(env.calls.requests[0].options.signal.aborted, false);
  assert.equal(env.calls.finishes.length, 0);
  generation.complete();
  await pending;
});
