import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

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
    mock,
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
      ["search_products", "get_product", "lookup_catalog"],
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

test("catalog call budget disables tools after four lookups and rejects an extra provider call", async () => {
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
    if (extraCall) await assert.rejects(generation, /lookup limit/);
    else
      assert.equal((await generation).text, "These are the current options.");
    assert.equal(executions, 4);
    assert.equal(env.calls.requests.length, 5);
    assert.equal(env.calls.requests[4].input.tool_choice, "none");
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
