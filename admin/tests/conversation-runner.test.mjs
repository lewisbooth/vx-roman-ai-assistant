import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
      export { ROMAN_TEXT_PROMPT } from "./admin/prompts/text.server.ts";
      export { ROMAN_VOICE_BRIEFING_PROMPT } from "./admin/prompts/voice.server.ts";
      export { ROMAN_CART_GUIDANCE } from "./admin/prompts/knowledge-base/cart.ts";
      export { readGuideSession, saveGuideSession } from "./admin/guides/session.server.ts";
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
          {
            filter:
              /availability\.server$|repository\.server$|browser-tools\.server$|measurements\/service\.server$|guides\/(?:files|library)\.server$|^openai$/,
          },
          (args) => {
            if (
              args.path.endsWith("guides/library.server") &&
              !args.importer.endsWith("runner.server.ts")
            )
              return;
            return { path: args.path, namespace: "stub" };
          },
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          resolveDir: process.cwd(),
          contents:
            args.path.endsWith("availability.server")
              ? `export const PRIMARY_TEXT_MODEL="gpt-6-luna";
                export const FALLBACK_TEXT_MODEL="gpt-5.6-luna";
                export const UNAVAILABLE_MESSAGE="Roman is currently unavailable";
                export const onServiceSuspended=()=>()=>{};
                export const isServiceSuspended=()=>false;
                export const assertServiceAvailable=async()=>{};
                export const textModelForRequest=async()=>"gpt-6-luna";
                export const reportPrimaryUnavailable=async()=>{};
                export const reportFallbackUnavailable=async()=>{};`
              : args.path === "openai"
              ? `export default class OpenAI {
              static APIError = class APIError extends Error {};
              static APIConnectionError = class APIConnectionError extends OpenAI.APIError {};
              constructor(options) {
                mock.clients.push(options);
                this.responses={create:(...args)=>mock.createResponse(...args)};
              }
            }`
              : args.path.endsWith("browser-tools.server")
                ? `export const requestBrowserTool=(...args)=>mock.browserTool(...args);`
                : args.path.includes("measurements")
                  ? `export const executeMeasurementTool=(...args)=>mock.measurementTool(...args);`
                  : args.path.endsWith("guides/library.server")
                    ? `export * from "./admin/guides/library.server.ts";
                      export const readLibraryInventory=(...args)=>mock.libraryInventory(...args);
                      export const readBoundLibrarySource=(...args)=>mock.libraryBound(...args);`
                    : args.path.includes("guides")
                      ? `export const readProductGuideFiles=(...args)=>mock.guideFiles(...args);
                       export const readGuideFile=(...args)=>mock.guideFile(...args);`
                      : args.path.includes("usage")
                        ? `export const recordModelUsage=(...args)=>mock.usage(...args);`
                        : `export const beginTurn=(...args)=>mock.begin(...args);
             export const failPending=(...args)=>mock.recover(...args);
             export const finishTurn=(...args)=>mock.finish(...args);
             export const getSnapshot=(...args)=>mock.snapshot(...args);
             export const getReadRevision=(...args)=>mock.readRevision(...args);
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
const guideOrigin = "https://hd-dev-single.myshopify.com";
const syntheticGuideFile = (kind) => ({
  type: "input_file",
  filename: `${kind}-guide.pdf`,
  file_data:
    "data:application/pdf;base64,JVBERi0xLjcKc3ludGhldGljLWd1aWRlCiUlRU9G",
  detail: "high",
});
const secondInput = {
  requestId: "2bd71077-fddd-40c2-9207-5489ab6238f9",
  text: "It is for my bedroom.",
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const nextActionQuestion = "What would you like to do next?";
function assertNextActions(reply) {
  const { callId, ...selection } = plain(reply.questionPresentation ?? {});
  assert.equal(callId, "fixture-next-actions");
  assert.deepEqual(selection, {
    question: nextActionQuestion,
    answers: ["Help me measure", "Explore products", "Find my style"],
  });
}
const allowedToolNames = (request) =>
  request.tool_choice === "none"
    ? []
    : request.tool_choice.tools.map(({ name }) => name);
const allowedTools = (request) =>
  request.tools.filter(({ name }) => allowedToolNames(request).includes(name));
const guideFiles = (request) =>
  request.input
    .filter((item) => item.role === "user" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part.type === "input_file");
const cachedGuideFile = (kind) => ({
  ...syntheticGuideFile(kind),
  prompt_cache_breakpoint: { mode: "explicit" },
});

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
    output: [
      catalogCall("fixture-next-actions", "ask_question", {
        message: text,
        question: nextActionQuestion,
        answers: ["Help me measure", "Explore products", "Find my style"],
      }),
    ],
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
    snapshots: [],
    deadlines: [],
    browserTools: [],
    ends: [],
    usage: [],
    guideReads: [],
    fileReads: [],
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
    origin: guideOrigin,
    usage: async (...args) => calls.usage.push(plain(args)),
    guideFiles: async (...args) => {
      calls.guideReads.push(args);
      return mock.readGuides(...args);
    },
    libraryInventory: () => [],
    libraryBound: () => undefined,
    guideFile: async (...args) => {
      calls.fileReads.push(args);
      return {
        status: "ready",
        file: {
          ...syntheticGuideFile("library"),
          filename: args[3]?.filename ?? "library.pdf",
        },
      };
    },
    readGuides: async (result) =>
      result.status === "found"
        ? {
            status: "ready",
            sources: result.guides,
            files: result.guides.map(({ kind }) => syntheticGuideFile(kind)),
          }
        : { status: "unavailable", reason: "no_guides" },
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
      const assistantId =
        mock.assistantId?.() ?? `${id}-assistant-${row.messages.length + 1}`;
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
        origin: mock.origin,
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
          ensure(id).revision++;
        }
      });
    },
    finish: async (id, assistantId, result) => {
      calls.finishes.push({ id, assistantId, result });
      await mock.beforeFinish?.(id, assistantId, result);
      const message = ensure(id).messages.find(
        (message) => message.id === assistantId,
      );
      if (message?.status === "pending") {
        Object.assign(message, result, {
          status: result.status === "cancelled" ? "complete" : result.status,
        });
        ensure(id).revision++;
      }
      await mock.afterFinish?.(id, assistantId, result);
      return true;
    },
    snapshot: async (id) => {
      calls.snapshots.push(id);
      return snapshot(id);
    },
    readRevision: async (id, recoverPending) => {
      if (recoverPending) await mock.recover(id);
      return ensure(id).revision ?? 0;
    },
    browserTool: async (...args) => {
      calls.browserTools.push(args);
      return mock.executeTool(...args);
    },
    executeTool: async () => {
      throw new Error("No browser tool result supplied.");
    },
    measurementTool: async () => {
      throw new Error("No measurement result supplied.");
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
    Buffer,
    URL,
    performance,
    TextEncoder,
    AbortController,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        calls.deadlines.push(milliseconds);
        return new AbortController().signal;
      },
    },
    console: {
      info: (...args) => (calls.metrics ??= []).push(args),
      error: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
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

test("a complete recommendation stays invisible until its persistence commits", async (t) => {
  for (const outcome of ["committed", "failed"])
    await t.test(outcome, async () => {
      const env = setup();
      const commit = deferred();
      env.mock.beforeFinish = (_id, _assistant, result) =>
        result.status === "complete" ? commit.promise : undefined;
      env.mock.executeTool = async () => catalogResult(123);
      env.streams.push(
        events(completed("", { output: [catalogCall("search")] })),
        recommendation([123], {
          ...questionSelection,
          message: "COMPLETE_RECOMMENDATION",
        }),
      );
      await env.api.startTurn("atomic", firstInput);
      await flush();
      assert.equal(env.calls.finishes.length, 1);
      const pending = await env.api.readConversation("atomic");
      assert.equal(pending.messages.at(-1).status, "pending");
      assert.doesNotMatch(
        JSON.stringify(pending),
        /COMPLETE_RECOMMENDATION|Shade 123/,
      );
      if (outcome === "committed") commit.resolve();
      else commit.reject(new Error("Persistence unavailable"));
      await flush();
      const final = await env.api.readConversation("atomic");
      assert.equal(
        final.messages.at(-1).status,
        outcome === "committed" ? "complete" : "failed",
      );
      if (outcome === "committed")
        assert.equal(
          final.messages.at(-1).parts[0].text,
          "COMPLETE_RECOMMENDATION",
        );
      else
        assert.doesNotMatch(
          JSON.stringify(final),
          /COMPLETE_RECOMMENDATION|Shade 123/,
        );
    });
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
  await flush();
  assert.equal(env.calls.requests.length, 4);
  generations[0].complete();
  await flush();
  await env.api.startTurn("chat-4", firstInput);
  await flush();
  assert.equal(env.calls.requests.length, 5);
  generations.slice(1).forEach((generation) => generation.complete());
  await flush();
});

test("pending snapshots never expose preliminary model narration while HTTP acceptance stays independent", async () => {
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
  assert.equal(partial.messages[1].parts[0].text, "");
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

test("versioned reads skip history while preliminary prose is held until final publication", async () => {
  const env = setup();
  const next = deferred();
  const finish = deferred();
  env.streams.push(
    (async function* () {
      yield { type: "response.output_text.delta", delta: "First" };
      await next.promise;
      yield { type: "response.output_text.delta", delta: " second" };
      yield await finish.promise;
    })(),
  );
  await env.api.startTurn("one", firstInput);
  await flush();
  const first = await env.api.readConversation("one");
  assert.equal(first.streamRevision, 0);
  const count = env.calls.snapshots.length;
  for (let index = 0; index < 20; index++)
    assert.deepEqual(plain(await env.api.readConversation("one", first)), {
      id: "one",
      revision: first.revision,
      streamRevision: 0,
      unchanged: true,
    });
  assert.equal(
    env.calls.snapshots.length,
    count,
    "unchanged reads never load history",
  );
  next.resolve();
  await flush();
  const second = await env.api.readConversation("one", first);
  assert.equal(second.revision, first.revision);
  assert.equal(second.streamRevision, 0);
  assert.equal(second.unchanged, true);
  assert.equal(env.calls.snapshots.length, count);
  finish.resolve(completed("A finished answer."));
  await flush();
  const done = await env.api.readConversation("one", second);
  assert.ok(done.revision > second.revision);
  assert.equal(done.streamRevision, 0);
  assert.equal(done.busy, false);
  assert.equal(done.messages[1].parts[0].text, "A finished answer.");
});

test("an ended turn cannot publish late partial text or return unchanged old state", async () => {
  const env = setup();
  const generation = pendingReply("An unfinished answer.");
  env.streams.push(generation.stream);
  await env.api.startTurn("one", firstInput);
  await flush();
  const partial = await env.api.readConversation("one");
  await env.api.endTurn("one");
  generation.complete("A late answer.");
  await flush();
  const ended = await env.api.readConversation("one", partial);
  assert.equal(ended.status, "ended");
  assert.equal(ended.streamRevision, 0);
  assert.equal(ended.messages[1].status, "failed");
  assert.ok(
    ended.messages.every(
      (message) =>
        !message.parts.some((part) => part.text === "A late answer."),
    ),
  );
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
  assert.equal(result.messages[1].parts[0].text, "");
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

test("the actual model client sets fast/medium/store=false, passes the signal and keeps customer text out of instructions", async () => {
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
  assert.equal(input.model, "gpt-6-luna");
  assert.equal(input.service_tier, "fast");
  assert.deepEqual(plain(input.reasoning), { effort: "medium" });
  assert.equal(input.store, false);
  assert.equal(input.stream, true);
  assert.equal(input.max_output_tokens, 8192);
  assert.deepEqual(
    allowedTools(input).map((tool) => tool.name),
    ["ask_question"],
    "only the local question tool is available without a browser executor",
  );
  assert.equal(options.signal, signal);
  assert.equal(input.instructions.includes("Private room preference"), false);
  assert.equal(input.instructions, env.api.ROMAN_TEXT_PROMPT);
  assert.deepEqual(
    plain(input.input.filter(({role}) => role !== "developer")),
    history.map(({ role, text }) => ({ role, content: text })),
  );
  assert.deepEqual(plain(env.mock.clients), [
    { maxRetries: 0, timeout: 90000 },
  ]);
});

test("voice backend requests retain tool policy without text greetings or presentation instructions", async () => {
  const env = setup();
  env.streams.push(events(completed("The requested product was found.")));
  await env.api.generateReply(
    [{ role: "user", text: "Find blackout blinds." }],
    () => {},
    new AbortController().signal,
    undefined,
    "voice",
  );
  const instructions = env.calls.requests[0].input.instructions;
  assert.equal(instructions, env.api.ROMAN_VOICE_BRIEFING_PROMPT);
  assert.notEqual(instructions, env.api.ROMAN_TEXT_PROMPT);
  assert.equal(env.calls.requests[0].input.reasoning.effort, "medium");

});

test("explicit low reasoning remains available for text and voice evaluations", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(events(completed()));
    await env.api.generateReply(
      [{ role: "user", text: "Synthetic evaluation request." }],
      () => {},
      new AbortController().signal,
      undefined,
      mode,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "low",
    );
    const input = env.calls.requests[0].input;
    assert.equal(input.reasoning.effort, "low");
    assert.equal(input.service_tier, "fast");
    assert.equal(input.model, "gpt-6-luna");
    assert.equal(input.store, false);
  }
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
  assert.deepEqual(partials, ["Final text. I cannot help with that request."]);
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
          if (mode === "empty") yield completed("", { output: [] });
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
      if (mode === "end")
        env.streams.push((async function* () {})());
      await assert.rejects(
        env.api.generateReply([], () => {}, new AbortController().signal),
        (error) => !error.message.includes("private"),
      );
      assert.equal(env.calls.requests.length, mode === "end" ? 2 : 1);
    });
  }
});

test("a failed follow-up after showing Cart logs only provider categories without replaying work", async (t) => {
  const cases = [
    ...["content_filter", "steered"].map(
      (reason) => ({
        name: reason,
        event: "response.incomplete",
        details: { incomplete_details: { reason } },
        diagnostic: { providerStatus: "incomplete", incompleteReason: reason },
      }),
    ),
    {
      name: "unknown provider fields",
      event: "response.incomplete",
      details: {
        incomplete_details: { reason: "PRIVATE_REASON" },
        error: { code: "PRIVATE_CODE", message: "PRIVATE_PROVIDER_BODY" },
      },
      diagnostic: {
        providerStatus: "incomplete",
        incompleteReason: "unknown",
        providerCode: "unknown",
      },
    },
    {
      name: "missing incomplete details",
      event: "response.incomplete",
      details: {},
      diagnostic: { providerStatus: "incomplete", incompleteReason: "unknown" },
    },
    {
      name: "known response error",
      event: "response.failed",
      details: {
        error: { code: "server_error", message: "PRIVATE_PROVIDER_BODY" },
      },
      diagnostic: { providerStatus: "failed", providerCode: "server_error" },
    },
    {
      name: "stream error",
      event: "error",
      code: "rate_limit_exceeded",
      diagnostic: {
        providerStatus: "error",
        providerCode: "rate_limit_exceeded",
      },
    },
    {
      name: "unknown stream error",
      event: "error",
      code: "PRIVATE_CODE",
      diagnostic: { providerStatus: "error", providerCode: "unknown" },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const env = setup();
      env.mock.executeTool = async (_id, _assistant, _call, name) => {
        assert.equal(name, "show_view");
        return { status: "shown", view: "cart" };
      };
      const failed = {
        type: item.event,
        message: "PRIVATE_PROVIDER_BODY",
        code: item.code,
        response: {
          model: "gpt-5.6-luna",
          ...item.details,
          output: [catalogCall("unconfirmed", "clear_cart", {})],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      };
      env.streams.push(
        events(
          completed("", {
            output: [catalogCall("show-cart", "show_view", { view: "cart" })],
          }),
        ),
        events(failed),
      );
      const backupAttempt =
        item.name === "known response error" || item.name === "stream error";
      if (backupAttempt) env.streams.push(events(failed));
      await env.api.startTurn("cart-follow-up", {
        ...firstInput,
        text: "View cart",
      });
      await flush();
      const snapshot = await env.api.readConversation("cart-follow-up");
      assert.equal(snapshot.busy, false);
      assert.equal(snapshot.messages[1].status, "failed");
      assert.match(snapshot.messages[1].error, /could not finish this reply/);
      assert.equal(
        env.calls.requests.length,
        backupAttempt ? 3 : 2,
        "A fallback round must not replay the confirmed view change",
      );
      assert.equal(
        env.calls.browserTools.length,
        1,
        "Incomplete output must never execute another action",
      );
      assert.deepEqual(plain(env.logs), [
        [
          "[Roman] Text reply failed.",
          {
            conversationId: "cart-follow-up",
            category: "ModelResponseError",
            ...item.diagnostic,
          },
        ],
      ]);
      assert.doesNotMatch(JSON.stringify([snapshot, env.logs]), /PRIVATE_/);
      assert.equal(env.calls.usage.length, backupAttempt ? 6 : 4);
      assert.equal(
        env.calls.usage.at(-1)[2].status,
        item.event === "error"
          ? "unavailable"
          : item.event.slice("response.".length),
      );
      if (item.event !== "error") {
        assert.equal(env.calls.usage.at(-1)[2].outputTokens, 50);
        assert.equal(env.calls.usage.at(-1)[2].reasoningTokens, 30);
      }
    });
  }
});

test("a truncated answer after catalogue search publishes only the completed retry and preserves all usage", async () => {
  const env = setup();
  const product = {
    id: "gid://shopify/Product/123",
    title: "Verified catalogue shade",
    description: "",
    url: "https://hd-dev-single.myshopify.com/products/shade",
  };
  env.mock.executeTool = async (_id, _assistant, _call, name) => {
    assert.equal(name, "search_products");
    return { products: [product], messages: [] };
  };
  const usage = {
    input_tokens: 20,
    output_tokens: 10,
    total_tokens: 30,
    output_tokens_details: { reasoning_tokens: 5 },
  };
  env.streams.push(
    events(completed("", { output: [catalogCall("completed-search")], usage })),
    events(
      { type: "response.output_text.delta", delta: "PRIVATE_INCOMPLETE_TEXT" },
      incompleteAnswer("max_output_tokens"),
    ),
    events(completed("", {
      output: [catalogCall("verified-answer", "ask_question", {
        message: "Here is a matching shade.",
        productIds: [product.id],
        question: "Which room is this for?",
        answers: ["Bedroom", "Kitchen"],
      })],
      usage,
    })),
  );
  await env.api.startTurn("catalogue-retry", firstInput);
  await flush();
  const snapshot = await env.api.readConversation("catalogue-retry");
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.messages[1].status, "complete");
  assert.equal(snapshot.messages[1].parts[0].text, "Here is a matching shade.");
  assert.equal(env.calls.finishes.length, 1);
  assert.deepEqual(plain(env.calls.finishes[0].result.presentation.productRefs), [
    { id: product.id, title: product.title },
  ]);
  assert.equal(env.calls.browserTools.length, 1);
  assert.deepEqual(env.calls.requests.map(({ input }) => input.max_output_tokens), [8192, 8192, 16384]);
  assert.deepEqual(env.calls.usage.map((entry) => entry[2].status), [
    "pending", "completed", "pending", "incomplete", "pending", "completed",
  ]);
  assert.deepEqual(env.calls.usage.filter((entry) => entry[2].status !== "pending").map((entry) => entry[2].totalTokens), [30, 150, 30]);
  assert.doesNotMatch(JSON.stringify([snapshot, env.calls.finishes, env.logs, env.calls.requests]), /PRIVATE_INCOMPLETE/);
  assert.equal(env.logs.some(([message]) => message === "[Roman] Text reply failed."), false);
});

function incompleteAnswer(reason = "max_messages") {
  return {
    type: "response.incomplete",
    response: {
      model: "gpt-5.6-luna",
      incomplete_details: { reason },
      output: [
        catalogCall("unconfirmed-mutation", "clear_cart", {
          private: "PRIVATE_INCOMPLETE_OUTPUT",
        }),
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        output_tokens_details: { reasoning_tokens: 30 },
      },
    },
  };
}

for (const mode of ["text", "voice"]) {
  test(`max_messages after a confirmed Cart view gets one terminal-only repair: ${mode}`, async () => {
    const env = setup(),
      executions = [],
      visible = [],
      usage = [];
    env.streams.push(
      events(
        completed("", {
          output: [catalogCall("show-cart", "show_view", { view: "cart" })],
        }),
      ),
      events(incompleteAnswer()),
      events(completed("Your cart is open.")),
    );
    const reply = await env.api.generateReply(
      [{ role: "user", text: "View cart" }],
      (value) => visible.push(value),
      new AbortController().signal,
      async (_id, name) => {
        executions.push(name);
        return { status: "shown", view: "cart" };
      },
      mode,
      async (value) => usage.push(plain(value)),
    );
    assert.deepEqual(executions, ["show_view"]);
    assert.equal(env.calls.requests.length, 3);
    assert.deepEqual(allowedToolNames(env.calls.requests[2].input), [
      "ask_question",
      "ask_measurement",
    ]);
    assert.equal(env.calls.requests[2].input.tool_choice.mode, "required");
    const inputs = env.calls.requests[2].input.input;
    const result = inputs.find(
      (item) => item.type === "function_call_output",
    );
    assert.deepEqual(JSON.parse(result.output), {
      status: "shown",
      view: "cart",
    });
    assert.doesNotMatch(
      JSON.stringify(inputs),
      /unconfirmed-mutation|PRIVATE_INCOMPLETE_OUTPUT/,
    );
    assert.deepEqual(visible, [reply.text]);
    assert.match(reply.text, /^Your cart is open\./);
    assertNextActions(reply);
    assert.deepEqual(
      usage.map(({ status }) => status),
      [
        "pending",
        "completed",
        "pending",
        "incomplete",
        "pending",
        "completed",
      ],
    );
    assert.equal(usage[3].outputTokens, 50);
    assert.equal(usage[3].reasoningTokens, 30);
    assert.deepEqual(plain(env.logs), [
      [
        "[Roman] Repairing incomplete reply.",
        { providerStatus: "incomplete", incompleteReason: "max_messages" },
      ],
    ]);
  });
}

test("terminal recovery shares one repair budget and rejects any further action without dispatch", async (t) => {
  for (const failure of [
    "incomplete_again",
    "action_during_repair",
    "invalid_answer",
    "already_repaired",
  ]) {
    await t.test(failure, async () => {
      const env = setup(),
        executions = [];
      const plainReply = completed("", {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Your cart is open." }],
          },
        ],
      });
      const final =
        failure === "action_during_repair"
          ? completed("", {
              output: [catalogCall("another-action", "clear_cart", {})],
            })
          : failure === "invalid_answer"
            ? completed("", {
                output: [
                  questionCall({
                    message: "",
                    question: "Next?",
                    answers: [],
                  }),
                ],
              })
            : incompleteAnswer();
      env.streams.push(
        events(
          completed("", {
            output: [catalogCall("show-cart", "show_view", { view: "cart" })],
          }),
        ),
        events(
          failure === "already_repaired" ? plainReply : incompleteAnswer(),
        ),
        events(final),
      );
      await assert.rejects(
        env.api.generateReply(
          [],
          () => assert.fail("No incomplete answer may be displayed"),
          new AbortController().signal,
          async (_id, name) => {
            executions.push(name);
            return { status: "shown", view: "cart" };
          },
        ),
      );
      assert.deepEqual(executions, ["show_view"]);
      assert.equal(env.calls.requests.length, 3);
      assert.deepEqual(allowedToolNames(env.calls.requests[2].input), [
        "ask_question",
        "ask_measurement",
      ]);
      assert.doesNotMatch(
        JSON.stringify(env.calls.requests[2].input.input),
        /unconfirmed-mutation|PRIVATE_INCOMPLETE_OUTPUT/,
      );
    });
  }
});

test("max_messages cannot skip an initial tool decision or restart checkout with an answer widget", async (t) => {
  for (const checkout of [false, true]) {
    await t.test(
      checkout ? "checkout sign-off" : "no completed work",
      async () => {
        const env = setup(),
          executions = [];
        if (checkout)
          env.streams.push(
            events(
              completed("", {
                output: [catalogCall("checkout", "open_checkout", {})],
              }),
            ),
          );
        env.streams.push(events(incompleteAnswer()));
        await assert.rejects(
          env.api.generateReply(
            [],
            () => assert.fail("Incomplete output cannot be displayed"),
            new AbortController().signal,
            async (_id, name) => {
              executions.push(name);
              return { status: "opened" };
            },
          ),
          (error) => {
            assert.deepEqual(plain(error.diagnostics), {
              providerStatus: "incomplete",
              incompleteReason: "max_messages",
            });
            return true;
          },
        );
        assert.equal(env.calls.requests.length, checkout ? 2 : 1);
        assert.deepEqual(executions, checkout ? ["open_checkout"] : []);
        assert.deepEqual(env.logs, []);
      },
    );
  }
});

test("cancellation after incomplete usage is recorded cannot start terminal recovery", async () => {
  const env = setup(),
    controller = new AbortController(),
    usage = [];
  env.streams.push(
    events(
      completed("", {
        output: [catalogCall("show-cart", "show_view", { view: "cart" })],
      }),
    ),
    events(incompleteAnswer()),
  );
  await assert.rejects(
    env.api.generateReply(
      [],
      () => assert.fail("Cancelled output cannot be displayed"),
      controller.signal,
      async () => ({ status: "shown", view: "cart" }),
      "text",
      async (value) => {
        usage.push(plain(value));
        if (value.status === "incomplete") controller.abort();
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(env.calls.requests.length, 2);
  assert.equal(usage.at(-1).status, "incomplete");
  assert.deepEqual(env.logs, []);
});

function events(...values) {
  return (async function* () {
    yield* values;
  })();
}

function catalogCall(
  callId,
  name = "search_products",
  args = { queries: ["no drill"] },
) {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify((name === "ask_question" || name === "ask_measurement") ? {productIds:[],...args} : args),
  };
}

test("text and voice receive the cart's named, rounded discount evidence intact", async (t) => {
  const cart = {
    currency: "GBP", itemCount: 1,
    totalPriceMinorUnits: 34598, originalTotalPriceMinorUnits: 69195,
    totalDiscountMinorUnits: 34597, cartDiscounts: [],
    items: [{
      lineKey: "123:shutter", title: "San Jose Premium Cotton White Shutter Blinds",
      variantId: 123, quantity: 1, linePriceMinorUnits: 34598,
      originalLinePriceMinorUnits: 69195,
      lineDiscounts: [{ title: "50 off test", amountMinorUnits: 34597, percentage: 50 }],
    }],
  };
  for (const mode of ["text", "voice"]) {
    await t.test(mode, async () => {
      const env = setup();
      env.streams.push(
        events(completed("", { output: [catalogCall("cart-offers", "get_cart", {})] })),
        events(completed("The shutter has 50 off test applied, saving GBP 345.97.")),
      );
      await env.api.generateReply(
        [], () => {}, new AbortController().signal,
        async (_id, name) => {
          assert.equal(name, "get_cart");
          return cart;
        }, mode,
      );
      const output = env.calls.requests[1].input.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "cart-offers",
      );
      assert.deepEqual(JSON.parse(output.output), cart);
      const prompt = env.calls.requests[0].input.instructions;
      assert.equal(prompt.split(env.api.ROMAN_CART_GUIDANCE).length - 1, 1);
    });
  }
});

test("text and voice publish only the final structured outcome after tools", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const status of ["updated", "uncertain"]) {
      await t.test(`${mode}: ${status}`, async () => {
        const env = setup();
        const checking =
          "I am checking the current cart before changing it. ".repeat(15);
        const reviewing =
          "The requested change needs your on-screen review. ".repeat(15);
        const final =
          status === "updated"
            ? "The cart is now empty. The theme confirmed the change."
            : "The cart change was not confirmed. Check the cart before requesting another change.";
        assert.ok(checking.length + reviewing.length > 1000);
        env.streams.push(
          events(
            { type: "response.output_text.delta", delta: checking },
            completed("", {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: checking }],
                },
                catalogCall("read-cart", "get_cart", {}),
              ],
            }),
          ),
          events(
            { type: "response.output_text.delta", delta: reviewing },
            completed("", {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: reviewing }],
                },
                catalogCall("clear-cart", "clear_cart", {}),
              ],
            }),
          ),
          events(
            { type: "response.output_text.delta", delta: final },
            completed(final),
          ),
        );
        const partials = [];
        const executions = [];
        const reply = await env.api.generateReply(
          [],
          (text) => partials.push(text),
          new AbortController().signal,
          async (_id, name) => {
            executions.push(name);
            return name === "get_cart"
              ? {
                  currency: "GBP",
                  itemCount: 0,
                  totalPriceMinorUnits: 0,
                  items: [],
                }
              : { status, message: final };
          },
          mode,
        );
        assert.deepEqual(executions, ["get_cart", "clear_cart"]);
        assert.equal(env.calls.requests.length, 3);
        const voiceFinal = `${final} ${nextActionQuestion}`;
        assert.equal(reply.text, mode === "voice" ? voiceFinal : final);
        assertNextActions(reply);
        if (mode === "voice")
          assert.equal(reply.text.slice(0, 1000), voiceFinal);
        else assert.deepEqual(partials, [final]);
      });
    }
  }
});

test("an output-budget retry preserves a confirmed cart mutation without replaying it", async (t) => {
  for (const mode of ["text", "voice"]) {
    await t.test(mode, async () => {
      const env = setup(), executions = [], visible = [];
      const confirmed = { status: "updated", message: "The cart is now empty." };
      env.streams.push(
        events(completed("", { output: [catalogCall("cart-read", "get_cart", {})] })),
        events(completed("", { output: [catalogCall("cart-clear", "clear_cart", {})] })),
        events(incompleteAnswer("max_output_tokens")),
        events(completed(confirmed.message)),
      );
      const reply = await env.api.generateReply(
        [{ role: "user", text: "Empty my cart." }],
        (text) => visible.push(text),
        new AbortController().signal,
        async (callId, name) => {
          executions.push([callId, name]);
          return name === "get_cart"
            ? {
                currency: "GBP", itemCount: 1, totalPriceMinorUnits: 1000,
                items: [{ lineKey: "123:shade", title: "Synthetic shade", variantId: 123, quantity: 1, linePriceMinorUnits: 1000 }],
              }
            : confirmed;
        },
        mode,
      );
      assert.deepEqual(executions, [["cart-read", "get_cart"], ["cart-clear", "clear_cart"]]);
      assert.deepEqual(visible, [reply.text]);
      assert.match(reply.text, /^The cart is now empty\./);
      assertNextActions(reply);
      assert.deepEqual(env.calls.requests.map(({ input }) => input.max_output_tokens), [8192, 8192, 8192, 16384]);
      const previous = env.calls.requests[2].input;
      const retry = env.calls.requests[3].input;
      assert.deepEqual(retry, { ...previous, max_output_tokens: 16384 });
      const results = retry.input.filter((item) => item.type === "function_call_output" && item.call_id === "cart-clear");
      assert.equal(results.length, 1);
      assert.deepEqual(JSON.parse(results[0].output), confirmed);
      assert.equal(allowedToolNames(retry).includes("clear_cart"), false);
      assert.equal(allowedToolNames(retry).includes("add_to_cart"), false);
      assert.doesNotMatch(JSON.stringify([retry, reply, visible]), /unconfirmed-mutation|PRIVATE_INCOMPLETE_OUTPUT/);
    });
  }
});

test("voice cannot substitute preliminary narration for an empty terminal briefing", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", {
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "I will check the catalog." },
            ],
          },
          catalogCall("catalog-read"),
        ],
      }),
    ),
    events(completed("", { output: [] })),
  );
  await assert.rejects(
    env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => ({ products: [], messages: [] }),
      "voice",
    ),
    /empty reply/,
  );
});

test("model cart changes have no confirmation argument and cannot automatically repeat a mutation", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", { output: [catalogCall("cart-read", "get_cart", {})] }),
    ),
    events(
      completed("", { output: [catalogCall("cart-clear", "clear_cart", {})] }),
    ),
    events(
      completed("", {
        output: [catalogCall("repeat-clear", "clear_cart", {})],
      }),
    ),
    events(completed("The result was not confirmed. Please check your cart.")),
  );
  const executions = [];
  await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (id, name, args) => {
      executions.push({ id, name, args });
      return name === "get_cart"
        ? { currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: [] }
        : {
            status: "uncertain",
            message: "Check the cart before requesting another change.",
          };
    },
  );
  assert.deepEqual(
    executions.map((call) => call.name),
    ["get_cart", "clear_cart"],
  );
  for (const call of executions) assert.equal("confirmed" in call.args, false);
  const remaining = allowedTools(env.calls.requests[2].input).map(
    (tool) => tool.name,
  );
  assert.ok(remaining.includes("get_cart"));
  assert.ok(remaining.includes("get_measurements"));
  assert.ok(!remaining.includes("clear_cart"));
  assert.ok(!remaining.includes("add_to_cart"));
  assert.ok(!remaining.includes("apply_measurements"));
  const denied = env.calls.requests[3].input.input.find(
    (item) =>
      item.type === "function_call_output" && item.call_id === "repeat-clear",
  );
  assert.match(
    JSON.parse(denied.output).error,
    /not confirmed.*not claim.*repeat/i,
  );
});

test("an addition without UI approval still consumes the one-mutation allowance in text and voice", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(
      events(
        completed("", {
          output: [
            catalogCall("first-add", "add_to_cart", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(
        completed("", {
          output: [
            catalogCall("repeat-add", "add_to_cart", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(completed("Please check the cart before another request.")),
    );
    const executions = [];
    await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (id, name, args) => {
        executions.push({ id, name, args });
        throw new Error("The browser disconnected after submitting.");
      },
      mode,
    );
    assert.deepEqual(plain(executions), [
      {
        id: "first-add",
        name: "add_to_cart",
        args: { productPath: "/products/shade" },
      },
    ]);
    const tools = allowedTools(env.calls.requests[1].input).map(
      (tool) => tool.name,
    );
    assert.ok(tools.includes("get_cart"));
    for (const name of [
      "add_to_cart",
      "remove_from_cart",
      "set_cart_quantity",
      "clear_cart",
      "apply_measurements",
    ])
      assert.equal(tools.includes(name), false, name);
    for (const callId of ["first-add", "repeat-add"]) {
      const output = env.calls.requests[2].input.input.find(
        (item) =>
          item.type === "function_call_output" && item.call_id === callId,
      );
      assert.match(
        JSON.parse(output.output).error,
        /not confirmed.*not claim.*repeat/i,
      );
    }
  }
});

test("measurement application never unlocks a cart add in the same text or voice reply", async (t) => {
  for (const mode of ["text", "voice"])
    for (const [label, apply, addPath, resultPath] of [
      ["applied same PDP", "applied", "/products/shade", "/products/shade"],
      ["uncertain", "uncertain", "/products/shade", "/products/shade"],
      ["unsupported", "unsupported", "/products/shade", "/products/shade"],
      ["failed", "throws", "/products/shade", "/products/shade"],
      ["mismatched result", "applied", "/products/shade", "/products/other"],
      ["different PDP", "applied", "/products/other", "/products/shade"],
    ])
      await t.test(`${mode}: ${label}`, async () => {
        const env = setup();
        env.streams.push(
          events(
            completed("", {
              output: [
                catalogCall("apply", "apply_measurements", {
                  productPath: "/products/shade",
                }),
              ],
            }),
          ),
          events(
            completed("", {
              output: [
                catalogCall("add", "add_to_cart", { productPath: addPath }),
              ],
            }),
          ),
          events(completed("Done.")),
        );
        const executions = [];
        await env.api.generateReply(
          [],
          () => {},
          new AbortController().signal,
          async (id, name) => {
            executions.push(name);
            if (apply === "throws") throw new Error("Application failed.");
            return name === "apply_measurements"
              ? {
                  status: apply,
                  productPath: resultPath ?? "/products/shade",
                  draftUpdatedAt: "2026-09-16T10:00:00.000Z",
                  message: "Result.",
                }
              : { status: "added", message: "Added." };
          },
          mode,
        );
        assert.deepEqual(executions, ["apply_measurements"]);
        const tools = allowedTools(env.calls.requests[1].input).map(
          (tool) => tool.name,
        );
        assert.equal(
          tools.includes("add_to_cart"),
          false,
          "a measurement application never exposes a cart mutation in this reply",
        );
        {
          const denied = env.calls.requests[2].input.input.find(
            (item) =>
              item.type === "function_call_output" && item.call_id === "add",
          );
          assert.match(
            JSON.parse(denied.output).error,
            /not confirmed.*not claim.*repeat/i,
          );
        }
      });
});

test("an applied measurement can read configuration and offer next actions", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(
      events(
        completed("", {
          output: [
            catalogCall("apply", "apply_measurements", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(
        completed("", {
          output: [
            catalogCall("configuration", "get_product_configuration", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(
        completed("", {
          output: [
            questionCall({
              message: "Review ready.",
              question: "Ready to add it?",
              answers: ["Add product to cart", "Keep configuring"],
            }),
          ],
        }),
      ),
    );
    const executions = [];
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (id, name) => {
        executions.push(name);
        return name === "apply_measurements"
          ? {
              status: "applied",
              productPath: "/products/shade",
              draftUpdatedAt: "2026-09-16T10:00:00.000Z",
              message: "Applied.",
            }
          : {
              status: "unavailable",
              productPath: "/products/shade",
              configurationId: null,
              controls: [],
              measurements: null,
              message: "No supported choices.",
            };
      },
      mode,
    );
    assert.deepEqual(executions, [
      "apply_measurements",
      "get_product_configuration",
    ]);
    assert.equal(reply.questionPresentation.question, "Ready to add it?");
    assert.ok(
      !allowedTools(env.calls.requests[1].input).some(
        (tool) => tool.name === "add_to_cart",
      ),
    );
  }
});

const configId = (n) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function configuration(n, productPath = "/products/shade", available = true) {
  return {
    status: "available",
    productPath,
    configurationId: configId(n),
    controls: [
      {
        id: "c0",
        label: n === 1 ? "Fitting Option" : "Select your way of measuring",
        kind: "radio",
        options: [
          {
            id: "o0",
            label: n === 1 ? "Exact" : "Bracket to Bracket",
            selected: false,
            available,
          },
        ],
      },
    ],
    measurements: { width: 40, height: 50, unit: "cm", availableUnits: ["cm"] },
    actions: { sampleAvailable: true },
    message: "Current native options.",
  };
}
const configRead = (n, path = "/products/shade") =>
  catalogCall(`read-${n}`, "get_product_configuration", { productPath: path });
const configWrite = (n, path = "/products/shade") =>
  catalogCall(`choice-${n}`, "configure_product", {
    productPath: path,
    configurationId: configId(n),
    controlId: "c0",
    optionId: "o0",
  });

test("text and voice can apply Exact then newly exposed Bracket to Bracket, enter unchanged measurements and offer next steps", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    const draft = {
      productPath: "/products/shade",
      width: 40,
      height: 50,
      unit: "cm",
      kind: "order",
      mount: "exact",
    };
    const steps = [
      configRead(1),
      configWrite(1),
      configRead(2),
      configWrite(2),
      configRead(3),
      catalogCall("save", "set_measurements", draft),
      catalogCall("apply", "apply_measurements", {
        productPath: draft.productPath,
      }),
      configRead(4),
      questionCall({
        message:
          "Exact and Bracket to Bracket are selected, with 40 cm width and 50 cm drop.",
        question: "What would you like to do next?",
        answers: ["Keep configuring", "Add product to cart", "Add a sample"],
      }),
    ];
    env.streams.push(
      ...steps.map((call) => events(completed("", { output: [call] }))),
    );
    const executed = [];
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (id, name, args) => {
        executed.push({ id, name, args });
        if (name === "get_product_configuration")
          return configuration(Number(id.split("-")[1]));
        if (name === "set_measurements")
          return {
            status: "saved",
            draft: { ...draft, updatedAt: "2026-09-17T10:00:00.000Z" },
          };
        return {
          status: "applied",
          productPath: draft.productPath,
          message: "Applied.",
          ...(name === "apply_measurements"
            ? { draftUpdatedAt: "2026-09-17T10:00:00.000Z" }
            : {}),
        };
      },
      mode,
    );
    assert.equal(executed.length, 8);
    assert.deepEqual(
      plain(executed.find(({ name }) => name === "set_measurements").args),
      draft,
    );
    assert.deepEqual(plain(reply.questionPresentation.answers), [
      "Keep configuring",
      "Add product to cart",
      "Add a sample",
    ]);
    for (const index of [2, 4, 7])
      assert.ok(
        !allowedToolNames(env.calls.requests[index].input).includes(
          "configure_product",
        ),
        "A fresh read is required after each form change",
      );
    for (const index of [2, 3, 4, 5, 6, 7, 8])
      assert.ok(
        !allowedToolNames(env.calls.requests[index].input).includes(
          "add_to_cart",
        ),
        "Cart remains separate from configuration",
      );
    assert.ok(
      !allowedToolNames(env.calls.requests[5].input).includes(
        "search_products",
      ),
      "Extra calls are reserved for configuration",
    );
  }
});

test("configuration errors or a changed product block further form changes even after a fresh read", async (t) => {
  for (const condition of [
    "unsupported",
    "uncertain",
    "cancelled",
    "throws",
    "wrong-result-product",
    "wrong-next-product",
    "unavailable-option",
    "stale-id",
    "no-fresh-read",
  ])
    await t.test(condition, async () => {
      const env = setup();
      const other =
        condition === "wrong-next-product"
          ? "/products/other"
          : "/products/shade";
      const firstWrite =
        condition === "stale-id" ? configWrite(9) : configWrite(1);
      const steps = [configRead(1), firstWrite];
      if (condition !== "no-fresh-read") steps.push(configRead(2, other));
      steps.push(
        configWrite(2, other),
        catalogCall("apply", "apply_measurements", {
          productPath: "/products/shade",
        }),
      );
      env.streams.push(
        ...steps.map((call) => events(completed("", { output: [call] }))),
        events(completed("Please check the current options.")),
      );
      const writes = [];
      await env.api.generateReply(
        [],
        () => {},
        new AbortController().signal,
        async (id, name, args) => {
          if (name === "get_product_configuration")
            return configuration(
              Number(id.split("-")[1]),
              args.productPath,
              condition !== "unavailable-option",
            );
          writes.push(name);
          if (condition === "throws") throw new Error("Disconnected.");
          return {
            status: ["unsupported", "uncertain", "cancelled"].includes(
              condition,
            )
              ? condition
              : "applied",
            productPath:
              condition === "wrong-result-product"
                ? "/products/other"
                : args.productPath,
            message: "Result.",
          };
        },
      );
      assert.deepEqual(
        writes,
        ["unavailable-option", "stale-id"].includes(condition)
          ? []
          : ["configure_product"],
      );
    });
});

test("an invalid configuration request cannot fall through to a cart write", async () => {
  for (const unavailable of [false, true]) {
    const env = setup();
    const steps = [
      configRead(1),
      configWrite(unavailable ? 1 : 9),
      catalogCall("add", "add_to_cart", { productPath: "/products/shade" }),
    ];
    env.streams.push(
      ...steps.map((call) => events(completed("", { output: [call] }))),
      events(completed("Please review the options.")),
    );
    const executed = [];
    await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (id, name) => {
        executed.push(name);
        return configuration(1, "/products/shade", !unavailable);
      },
    );
    assert.deepEqual(executed, ["get_product_configuration"]);
    assert.ok(
      !allowedToolNames(env.calls.requests[2].input).includes("add_to_cart"),
    );
  }
});

test("configuration cap allows three choices and one measurement application, then still permits final read and question", async () => {
  const env = setup();
  const steps = [
    configRead(1),
    configWrite(1),
    configRead(2),
    configWrite(2),
    configRead(3),
    configWrite(3),
    configRead(4),
    catalogCall("apply", "apply_measurements", {
      productPath: "/products/shade",
    }),
    configRead(5),
    configWrite(5),
    catalogCall("repeat-apply", "apply_measurements", {
      productPath: "/products/shade",
    }),
    configRead(6),
    questionCall({
      message: "Review the current choices.",
      question: "What next?",
      answers: ["Keep configuring", "Review for basket"],
    }),
  ];
  env.streams.push(
    ...steps.map((call) => events(completed("", { output: [call] }))),
  );
  const writes = [];
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (id, name, args) => {
      if (name === "get_product_configuration")
        return configuration(Number(id.split("-")[1]));
      writes.push(name);
      return {
        status: "applied",
        productPath: args.productPath,
        message: "Applied.",
      };
    },
  );
  assert.deepEqual(writes, [
    "configure_product",
    "configure_product",
    "configure_product",
    "apply_measurements",
  ]);
  assert.equal(reply.questionPresentation.question, "What next?");
  assert.deepEqual(allowedToolNames(env.calls.requests[12].input), [
    "ask_question",
    "ask_measurement",
  ]);
});

test("an explicit add request can verify and add in text or voice without a prior conversational review", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(
      events(
        completed("", {
          output: [
            catalogCall("fresh-configuration", "get_product_configuration", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(
        completed("", {
          output: [
            catalogCall("add", "add_to_cart", {
              productPath: "/products/shade",
            }),
          ],
        }),
      ),
      events(completed("Added.")),
    );
    const executions = [];
    await env.api.generateReply(
      [{ role: "user", text: "Add product to cart" }],
      () => {},
      new AbortController().signal,
      async (id, name) => {
        executions.push(name);
        return name === "get_product_configuration"
          ? {
              status: "available",
              productPath: "/products/shade",
              configurationId: "1c2a3b4d-5e6f-4789-8abc-9def01234567",
              controls: [],
              measurements: {
                unit: "mm",
                width: 500,
                height: 500,
                availableUnits: ["mm"],
              },
              configuredPrice: "£45.00",
              message: "Current configuration.",
            }
          : { status: "added", message: "Added." };
      },
      mode,
    );
    assert.deepEqual(executions, ["get_product_configuration", "add_to_cart"]);
    assert.ok(
      allowedTools(env.calls.requests[1].input).some(
        (tool) => tool.name === "add_to_cart",
      ),
    );
  }
});

test("text and voice measurement tools execute on the server while cart reads use the browser", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    const draft = {
      productPath: "/products/shade",
      width: 300,
      height: 400,
      unit: "mm",
      kind: "window",
      mount: "recess",
      updatedAt: "2026-09-15T10:00:00.000Z",
    };
    const measurementCalls = [];
    env.mock.measurementTool = async (...args) => {
      measurementCalls.push(args);
      return { status: "saved", draft };
    };
    env.mock.executeTool = async () => ({
      currency: "GBP",
      itemCount: 0,
      totalPriceMinorUnits: 0,
      items: [],
    });
    const input = { ...draft };
    delete input.updatedAt;
    env.streams.push(
      events(
        completed("", {
          output: [catalogCall("measure", "set_measurements", input)],
        }),
      ),
      events(completed("", { output: [catalogCall("cart", "get_cart", {})] })),
      events(
        completed(
          "The dimensions are saved as a window draft. The cart is empty.",
        ),
      ),
    );
    if (mode === "voice") {
      voiceHistory(env, [
        { role: "user", text: "Save these measurements and read my cart." },
      ]);
      await env.api.runVoiceDelegation(
        "one",
        VOICE_ID,
        firstInput.requestId,
        new AbortController().signal,
      );
    } else {
      await env.api.startTurn("one", firstInput);
      await flush();
      await flush();
    }
    assert.equal(measurementCalls.length, 1);
    assert.equal(measurementCalls[0][0], "one");
    assert.equal(measurementCalls[0][3], "set_measurements");
    assert.deepEqual(plain(measurementCalls[0][4]), input);
    assert.equal(env.calls.browserTools.length, 1);
    assert.equal(env.calls.browserTools[0][3], "get_cart");
    assert.equal(env.calls.finishes[0].result.status, "complete");
  }
});

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
    ["call-1", "search_products", { queries: ["no drill"] }],
  ]);
  for (const { input } of env.calls.requests) {
    assert.equal(input.service_tier, "fast");
    assert.deepEqual(input.reasoning, { effort: "medium" });
    assert.deepEqual(input.include, ["reasoning.encrypted_content"]);
    assert.equal(input.store, false);
    assert.equal(input.parallel_tool_calls, false);
    assert.deepEqual(
      allowedTools(input).map(({ name }) => name),
      [
        "search_products",
        "get_product",
        "lookup_catalog",
        "navigate",
        "show_view",
        "open_checkout",
        "get_product_guides",
        "get_store_support",
        "set_measurements",
        "get_measurements",
        "get_cart",
        "add_to_cart",
        "add_sample_to_cart",
        "remove_from_cart",
        "set_cart_quantity",
        "clear_cart",
        "get_product_configuration",
        "apply_measurements",
          "ask_question",
        "ask_measurement",
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
      allowedTools(env.calls.requests[4].input).map((tool) => tool.name),
      ["ask_question", "ask_measurement"],
    );
    assert.equal(env.calls.requests[4].input.tool_choice.type, "allowed_tools");
    assert.equal(env.calls.requests[4].input.tool_choice.mode, "required");
    assert.ok(
      env.calls.requests.every(
        ({ input }) =>
          JSON.stringify(input.tools) ===
          JSON.stringify(env.calls.requests[0].input.tools),
      ),
    );
  }
});

test("invalid or failed catalog calls return a safe error to the model without fabricated products", async () => {
  for (const call of [
    catalogCall("call-1", "checkout", {}),
    catalogCall("call-1", "search_products", "not JSON"),
    catalogCall("call-1"),
  ]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [call] })),
      events(completed("", { output: [questionCall({...questionSelection,productIds:[productGid(123)]},"invalid-selection")] })),
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
      allowedTools(env.calls.requests[1].input).some(
        (tool) => tool.name === "ask_question",
      ),
      "Failed catalog calls do not hide the carousel capability",
    );
    const selectionOutput = env.calls.requests[2].input.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "invalid-selection",
    );
    assert.match(
      JSON.parse(selectionOutput.output).error,
      /verified by successful catalogue results/,
    );
  }
});

const productGid = (id) => `gid://shopify/Product/${id}`;
const productRefs = (ids, titleForId = (id) => `Shade ${id}`) =>
  ids.map((id) => ({ id: productGid(id), title: titleForId(id) }));
const catalogResult = (...ids) => ({
  products: ids.map((id) => ({
    id: productGid(id),
    title: `Shade ${id}`,
    description: "",
    url: `https://hd-dev-single.myshopify.com/products/shade-${id}`,
  })),
  messages: [],
});
const guidePath = "/products/shade-123";
const guideResult = (kinds = ["measuring", "fitting"]) => ({
  status: kinds.length ? "found" : "unavailable",
  productPath: guidePath,
  guides: kinds.map((kind) => ({
    kind,
    url: `${guideOrigin}/cdn/shop/files/${kind}.pdf?v=123`,
  })),
});
const guideLookup = (
  callId = "guides-lookup",
  kinds = ["measuring", "fitting"],
) =>
  catalogCall(callId, "get_product_guides", { productPath: guidePath, kinds });
const guideSession = (kinds = ["measuring", "fitting"]) => ({
  origin: guideOrigin,
  productPath: guidePath,
  pageId: "22222222-2222-4222-8222-222222222222",
  sourceAssistantId: "33333333-3333-4333-8333-333333333333",
  sourceCallId: "previous-read",
  expiresAt: Date.now() + 60_000,
  kinds,
  sources: guideResult(kinds).guides,
  files: kinds.map(syntheticGuideFile),
});

const questionSelection = {
  question: "Which matters most?",
  answers: ["Blackout", "Daytime privacy"],
};
const questionCall = (args = questionSelection, callId = "question-1") =>
  catalogCall(
    callId,
    "ask_question",
    typeof args === "string" ? args : { message: "", ...args },
  );

const measurementSelection = {
  question: "What is the width?",
  instructions:
    "Measure wall to wall at the top of the recess without deductions.",
  productPath: guidePath,
  label: "Width",
  unit: "mm",
};
const measurementCall = (
  args = measurementSelection,
  callId = "measurement-1",
) =>
  catalogCall(
    callId,
    "ask_measurement",
    typeof args === "string" ? args : { message: "", ...args },
  );

function libraryContext() {
  const source = {
    sourceCallId: "library-discovery",
    sourceAssistantId: "33333333-3333-4333-8333-333333333333",
    library: "blinds",
    pagePath: "/pages/measuring-blinds",
    expiresAt: Date.now() + 60_000,
    guideIds: [],
  };
  const section = "s_" + "a".repeat(24);
  const result = {
    library: "blinds",
    pagePath: source.pagePath,
    title: "Measuring blinds",
    sections: [
      {
        id: section,
        title: "Bay windows",
        text: "FULL_LIBRARY_SECTIONS_NOT_REPEATED_IN_ROUTINE_CONTEXT",
      },
    ],
    guides: ["a", "b", "c"].map((letter) => ({
      id: "g_" + letter.repeat(24),
      title: "Guide " + letter,
      section,
      url: guideOrigin + "/cdn/shop/files/bay-" + letter + ".pdf?v=1",
    })),
    diagramNotice:
      "Diagrams and videos were not interpreted; do not infer instructions that depend on them.",
  };
  const inventory = {
    discoveryId: "44444444-4444-4444-8444-444444444444",
    library: source.library,
    pagePath: source.pagePath,
    title: result.title,
    guides: result.guides.map(({ id, title, section }) => ({
      id,
      title,
      section,
    })),
    source,
  };
  const reads = [],
    discoveries = [],
    bindings = [];
  const bind = async (receipt, productPath = guidePath) => {
    bindings.push({ receipt, productPath });
    return {
      source: receipt,
      productPath,
      pageId: "22222222-2222-4222-8222-222222222222",
    };
  };
  const reuse = {
    inventory: [],
    recall: () => undefined,
    discover: (callId, discovery) => {
      discoveries.push({ callId, discovery });
      return inventory;
    },
    read: async (call, signal) => {
      signal.throwIfAborted();
      reads.push(plain(call));
      assert.equal(call.discoveryId, inventory.discoveryId);
      const guides = call.guideIds.map((id) => {
        const guide = result.guides.find((guide) => guide.id === id);
        assert.ok(guide, "Only discovered IDs can reach the library reader");
        return guide;
      });
      const files = guides.map(({ id }) => syntheticGuideFile(id));
      return {
        status: "ready",
        guides,
        files,
        source: { ...source, guideIds: [...call.guideIds] },
        input: files.map((file) => ({
          role: "user",
          content: [
            { type: "input_text", text: "Selected original library reference" },
            { ...file, prompt_cache_breakpoint: { mode: "explicit" } },
          ],
        })),
      };
    },
    bind,
  };
  return { result, source, inventory, reuse, reads, discoveries, bindings };
}

test("newly authored Finish for now choices are rejected and leave the original capabilities", async () => {
  for (const answer of [
    "Finish for now",
    "  FINISH   FOR NOW!  ",
    "Finish for now.",
  ]) {
    const env = setup();
    env.streams.push(
      events(
        completed("", {
          output: [questionCall({ question: "What next?", answers: [answer] })],
        }),
      ),
      events(completed("I'm here to help with your next window.")),
    );
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
    );
    assertNextActions(reply);
    const outcome = env.calls.requests[1].input.input.find(
      (item) => item.type === "function_call_output",
    );
    assert.match(
      JSON.parse(outcome.output).error,
      /never a Finish for now choice/,
    );
    assert.equal(env.calls.browserTools.length, 0);
    assert.ok(
      !allowedToolNames(env.calls.requests[0].input).includes("finish_for_now"),
    );
  }
});

test("a customer stop acknowledgment retains passive capabilities without closing or taking action", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    const acknowledgment = "Of course. I'm here whenever you're ready.";
    env.streams.push(events(completed(acknowledgment)));
    const reply = await env.api.generateReply(
      [{ role: "user", text: "Finish for now" }],
      () => {},
      new AbortController().signal,
      () => assert.fail("Stopping is not a storefront action"),
      mode,
    );
    assertNextActions(reply);
    assert.equal(env.calls.requests.length, 1);
    assert.deepEqual(env.calls.ends, []);
    assert.equal(
      reply.text,
      mode === "voice"
        ? acknowledgment + " " + nextActionQuestion
        : acknowledgment,
    );
  }
});

test("cached library authority supports the next numeric step without reattaching PDFs or a read round", async () => {
  const env = setup();
  const library = libraryContext();
  const source = { ...library.source, guideIds: [library.result.guides[0].id] };
  library.reuse.inventory = [{ ...library.inventory, source }];
  library.reuse.bound = await library.reuse.bind(source);
  env.streams.push(events(completed("", { output: [measurementCall()] })));
  const reply = await env.api.generateReply(
    [
      {
        role: "assistant",
        text: "The established guide method is wall to wall at the top, without deductions.",
      },
    ],
    () => {},
    new AbortController().signal,
    () => assert.fail("Routine grounded reading needs no browser lookup"),
    "text",
    undefined,
    guideOrigin,
    undefined,
    undefined,
    undefined,
    library.reuse,
  );
  assert.equal(env.calls.requests.length, 1);
  assert.deepEqual(guideFiles(env.calls.requests[0].input), []);
  assert.deepEqual(library.reads, []);
  assert.deepEqual(library.discoveries, []);
  const request = JSON.stringify(env.calls.requests[0].input.input);
  assert.match(
    request,
    /guideIds.*discoveryId/,
  );
  assert.doesNotMatch(request, /FULL_LIBRARY_SECTIONS|file_data/);
  assert.equal(reply.questionPresentation.measurement.label, "Width");
  assert.deepEqual(
    plain(reply.questionPresentation.librarySource.source.guideIds),
    source.guideIds,
  );
});

test("failed PDP rereading drops old PDFs then discovers and attaches only the selected library originals", async () => {
  const env = setup();
  const library = libraryContext();
  const selected = library.result.guides.slice(0, 2).map(({ id }) => id);
  let reads = 0;
  env.mock.readGuides = async (result) =>
    ++reads === 1
      ? {
          status: "ready",
          sources: result.guides,
          files: result.guides.map(({ kind }) => syntheticGuideFile(kind)),
        }
      : { status: "unavailable", reason: "not_found" };
  env.streams.push(
    events(
      completed("", { output: [guideLookup("first-pdp", ["measuring"])] }),
    ),
    events(
      completed("", { output: [guideLookup("failed-pdp", ["measuring"])] }),
    ),
    events(
      completed("", {
        output: [
          catalogCall("library-discovery", "discover_guides", {
            library: "blinds",
          }),
        ],
      }),
    ),
    events(
      completed("", {
        output: [
          catalogCall("selected-library-pdfs", "read_library_guides", {
            discoveryId: library.inventory.discoveryId,
            guideIds: selected,
            refresh: false,
          }),
        ],
      }),
    ),
    events(completed("", { output: [measurementCall()] })),
  );
  const dispatched = [];
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (id, name, args) => {
      dispatched.push({ id, name, args });
      return name === "discover_guides"
        ? library.result
        : guideResult(["measuring"]);
    },
    "text",
    undefined,
    guideOrigin,
    undefined,
    undefined,
    undefined,
    library.reuse,
  );
  assert.deepEqual(
    dispatched.map(({ name }) => name),
    ["get_product_guides", "get_product_guides", "discover_guides"],
  );
  assert.equal(guideFiles(env.calls.requests[1].input).length, 1);
  assert.deepEqual(guideFiles(env.calls.requests[2].input), []);
  assert.deepEqual(
    guideFiles(env.calls.requests[3].input),
    [],
    "Discovery must not eagerly attach PDFs",
  );
  assert.deepEqual(library.reads, [
    {
      discoveryId: library.inventory.discoveryId,
      guideIds: selected,
      refresh: false,
    },
  ]);
  assert.deepEqual(
    guideFiles(env.calls.requests[4].input).map(({ filename }) => filename),
    selected.map((id) => id + "-guide.pdf"),
  );
  assert.equal(env.calls.requests.length, 5);
  assert.deepEqual(
    plain(reply.questionPresentation.librarySource.source.guideIds),
    selected,
  );
  assert.equal(reply.cachedGuideSource, undefined);
});

test("validated text and voice measurement inputs finish immediately with guide provenance and no writes", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [guideLookup()] })),
      events(completed("", { output: [measurementCall()] })),
    );
    const dispatched = [];
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (...args) => {
        dispatched.push(args);
        return guideResult();
      },
      mode,
      undefined,
      guideOrigin,
    );
    const { question, ...measurement } = measurementSelection;
    assert.deepEqual(plain(reply.questionPresentation), {
      callId: "measurement-1",
      sourceCallId: "guides-lookup",
      question,
      answers: [],
      measurement,
    });
    assert.deepEqual(
      dispatched.map((call) => call[1]),
      ["get_product_guides"],
    );
    assert.equal(
      reply.text,
      mode === "voice"
        ? `${measurementSelection.instructions} ${measurementSelection.question}`
        : "",
    );
    assert.equal(env.calls.guideReads.length, 1);
    assert.equal(env.calls.requests.length, 2);
    assert.equal(env.streams.length, 0);
  }
});

test("a routine measuring reply retains prior-read authority without attaching PDFs or adding a lookup round", async () => {
  const env = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  const pageId = "22222222-2222-4222-8222-222222222222";
  let count = 0;
  env.mock.assistantId = () =>
    `33333333-3333-4333-8333-${String(++count).padStart(12, "0")}`;
  env.rows.set(id, {
    status: "active",
    revision: 0,
    tools: [],
    messages: [
      {
        id: pageId,
        role: "context",
        status: "complete",
        text: "",
        extraParts: [
          {
            type: "page_view",
            version: 1,
            path: guidePath,
            title: "Shade",
            occurredAt: "2026-09-17T10:00:00Z",
          },
        ],
      },
    ],
  });
  env.mock.executeTool = async () => guideResult();
  env.streams.push(
    events(
      completed("", { output: [guideLookup("original-read", ["measuring"])] }),
    ),
    events(completed("", { output: [measurementCall()] })),
  );
  await env.api.startTurn(id, { ...firstInput, text: "Help me measure in mm" });
  await flush();
  assert.equal(env.calls.finishes.length, 1);
  assert.deepEqual(env.logs, []);
  const firstDocumentRequest = env.calls.requests[1].input;
  const nextReading = deferred();
  env.streams.push(
    (async function* () {
      yield await nextReading.promise;
    })(),
  );
  await env.api.startTurn(id, { ...secondInput, text: "400" });
  await flush();
  const pending = await env.api.readConversation(id);
  assert.equal(pending.busy, true);
  assert.equal(
    pending.readingGuides,
    undefined,
    "Reusing original files is not another guide read",
  );
  nextReading.resolve(
    completed("", {
      output: [
        measurementCall(
          {
            ...measurementSelection,
            label: "Drop",
            question: "What is the drop?",
          },
          "next-reading",
        ),
      ],
    }),
  );
  await flush();
  assert.deepEqual(env.logs, []);
  assert.equal(
    env.calls.requests.length,
    3,
    "follow-up uses one provider request, no guide-discovery request",
  );
  assert.equal(env.calls.browserTools.length, 1);
  assert.equal(env.calls.guideReads.length, 1);
  const continued = env.calls.requests[2].input;
  assert.deepEqual(guideFiles(continued), []);
  assert.equal(guideFiles(firstDocumentRequest).length, 1);
  assert.match(
    JSON.stringify(continued.input),
    /priorProductRead/,
  );
  assert.doesNotMatch(JSON.stringify(continued.input), /file_data/);
  assert.equal(
    continued.prompt_cache_key,
    firstDocumentRequest.prompt_cache_key,
  );
  assert.equal(
    env.calls.finishes[1].result.questionPresentation.sourceCallId,
    "original-read",
  );
  assert.equal(
    env.calls.finishes[1].result.cachedGuideSource.sourceAssistantId,
    env.calls.finishes[0].assistantId,
  );
  assert.deepEqual(
    [...env.calls.finishes[1].result.cachedGuideSource.kinds],
    ["measuring"],
  );

  env.rows.get(id).messages.push({
    id: "44444444-4444-4444-8444-444444444444",
    role: "context",
    status: "complete",
    text: "",
    extraParts: [
      {
        type: "page_view",
        version: 1,
        path: "/products/another-blind",
        title: "Other",
        occurredAt: "2026-09-17T10:01:00Z",
      },
    ],
  });
  env.streams.push(events(completed("Please choose the relevant guide.")));
  await env.api.startTurn(id, {
    requestId: "55555555-5555-4555-8555-555555555555",
    text: "Help me with this product",
  });
  await flush();
  assert.equal(
    guideFiles(env.calls.requests[3].input).length,
    0,
    "changed product cannot inherit guide evidence",
  );
  assert.equal(env.calls.finishes[2].result.cachedGuideSource, undefined);
});

test("prior-read authority supports voice numeric resume without PDFs, rediscovery or another model round", async () => {
  const env = setup();
  const activities = [];
  const { question, ...measurement } = measurementSelection;
  const resume = {
    type: "question",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    question,
    answers: [],
    measurement,
  };
  const cached = {
    origin: guideOrigin,
    productPath: guidePath,
    pageId: "22222222-2222-4222-8222-222222222222",
    sourceAssistantId: "33333333-3333-4333-8333-333333333333",
    sourceCallId: "previous-read",
    expiresAt: Date.now() + 60_000,
    kinds: ["measuring"],
    sources: guideResult(["measuring"]).guides,
    files: [syntheticGuideFile("measuring")],
  };
  env.streams.push(events(completed("", { output: [measurementCall()] })));
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => {
      throw Error("Cached resume must not call storefront");
    },
    "voice",
    undefined,
    guideOrigin,
    resume,
    (kinds) => activities.push(kinds),
    {
      cached,
      read: () => {
        throw Error("No new PDF read expected");
      },
      clear: () => {
        throw Error("No navigation expected");
      },
    },
  );
  assert.equal(env.calls.requests.length, 1);
  assert.equal(env.calls.guideReads.length, 0);
  assert.ok(activities.every((kinds) => kinds === undefined));
  assert.equal(guideFiles(env.calls.requests[0].input).length, 0);
  assert.equal(reply.questionPresentation.sourceCallId, "previous-read");
  assert.equal(
    reply.cachedGuideSource.sourceAssistantId,
    cached.sourceAssistantId,
  );
});

test("an established measuring method accepts unknown units and empty instructions without another guide or unit-selection turn", async () => {
  for (const mode of ["text", "voice", "resume"]) {
    const env = setup();
    const selection = { ...measurementSelection, unit: null, instructions: "" };
    const { question, ...measurement } = selection;
    const resume =
      mode === "resume"
        ? {
            type: "question",
            version: 1,
            invocationId: "11111111-1111-4111-8111-111111111111",
            question,
            answers: [],
            measurement,
          }
        : undefined;
    env.streams.push(
      events(completed("", { output: [measurementCall(selection)] })),
    );
    const reply = await env.api.generateReply(
      [
        {
          role: "user",
          text: "I'm ready to measure the width as you described.",
        },
      ],
      () => {},
      new AbortController().signal,
      async () => {
        throw Error("No new storefront read needed");
      },
      mode === "text" ? "text" : "voice",
      undefined,
      guideOrigin,
      resume,
      undefined,
      {
        cached: guideSession(["measuring"]),
        read: () => {
          throw Error("No new PDF read needed");
        },
        clear: () => {
          throw Error("No product change expected");
        },
      },
    );
    assert.equal(env.calls.requests.length, 1);
    assert.equal(env.calls.guideReads.length, 0);
    assert.equal(guideFiles(env.calls.requests[0].input).length, 0);
    assert.deepEqual(
      plain(reply.questionPresentation.measurement),
      measurement,
    );
    assert.equal(reply.text, mode === "text" ? "" : question);
    if (resume)
      assert.ok(env.calls.requests[0].input.input.some(({content}) =>
        typeof content === "string" && content.includes('"unit":null')));
  }
});

test("cached original PDFs stay off the request during pending style and cart replies", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const request of [
      "Help me choose another colour.",
      "What is in my basket?",
    ]) {
      await t.test(`${mode}: ${request}`, async () => {
        const env = setup(),
          id = "11111111-1111-4111-8111-111111111111",
          pageId = "22222222-2222-4222-8222-222222222222",
          sourceAssistantId = "33333333-3333-4333-8333-333333333333";
        env.rows.set(id, {
          status: "active",
          revision: 0,
          tools: [],
          messages: [
            {
              id: pageId,
              role: "context",
              status: "complete",
              text: "",
              extraParts: [
                {
                  type: "page_view",
                  version: 1,
                  path: guidePath,
                  title: "Shade",
                  occurredAt: "2026-09-17T10:00:00Z",
                },
              ],
            },
          ],
        });
        env.api.saveGuideSession(id, {
          origin: guideOrigin,
          pageId,
          productPath: guidePath,
          sourceAssistantId,
          sourceCallId: "original-read",
          expiresAt: Date.now() + 60_000,
          kinds: ["measuring"],
          sources: guideResult(["measuring"]).guides,
          files: [syntheticGuideFile("measuring")],
        });
        const gate = deferred();
        env.streams.push(
          (async function* () {
            yield await gate.promise;
          })(),
        );
        let reply;
        if (mode === "voice") {
          voiceHistory(env, [{ role: "user", text: request }]);
          reply = env.api.runVoiceDelegation(
            id,
            VOICE_ID,
            firstInput.requestId,
            new AbortController().signal,
          );
        } else {
          await env.api.startTurn(id, { ...firstInput, text: request });
        }
        await flush();
        const snapshot = await env.api.readConversation(id);
        assert.equal(snapshot.busy, true);
        assert.equal(snapshot.readingGuides, undefined);
        assert.equal(env.calls.requests.length, 1);
        assert.deepEqual(guideFiles(env.calls.requests[0].input), []);
        assert.match(
          JSON.stringify(env.calls.requests[0].input.input),
          /priorProductRead/,
        );
        assert.doesNotMatch(
          JSON.stringify(env.calls.requests[0].input.input),
          /file_data/,
        );
        assert.equal(env.calls.browserTools.length, 0);
        assert.equal(env.calls.guideReads.length, 0);
        const unchanged = await env.api.readConversation(id, {
          revision: snapshot.revision,
          streamRevision: snapshot.streamRevision,
        });
        assert.equal(unchanged.unchanged, true);
        gate.resolve(completed("Let's continue with your request."));
        await reply;
        await flush();
        assert.equal(
          env.calls.finishes[0].result.cachedGuideSource.sourceCallId,
          "original-read",
        );
        assert.equal(
          env.calls.finishes[0].result.cachedGuideSource.sourceAssistantId,
          sourceAssistantId,
        );
        assert.equal(
          (await env.api.readConversation(id)).readingGuides,
          undefined,
        );
        assert.deepEqual(env.logs, []);
      });
    }
  }
});

test("explicit cached reads attach only requested originals, retain their union and keep the prior source receipt", async () => {
  const env = setup(),
    cached = guideSession(),
    activities = [];
  const original = structuredClone(cached);
  env.streams.push(
    events(
      completed("", { output: [guideLookup("read-measuring", ["measuring"])] }),
    ),
    events(
      completed("", { output: [guideLookup("read-fitting", ["fitting"])] }),
    ),
    events(completed("", { output: [measurementCall()] })),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => {
      throw Error("A matching cached read must not dispatch to the storefront");
    },
    "text",
    undefined,
    guideOrigin,
    undefined,
    (kinds) => activities.push(kinds),
    {
      cached,
      read: () => {
        throw Error("Cache hits must not invent a new durable source");
      },
      clear: () => {},
    },
  );
  assert.deepEqual(guideFiles(env.calls.requests[0].input), []);
  assert.deepEqual(guideFiles(env.calls.requests[1].input), [
    cachedGuideFile("measuring"),
  ]);
  assert.deepEqual(guideFiles(env.calls.requests[2].input), [
    cachedGuideFile("measuring"),
    cachedGuideFile("fitting"),
  ]);
  assert.equal(env.calls.guideReads.length, 0);
  assert.equal(reply.questionPresentation.sourceCallId, cached.sourceCallId);
  assert.equal(
    reply.cachedGuideSource.sourceAssistantId,
    cached.sourceAssistantId,
  );
  assert.deepEqual(cached, original);
  assert.ok(activities.some((value) => value?.includes("measuring")));
  assert.ok(activities.some((value) => value?.includes("fitting")));
  assert.equal(activities.at(-1), undefined);
});

test("missing cached kinds and explicit refresh use fresh discovery while attaching only requested files", async (t) => {
  for (const refresh of [false, true])
    await t.test(
      refresh ? "explicit refresh" : "missing companion",
      async () => {
        const env = setup(),
          cached = guideSession(["measuring"]),
          reads = [],
          dispatched = [];
        const kinds = refresh ? ["measuring"] : ["fitting"];
        env.streams.push(
          events(
            completed("", {
              output: [
                catalogCall("fresh-read", "get_product_guides", {
                  productPath: guidePath,
                  kinds,
                  refresh,
                }),
              ],
            }),
          ),
          events(completed("The requested detail is in this guide.")),
        );
        await env.api.generateReply(
          [],
          () => {},
          new AbortController().signal,
          async (...args) => {
            dispatched.push(args);
            return guideResult();
          },
          "text",
          undefined,
          guideOrigin,
          undefined,
          undefined,
          { cached, read: (value) => reads.push(value), clear: () => {} },
        );
        assert.deepEqual(plain(dispatched), [
          ["fresh-read", "get_product_guides", { productPath: guidePath }],
        ]);
        assert.equal(env.calls.guideReads.length, 1);
        assert.deepEqual(plain(env.calls.guideReads[0][3]), { refresh });
        assert.deepEqual(guideFiles(env.calls.requests[0].input), []);
        assert.deepEqual(
          guideFiles(env.calls.requests[1].input),
          kinds.map(cachedGuideFile),
        );
        assert.equal(reads[0].sourceCallId, "fresh-read");
        assert.deepEqual(
          plain(reads[0].sources.map(({ kind }) => kind).sort()),
          refresh ? ["measuring"] : ["fitting", "measuring"],
        );
        assert.equal(reads[0].files.length, refresh ? 1 : 2);
      },
    );
});

test("a fresh companion read never retains a replaced cached source binding", async () => {
  const env = setup(),
    cached = guideSession(["measuring"]),
    reads = [];
  const found = guideResult();
  found.guides[0].url = found.guides[0].url.replace("v=123", "v=124");
  env.streams.push(
    events(
      completed("", { output: [guideLookup("fresh-fitting", ["fitting"])] }),
    ),
    events(completed("Here is the fitting detail.")),
  );
  await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => found,
    "text",
    undefined,
    guideOrigin,
    undefined,
    undefined,
    { cached, read: (value) => reads.push(value), clear: () => {} },
  );
  assert.deepEqual(plain(reads[0].sources.map(({ kind }) => kind)), [
    "fitting",
  ]);
  assert.deepEqual(guideFiles(env.calls.requests[1].input), [
    cachedGuideFile("fitting"),
  ]);
});

test("navigation invalidates both cached authority and lazy PDF reuse before returning to the product", async () => {
  const env = setup(),
    dispatched = [],
    cached = guideSession(["measuring"]);
  let cleared = 0;
  env.streams.push(
    events(
      completed("", {
        output: [
          catalogCall("leave", "navigate", { path: "/collections/all" }),
        ],
      }),
    ),
    events(
      completed("", {
        output: [catalogCall("return", "navigate", { path: guidePath })],
      }),
    ),
    events(
      completed("", {
        output: [guideLookup("fresh-after-return", ["measuring"])],
      }),
    ),
    events(completed("", { output: [measurementCall()] })),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      dispatched.push(args);
      return args[1] === "navigate"
        ? { status: "navigated", path: args[2].path, title: "Page" }
        : guideResult();
    },
    "text",
    undefined,
    guideOrigin,
    undefined,
    undefined,
    {
      cached,
      read: () => {},
      clear: () => {
        cleared++;
      },
    },
  );
  assert.equal(cleared, 2);
  assert.deepEqual(
    dispatched.map((call) => call[1]),
    ["navigate", "navigate", "get_product_guides"],
  );
  assert.equal(env.calls.guideReads.length, 1);
  assert.equal(reply.cachedGuideSource, undefined);
  assert.equal(reply.questionPresentation.sourceCallId, "fresh-after-return");
  assert.ok(
    env.calls.requests
      .slice(1, 3)
      .every(
        ({ input }) =>
          !JSON.stringify(input.input).includes(
            "Verified prior-read guide inventory",
          ),
      ),
  );
});

test("fresh guide reading clears on the first answer text before the turn finishes, including private voice briefings", async (t) => {
  for (const mode of ["text", "voice"]) {
    await t.test(mode, async () => {
      const env = setup(),
        firstText = deferred(),
        terminal = deferred();
      env.mock.executeTool = async () => guideResult(["measuring"]);
      env.streams.push(
        events(
          completed("", { output: [guideLookup("fresh-read", ["measuring"])] }),
        ),
        (async function* () {
          yield await firstText.promise;
          yield await terminal.promise;
        })(),
      );
      let reply;
      if (mode === "voice") {
        voiceHistory(env, [
          { role: "user", text: "Read this measuring guide." },
        ]);
        reply = env.api.runVoiceDelegation(
          mode,
          VOICE_ID,
          firstInput.requestId,
          new AbortController().signal,
        );
      } else await env.api.startTurn(mode, firstInput);
      await flush();
      const reading = await env.api.readConversation(mode);
      assert.equal(reading.busy, true);
      assert.deepEqual(plain(reading.readingGuides), ["measuring"]);
      assert.equal(env.calls.guideReads.length, 1);
      firstText.resolve({
        type: "response.output_text.delta",
        delta: "The document is available.",
      });
      await flush();
      const answering = await env.api.readConversation(mode, {
        revision: reading.revision,
        streamRevision: reading.streamRevision,
      });
      assert.notEqual(
        answering.unchanged,
        true,
        "Clearing reading status advances the polling revision",
      );
      assert.equal(answering.busy, true);
      assert.equal(answering.readingGuides, undefined);
      assert.ok(answering.streamRevision > reading.streamRevision);
      if (mode === "voice")
        assert.doesNotMatch(
          JSON.stringify(answering.messages),
          /The document is available/,
        );
      terminal.resolve(completed("The document is available."));
      await reply;
      await flush();
      assert.equal(
        (await env.api.readConversation(mode)).readingGuides,
        undefined,
      );
      assert.equal(env.calls.requests.length, 2);
      assert.deepEqual(guideFiles(env.calls.requests[1].input), [
        cachedGuideFile("measuring"),
      ]);
    });
  }
});

test("ending or leaving and returning during guide completion cannot populate a reusable source", async (t) => {
  for (const change of ["end", "leave-return"])
    await t.test(change, async () => {
      const env = setup();
      const id = "11111111-1111-4111-8111-111111111111";
      const pageId = "22222222-2222-4222-8222-222222222222";
      const returnedId = "44444444-4444-4444-8444-444444444444";
      env.mock.assistantId = () => "33333333-3333-4333-8333-333333333333";
      const page = (id, path) => ({
        id,
        role: "context",
        status: "complete",
        text: "",
        extraParts: [
          {
            type: "page_view",
            version: 1,
            path,
            title: "Synthetic page",
            occurredAt: "2026-09-17T10:00:00Z",
          },
        ],
      });
      env.rows.set(id, {
        status: "active",
        revision: 0,
        tools: [],
        messages: [page(pageId, guidePath)],
      });
      env.mock.executeTool = async () => guideResult();
      const gate = deferred();
      if (change === "end")
        env.mock.snapshot = async (id) => {
          const value = env.snapshot(id);
          await gate.promise;
          return value;
        };
      else
        env.mock.afterFinish = () =>
          env.rows
            .get(id)
            .messages.push(
              page("55555555-5555-4555-8555-555555555555", "/cart"),
              page(returnedId, guidePath),
            );
      env.streams.push(
        events(
          completed("", { output: [guideLookup("source", ["measuring"])] }),
        ),
        events(completed("Guide checked.")),
      );
      await env.api.startTurn(id, firstInput);
      await flush();
      assert.equal(env.calls.finishes.length, 1);
      if (change === "end") {
        await env.api.endTurn(id);
        gate.resolve();
        await flush();
      }
      assert.equal(
        env.api.readGuideSession(id, guideOrigin, {
          productPath: guidePath,
          pageId: change === "end" ? pageId : returnedId,
        }),
        undefined,
      );
      assert.deepEqual(env.logs, []);
    });
});

test("terminal numeric replies preserve selected cards, visible text and completed usage", async () => {
  const env = setup();
  const usage = [];
  const note = "Keep the selected mounting method.";
  env.streams.push(
    events(completed("", { output: [catalogCall("lookup")] })),
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", {
        output: [
          { type: "message", content: [{ type: "output_text", text: note }] },
          measurementCall({ ...measurementSelection, message: note, productIds: [productGid(123)] }),
        ],
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      }),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (callId, name) =>
      name === "get_product_guides" ? guideResult() : catalogResult(123),
    "text",
    async (value) => usage.push(plain(value)),
    guideOrigin,
  );
  assert.equal(env.calls.requests.length, 3);
  assert.equal(reply.text, note);
  assert.deepEqual(plain(reply.presentation), {
    callId: "measurement-1",
    productIds: [productGid(123)],
    productRefs: productRefs([123]),
  });
  assert.equal(
    reply.questionPresentation.measurement.instructions,
    measurementSelection.instructions,
  );
  assert.equal(usage.length, 6);
  assert.equal(usage.at(-1).status, "completed");
  assert.equal(usage.at(-1).totalTokens, 140);
  assert.ok(
    env.calls.requests.every(
      ({ input }) =>
        input.model === "gpt-6-luna" &&
        input.service_tier === "fast" &&
        input.reasoning.effort === "medium" &&
        input.store === false,
    ),
  );
});

test("terminal voice numeric replies retain the current overview and speak the exact method/question once", async () => {
  const env = setup();
  const overview = "The manufacturer's allowance remains unchanged.";
  const widthStep = {
    ...measurementSelection,
    label: "Width",
    instructions:
      "Measure horizontally from the left recess wall to the right at the top, middle and bottom. Do not make deductions.",
    question: "What is the smallest of those three width measurements?",
  };
  const method = `${widthStep.instructions} ${widthStep.question}`;
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", {
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: `${overview} ${method} ${method}` },
            ],
          },
          measurementCall({ ...widthStep, message: overview }),
        ],
      }),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "voice",
    undefined,
    guideOrigin,
  );
  assert.equal(reply.text, `${overview} ${method}`);
  assert.equal(reply.questionPresentation.measurement.instructions, widthStep.instructions);
  assert.equal(reply.questionPresentation.question, widthStep.question);
  assert.equal(env.calls.requests.length, 2);
});

test("oversized voice answer gets one structured repair without truncating critical instructions", async () => {
  const env = setup();
  const selection = {
    ...measurementSelection,
    instructions: "Measure from the labelled endpoints. ".repeat(16).trim(),
    question: "Which reading did you take? ".repeat(9).trim(),
  };
  const finalText = `${selection.instructions} ${selection.question}`;
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "A necessary explanation. ".repeat(12),
              },
            ],
          },
          measurementCall({
            ...selection,
            message: "A necessary explanation. ".repeat(12),
          }),
        ],
      }),
    ),
    events(
      completed("", { output: [measurementCall(selection, "shortened")] }),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "voice",
    undefined,
    guideOrigin,
  );
  assert.equal(reply.text, finalText);
  assert.equal(
    reply.questionPresentation.measurement.instructions,
    selection.instructions,
  );
  assert.equal(env.calls.requests.length, 3);
});

test("terminal numeric message includes a prior draft write outcome without another model round", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", {
        output: [
          catalogCall("save", "set_measurements", {
            productPath: guidePath,
            width: 500,
            height: 600,
            unit: "mm",
            kind: "window",
            mount: "unknown",
          }),
        ],
      }),
    ),
    events(
      completed("", {
        output: [
          measurementCall({
            ...measurementSelection,
            message:
              "Your window notes were saved. The remaining reading is separate.",
          }),
        ],
      }),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (callId, name) =>
      name === "get_product_guides" ? guideResult() : { status: "saved" },
    "voice",
    undefined,
    guideOrigin,
  );
  assert.equal(env.calls.requests.length, 3);
  assert.match(reply.text, /window notes were saved/);
  assert.ok(reply.questionPresentation);
});

test("a terminal measurement completion still obeys cancellation after usage is recorded", async () => {
  const env = setup();
  const controller = new AbortController();
  let completions = 0;
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(completed("", { output: [measurementCall()] })),
  );
  await assert.rejects(
    env.api.generateReply(
      [],
      () => {},
      controller.signal,
      async () => guideResult(),
      "text",
      async (value) => {
        if (value.status === "completed" && ++completions === 2)
          controller.abort(new Error("Stopped before question publication"));
      },
      guideOrigin,
    ),
    /Stopped before question publication/,
  );
  assert.equal(env.calls.requests.length, 2);
  assert.equal(completions, 2);
});

test("measurement inputs reject absent or wrong-product guide evidence and cannot bypass the gate through ask_question", async () => {
  for (const scenario of ["absent", "wrong_product", "choice_bypass"]) {
    const env = setup();
    const { question, ...measurement } = measurementSelection;
    const call =
      scenario === "choice_bypass"
        ? questionCall({ question, answers: [], measurement })
        : measurementCall(
            scenario === "wrong_product"
              ? { ...measurementSelection, productPath: "/products/another" }
              : measurementSelection,
          );
    env.streams.push(
      ...(scenario === "absent"
        ? []
        : [events(completed("", { output: [guideLookup()] }))]),
      events(completed("", { output: [call] })),
      events(completed("I cannot request that measurement yet.")),
    );
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => guideResult(),
      "text",
      undefined,
      guideOrigin,
    );
    assertNextActions(reply);
    const output = env.calls.requests
      .at(-1)
      .input.input.find(
        (item) =>
          item.call_id === call.call_id && item.type === "function_call_output",
      );
    assert.equal(typeof JSON.parse(output.output).error, "string");
  }
});

test("measurement and choice questions share one attempt budget in either order", async () => {
  for (const calls of [
    [measurementCall(), questionCall()],
    [questionCall(), measurementCall()],
  ]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [guideLookup()] })),
      events(completed("", { output: calls })),
    );
    await assert.rejects(
      env.api.generateReply(
        [],
        () => {},
        new AbortController().signal,
        async () => guideResult(),
        "text",
        undefined,
        guideOrigin,
      ),
      /concurrent tool calls/,
    );
  }
});

test("navigation retires measurement evidence until the destination product guides are read", async () => {
  const destination = "/products/another";
  for (const refreshed of [false, true]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [guideLookup()] })),
      events(
        completed("", {
          output: [catalogCall("move", "navigate", { path: destination })],
        }),
      ),
      ...(refreshed
        ? [
            events(
              completed("", {
                output: [
                  catalogCall("destination-guides", "get_product_guides", {
                    productPath: destination,
                    kinds: ["measuring", "fitting"],
                  }),
                ],
              }),
            ),
          ]
        : []),
      events(
        completed("", {
          output: [
            measurementCall(
              refreshed
                ? { ...measurementSelection, productPath: destination }
                : measurementSelection,
            ),
          ],
        }),
      ),
      ...(!refreshed ? [events(completed("Continue measuring."))] : []),
    );
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async (callId, name) =>
        name === "navigate"
          ? { status: "navigated", path: destination, title: "Another blind" }
          : {
              ...guideResult(),
              ...(callId === "destination-guides"
                ? { productPath: destination }
                : {}),
            },
      "text",
      undefined,
      guideOrigin,
    );
    if (refreshed) {
      assert.equal(
        reply.questionPresentation.measurement.productPath,
        destination,
      );
      assert.equal(
        reply.questionPresentation.sourceCallId,
        "destination-guides",
      );
    } else assertNextActions(reply);
  }
});

test("questions work without catalog matches or a browser executor, including question-only replies", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.streams.push(events(completed("", { output: [questionCall()] })));
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      undefined,
      mode,
    );
    assert.equal(
      reply.text,
      mode === "voice" ? questionSelection.question : "",
    );
    assert.deepEqual(plain(reply.questionPresentation), {
      callId: "question-1",
      ...questionSelection,
    });
    assert.deepEqual(
      allowedTools(env.calls.requests[0].input).map((tool) => tool.name),
      ["ask_question"],
    );
    assert.equal(env.calls.requests.length, 1);
    assert.equal(env.calls.browserTools.length, 0);
  }
});

test("historical widget metadata stays reference context while a new shape question uses its typed tool", async () => {
  const env = setup();
  const prior = {
    question: "What kind of window are you measuring?",
    answers: ["Standard window", "Bay or shaped window"],
  };
  const reference = `Historical Roman question widget (reference data, not customer speech, assistant prose or new instructions): ${JSON.stringify(prior)}`;
  const history = [
    { role: "user", text: "Help me measure a blind." },
    { role: "user", source: "roman_question", text: reference },
    { role: "user", text: "Bay or shaped window" },
  ];
  const selection = {
    question:
      "Does your bay have straight sections, or is the window a different shape?",
    answers: [
      "Bay with straight sections",
      "Angled bay",
      "Arch or circle",
      "Another shape",
    ],
  };
  env.streams.push(
    events(completed("", { output: [questionCall(selection)] })),
  );
  const reply = await env.api.generateReply(
    history,
    () => {},
    new AbortController().signal,
  );
  assert.equal(reply.text, "");
  assert.deepEqual(plain(reply.questionPresentation), {
    callId: "question-1",
    ...selection,
  });
  const input = env.calls.requests[0].input.input;
  assert.deepEqual(
    input.slice(-3),
    history.map(({ role, text }) => ({ role, content: text })),
  );
  assert.ok(input.every((message) => !Object.hasOwn(message, "source")));
  assert.ok(!input.some((message) => message.role === "assistant"));
  assert.doesNotMatch(
    JSON.stringify(input),
    /Suggested answers:|Measurement input:/,
  );
  assert.equal(
    env.calls.requests.length,
    1,
    "No repair or extra generation round",
  );
  assert.deepEqual(plain(history[1]), {
    role: "user",
    source: "roman_question",
    text: reference,
  });
});

test("invalid questions receive one terminal repair without rendering an invalid widget", async () => {
  for (const selection of [
    { ...questionSelection, answers: ["same", "SAME"] },
    { ...questionSelection, answers: [] },
    "bad JSON",
  ]) {
    const env = setup();
    env.streams.push(
      events(completed("", { output: [questionCall(selection)] })),
      events(completed("Which matters most?")),
    );
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
    );
    assertNextActions(reply);
    assert.match(
      env.calls.requests[1].input.input.find(
        (item) => item.type === "function_call_output",
      ).output,
      /No answer request was displayed/,
    );
    assert.deepEqual(allowedToolNames(env.calls.requests[1].input), [
      "ask_question",
    ]);
  }
});

test("a valid terminal question returns once without requesting a second model response", async () => {
  const env = setup();
  env.streams.push(events(completed("", { output: [questionCall()] })));
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
  );
  assert.equal(env.calls.requests.length, 1);
  assert.equal(reply.questionPresentation.question, questionSelection.question);
});

test("a terminal question mixed with pending work rejects before any tool can run", async () => {
  for (const calls of [
    [questionCall(), catalogCall("write", "clear_cart", {})],
    [catalogCall("read"), questionCall()],
  ]) {
    const env = setup();
    env.streams.push(events(completed("", { output: calls })));
    await assert.rejects(
      env.api.generateReply(
        [],
        () => assert.fail("No mixed result can display"),
        new AbortController().signal,
        () => assert.fail("No sibling tool can run"),
      ),
      /concurrent tool calls/,
    );
  }
});

test("one malformed terminal answer can be repaired but a second cannot loop or dispatch work", async () => {
  for (const second of [
    questionCall({ question: "Invalid", answers: [] }, "bad-2"),
    catalogCall("forbidden", "clear_cart", {}),
  ]) {
    const env = setup();
    env.streams.push(
      events(
        completed("", {
          output: [questionCall({ question: "Invalid", answers: [] })],
        }),
      ),
      events(completed("", { output: [second] })),
    );
    await assert.rejects(
      env.api.generateReply(
        [],
        () => assert.fail("Invalid results cannot display"),
        new AbortController().signal,
        () => assert.fail("Repairs cannot dispatch work"),
      ),
      /valid answer request|Only an answer request/,
    );
    assert.equal(env.calls.requests.length, 2);
    assert.deepEqual(allowedToolNames(env.calls.requests[1].input), [
      "ask_question",
      "ask_measurement",
    ]);
  }
});

test("guide reads provide original evidence without exposing PDF display tools or link widgets", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(completed("Let's walk through the measuring guide.")),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  assert.equal(env.calls.requests.length, 2);
  assert.equal(env.calls.guideReads.length, 1);
  assert.equal(guideFiles(env.calls.requests[1].input).length, 2);
  for (const { input } of env.calls.requests) {
    assert.ok(
      !allowedTools(input).some(
        ({ name }) => name === "show_guides" || name === "show_library_guide",
      ),
    );
  }
  assert.ok(!("guidePresentation" in reply));
  assert.ok(!("libraryGuidePresentation" in reply));
  assertNextActions(reply);
});

test("guide files attach once per URL while refreshed lookup metadata stays current", async () => {
  const env = setup();
  const guides = guideResult();
  guides.guides[1].url = guides.guides[0].url;
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(completed("", { output: [guideLookup("guides-refreshed")] })),
    events(completed("The official guide covers this configuration.")),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guides,
    "text",
    undefined,
    guideOrigin,
  );
  const outputs = env.calls.requests[2].input.input.filter(
    (item) => item.type === "function_call_output",
  );
  assert.equal(env.calls.guideReads.length, 2);
  assert.equal(guideFiles(env.calls.requests[2].input).length, 1);
  assert.equal(outputs[1].call_id, "guides-refreshed");
  assert.equal(typeof outputs[1].output, "string");
  assert.equal(JSON.parse(outputs[1].output).documentStatus, "ready");
  assert.doesNotMatch(
    JSON.stringify(reply),
    /file_data|input_file|application\/pdf/,
  );
});

test("original guide prefixes and scoped cache keys survive different history and provider call IDs", async () => {
  const env = setup();
  const history = [{ role: "user", text: "A new measurement request." }];
  for (const callId of ["first-source", "new-source"]) {
    env.streams.push(
      events(completed("", { output: [guideLookup(callId)] })),
      events(completed("Supported instructions.")),
    );
    await env.api.generateReply(
      history,
      () => {},
      new AbortController().signal,
      async () => guideResult(),
      "text",
      undefined,
      guideOrigin,
    );
    history.push(
      { role: "assistant", text: "A changing answer." },
      { role: "user", text: "A later reading." },
    );
  }
  const first = env.calls.requests[1].input;
  const second = env.calls.requests[3].input;
  assert.deepEqual(first.input.slice(0, 3), second.input.slice(0, 3));
  assert.equal(first.prompt_cache_key, second.prompt_cache_key);
  assert.match(first.prompt_cache_key, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assert.notDeepEqual(first.input.slice(3), second.input.slice(3));
  assert.equal(first.input[0].role, "developer");
  assert.deepEqual(first.input[0].content[0].prompt_cache_breakpoint, {
    mode: "explicit",
  });
  assert.ok(first.input.slice(1, 3).every((item) => item.role === "user"));
  assert.equal(guideFiles(first).length, 2);
  assert.ok(
    first.input
      .filter((item) => item.type === "function_call_output")
      .every(
        (item) =>
          typeof item.output === "string" && !item.output.includes("file_data"),
      ),
  );
  assert.deepEqual(first.tools, second.tools);
  assert.ok(
    env.calls.requests.every(
      ({ input }) =>
        input.model === "gpt-6-luna" &&
        input.service_tier === "fast" &&
        input.reasoning.effort === "medium" &&
        input.store === false,
    ),
  );
});

test("changed PDF versions, bytes and authenticated origins cannot reuse the old original-guide prefix", async () => {
  const results = [];
  for (const change of ["none", "version", "bytes", "origin"]) {
    const env = setup();
    const source = guideResult(["measuring"]);
    const origin =
      change === "origin" ? "https://another-shop.myshopify.com" : guideOrigin;
    source.guides[0].url = source.guides[0].url.replace(guideOrigin, origin);
    if (change === "version") source.guides[0].url += "4";
    if (change === "bytes")
      env.mock.readGuides = async (value) => ({
        status: "ready",
        sources: value.guides,
        files: [
          {
            ...syntheticGuideFile("measuring"),
            file_data:
              "data:application/pdf;base64,JVBERi0xLjcKY2hhbmdlZAolJUVPRg==",
          },
        ],
      });
    env.streams.push(
      events(completed("", { output: [guideLookup("source", ["measuring"])] })),
      events(completed("Supported instructions.")),
    );
    await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => source,
      "text",
      undefined,
      origin,
    );
    results.push(env.calls.requests[1].input);
  }
  for (let index = 1; index < results.length; index++)
    assert.notDeepEqual(
      results[0].input.slice(0, 2),
      results[index].input.slice(0, 2),
    );
  assert.equal(results[0].prompt_cache_key, results[1].prompt_cache_key);
  assert.equal(results[0].prompt_cache_key, results[2].prompt_cache_key);
  assert.notEqual(results[0].prompt_cache_key, results[3].prompt_cache_key);
});

test("only requested guide kinds are read and a later companion preserves the first document prefix", async () => {
  const env = setup();
  const stages = [];
  const browser = [];
  env.streams.push(
    events(completed("", { output: [guideLookup("measure", ["measuring"])] })),
    events(completed("", { output: [guideLookup("fit", ["fitting"])] })),
    events(completed("Relevant guidance.")),
  );
  await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      browser.push(plain(args));
      return guideResult();
    },
    "voice",
    undefined,
    guideOrigin,
    undefined,
    (kinds) => stages.push(kinds ? [...kinds] : undefined),
  );
  assert.deepEqual(
    env.calls.guideReads.map(([value]) =>
      plain(value.guides.map(({ kind }) => kind)),
    ),
    [["measuring"], ["fitting"]],
  );
  assert.deepEqual(browser, [
    ["measure", "get_product_guides", { productPath: guidePath }],
    ["fit", "get_product_guides", { productPath: guidePath }],
  ]);
  const first = env.calls.requests[1].input;
  const second = env.calls.requests[2].input;
  assert.equal(guideFiles(first).length, 1);
  assert.equal(guideFiles(second).length, 2);
  assert.deepEqual(first.input.slice(0, 2), second.input.slice(0, 2));
  assert.equal(first.prompt_cache_key, second.prompt_cache_key);
  assert.deepEqual(
    stages.filter(
      (value, index) =>
        !index || JSON.stringify(value) !== JSON.stringify(stages[index - 1]),
    ),
    [undefined, ["measuring"], undefined, ["fitting"], undefined],
  );
  const metadata = JSON.parse(
    first.input.find((item) => item.type === "function_call_output").output,
  );
  assert.deepEqual(
    metadata.guides.map(({ kind }) => kind),
    ["measuring"],
  );
  assert.equal(metadata.unavailableGuides, undefined);
});

test("failed selected-guide reading clears activity and continues without stale PDF context", async () => {
  const env = setup();
  const stages = [];
  env.mock.readGuides = async () => ({
    status: "unavailable",
    reason: "not_found",
  });
  env.streams.push(
    events(completed("", { output: [guideLookup("measure", ["measuring"])] })),
    events(
      completed("I couldn't read that guide. We can explore other options."),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
    undefined,
    (kinds) => stages.push(kinds ? [...kinds] : undefined),
  );
  assert.deepEqual(stages, [undefined, ["measuring"], undefined]);
  assert.equal(env.calls.requests.length, 2);
  for (const { input } of env.calls.requests)
    assert.deepEqual(guideFiles(input), []);
  const result = JSON.parse(
    env.calls.requests[1].input.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "measure",
    ).output,
  );
  assert.equal(result.documentStatus, "unavailable");
  assert.equal(result.reason, "not_found");
  assert.match(result.instruction, /Try discover_guides/);
  assertNextActions(reply);
});

test("a failed reread removes the old same-URL guide from the prefix, selection and reading activity", async () => {
  const env = setup();
  let reads = 0;
  const stages = [];
  env.mock.readGuides = async (value) => {
    const sources =
      ++reads === 1
        ? value.guides
        : value.guides.filter(({ kind }) => kind === "measuring");
    return {
      status: "ready",
      sources,
      files: sources.map(({ kind }) => syntheticGuideFile(kind)),
      ...(reads === 2
        ? { unavailable: [{ kind: "fitting", reason: "not_found" }] }
        : {}),
    };
  };
  env.streams.push(
    events(completed("", { output: [guideLookup("first")] })),
    events(completed("", { output: [guideLookup("reread")] })),
    events(completed("The fitting guide could not be read.")),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
    undefined,
    (kinds) => stages.push(kinds ? [...kinds] : undefined),
  );
  assert.equal(guideFiles(env.calls.requests[1].input).length, 2);
  assert.deepEqual(
    guideFiles(env.calls.requests[2].input).map(({ filename }) => filename),
    ["measuring-guide.pdf"],
  );
  assert.deepEqual(stages.filter(Boolean).at(-1), ["measuring"]);
  assert.equal(stages.at(-1), undefined);
  const metadata = JSON.parse(
    env.calls.requests[2].input.input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "reread",
    ).output,
  );
  assert.equal(metadata.documentStatus, "partial");
  assert.deepEqual(metadata.unavailableGuides, [
    { kind: "fitting", reason: "not_found" },
  ]);
  assert.equal(env.calls.requests.length, 3);
  assertNextActions(reply);
});

test("a fourth distinct PDP guide is rejected before downloading and clears the old PDF prefix", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", { output: [guideLookup("third-document", ["fitting"])] }),
    ),
    events(
      completed("", {
        output: [guideLookup("fourth-document", ["measuring"])],
      }),
    ),
    events(
      completed("I cannot verify that next measuring step from these sources."),
    ),
  );
  const third = guideResult(["fitting"]);
  third.guides[0].url = guideOrigin + "/cdn/shop/files/third.pdf?v=123";
  const fourth = guideResult(["measuring"]);
  fourth.guides[0].url = guideOrigin + "/cdn/shop/files/fourth.pdf?v=123";
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (id) =>
      id === "third-document"
        ? third
        : id === "fourth-document"
          ? fourth
          : guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  assert.equal(env.calls.guideReads.length, 2);
  assert.equal(env.calls.requests.length, 4);
  assert.equal(guideFiles(env.calls.requests[2].input).length, 1);
  assert.deepEqual(guideFiles(env.calls.requests[3].input), []);
  const result = JSON.parse(
    env.calls.requests[3].input.input.find(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === "fourth-document",
    ).output,
  );
  assert.equal(result.reason, "document_limit");
  assert.equal(reply.guidePresentation, undefined);
});

test("unavailable PDP documents discard preliminary advice and queued actions before a safe continuation", async (t) => {
  for (const scenario of [
    "missing",
    "unavailable",
    "lookup throws",
    "no origin",
    "network",
    "timeout",
    "invalid_pdf",
    "too_large",
  ]) {
    for (const mode of ["text", "voice"]) {
      await t.test(mode + ": " + scenario, async () => {
        const env = setup();
        const usage = [],
          displayed = [],
          dispatched = [];
        const safe =
          "I couldn't read those guides. We can look at other options.";
        env.streams.push(
          events(
            {
              type: "response.output_text.delta",
              delta: "Preliminary instructions must be replaced.",
            },
            completed("", {
              output: [
                guideLookup(),
                catalogCall("unsafe-next", "add_to_cart", {
                  productPath: guidePath,
                }),
              ],
              usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
            }),
          ),
          events(
            { type: "response.output_text.delta", delta: safe },
            completed(safe),
          ),
        );
        env.mock.readGuides = async () => ({
          status: "unavailable",
          reason: scenario,
        });
        const reply = await env.api.generateReply(
          [],
          (text) => displayed.push(text),
          new AbortController().signal,
          async (...args) => {
            dispatched.push(args);
            if (scenario === "lookup throws")
              throw new Error("Private download detail");
            return scenario === "missing"
              ? { error: "No product links" }
              : scenario === "unavailable"
                ? guideResult([])
                : guideResult();
          },
          mode,
          async (update) => usage.push(plain(update)),
          scenario === "no origin" ? undefined : guideOrigin,
        );
        assert.equal(env.calls.requests.length, 2);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0][1], "get_product_guides");
        assert.equal(
          env.calls.guideReads.length,
          ["missing", "lookup throws", "no origin"].includes(scenario) ? 0 : 1,
        );
        assert.deepEqual(displayed, [
          mode === "voice" ? `${safe} ${nextActionQuestion}` : safe,
        ]);
        assert.doesNotMatch(
          reply.text,
          /Preliminary instructions|Private download detail/,
        );
        assert.equal(reply.presentation, undefined);
        assert.equal(reply.guidePresentation, undefined);
        assert.equal(reply.cachedGuideSource, undefined);
        assertNextActions(reply);
        const continuation = env.calls.requests[1].input;
        assert.deepEqual(guideFiles(continuation), []);
        for (const id of ["unsafe-next"]) {
          const output = continuation.input.find(
            (item) =>
              item.type === "function_call_output" && item.call_id === id,
          );
          assert.match(
            JSON.parse(output.output).error,
            /Not executed: the preceding guide read failed/,
          );
        }
        assert.equal(usage.length, 4);
        assert.equal(usage[1].status, "completed");
        assert.equal(usage[1].inputTokens, 20);
        assert.equal(usage[1].outputTokens, 3);
        assert.equal(usage[1].totalTokens, 23);
      });
    }
  }
});

test("failed guide reading permits a contextual terminal question with its safe outcome", async () => {
  const env = setup();
  const recovery = {
    question: "Would you like to explore another blind?",
    answers: ["Other colours", "Other products"],
  };
  env.streams.push(
    events(completed("", { output: [guideLookup()] })),
    events(
      completed("", {
        output: [
          questionCall(
            { ...recovery, message: "I couldn't verify that measuring step." },
            "recovery-choice",
          ),
        ],
      }),
    ),
  );
  env.mock.readGuides = async () => ({
    status: "unavailable",
    reason: "invalid_pdf",
  });
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  assert.equal(env.calls.requests.length, 2);
  assert.deepEqual(plain(reply.questionPresentation), {
    callId: "recovery-choice",
    ...recovery,
  });
  assert.equal(reply.cachedGuideSource, undefined);
  assert.deepEqual(guideFiles(env.calls.requests[1].input), []);
});

test("a failed guide read during read-only voice resume cannot replace the saved question", async () => {
  const env = setup();
  const { question, ...measurement } = measurementSelection;
  const resume = {
    type: "question",
    version: 1,
    invocationId: "11111111-1111-4111-8111-111111111111",
    question,
    answers: [],
    measurement,
  };
  env.mock.readGuides = async () => ({
    status: "unavailable",
    reason: "not_found",
  });
  env.streams.push(events(completed("", { output: [guideLookup()] })));
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "voice",
    undefined,
    guideOrigin,
    resume,
  );
  assert.equal(env.calls.requests.length, 1);
  assert.equal(reply.questionPresentation, undefined);
  assert.match(reply.text, /could not be verified from its guide/);
});

test("cancellation during a failed PDF read does not return recovery choices", async () => {
  const env = setup();
  const controller = new AbortController();
  env.mock.readGuides = async () => {
    controller.abort();
    return { status: "unavailable", reason: "network" };
  };
  env.streams.push(events(completed("", { output: [guideLookup()] })));
  await assert.rejects(
    env.api.generateReply(
      [],
      () => {},
      controller.signal,
      async () => guideResult(),
      "text",
      undefined,
      guideOrigin,
    ),
    { name: "AbortError" },
  );
  assert.equal(env.calls.requests.length, 1);
});

test("successive guidance replies each read and attach their current product documents", async () => {
  const env = setup();
  for (let index = 0; index < 2; index++)
    env.streams.push(
      events(completed("", { output: [guideLookup(`guides-${index}`)] })),
      events(completed(`Guide-grounded answer ${index}.`)),
    );
  const first = await env.api.generateReply(
    [{ role: "user", text: "How do I measure this blind?" }],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  await env.api.generateReply(
    [
      { role: "assistant", text: first.text },
      { role: "user", text: "And how should I fit it?" },
    ],
    () => {},
    new AbortController().signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  assert.equal(env.calls.guideReads.length, 2);
  for (const index of [1, 3]) {
    const files = guideFiles(env.calls.requests[index].input);
    assert.deepEqual(files, [
      cachedGuideFile("measuring"),
      cachedGuideFile("fitting"),
    ]);
  }
  assert.equal(
    env.calls.requests[2].input.input.some(
      (item) => item.type === "function_call_output",
    ),
    false,
  );
});

test("cancelling during guide reading prevents a second model request or fallback advice", async () => {
  const env = setup();
  const controller = new AbortController();
  const gate = deferred();
  const displayed = [];
  env.streams.push(events(completed("", { output: [guideLookup()] })));
  env.mock.readGuides = async (_result, _origin, signal) => {
    assert.equal(signal, controller.signal);
    return gate.promise;
  };
  const pending = env.api.generateReply(
    [],
    (text) => displayed.push(text),
    controller.signal,
    async () => guideResult(),
    "text",
    undefined,
    guideOrigin,
  );
  await flush();
  assert.equal(env.calls.guideReads.length, 1);
  controller.abort();
  gate.resolve({
    status: "ready",
    sources: guideResult().guides,
    files: guideResult().guides.map(({ kind }) => syntheticGuideFile(kind)),
  });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(env.calls.requests.length, 1);
  assert.deepEqual(displayed, []);
});

test("text and voice runners read guides without persisting a customer PDF widget", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup();
    env.mock.origin = "https://shopify-single-dev.hdecom.com";
    env.streams.push(
      events(completed("", { output: [guideLookup()] })),
      events(completed("Let's walk through the measuring guide.")),
    );
    env.mock.executeTool = async () => ({
      ...guideResult(),
      guides: guideResult().guides.map((guide) => ({
        ...guide,
        url: guide.url.replace(guideOrigin, env.mock.origin),
      })),
    });
    if (mode === "voice") {
      voiceHistory(env, [
        { role: "user", text: "Help me measure this blind." },
      ]);
      await env.api.runVoiceDelegation(
        "voice",
        VOICE_ID,
        firstInput.requestId,
        new AbortController().signal,
      );
    } else {
      await env.api.startTurn("text", firstInput);
      await flush();
    }
    assert.equal(env.calls.browserTools.length, 1);
    assert.equal(env.calls.guideReads.length, 1);
    assert.equal(env.calls.guideReads[0][1], env.mock.origin);
    assert.equal(env.calls.guideReads[0][2].aborted, false);
    assert.equal(env.calls.finishes.length, 1);
    assert.ok(!("guidePresentation" in env.calls.finishes[0].result));
    assert.ok(!("libraryGuidePresentation" in env.calls.finishes[0].result));
    assert.doesNotMatch(
      JSON.stringify(env.calls.finishes[0].result),
      /input_file|file_data|application\/pdf|synthetic-guide/,
    );
  }
});

test("partial guide reads attach only readable evidence in text and voice without PDF widgets", async (t) => {
  for (const mode of ["text", "voice"])
    await t.test(mode, async () => {
      const env = setup();
      env.mock.origin = "https://shopify-single-dev.hdecom.com";
      const lookup = {
        ...guideResult(),
        guides: guideResult().guides.map((guide) => ({
          ...guide,
          url: guide.url.replace(guideOrigin, env.mock.origin),
        })),
      };
      const readableGuides = lookup.guides.filter(
        ({ kind }) => kind === "measuring",
      );
      const unavailable = [{ kind: "fitting", reason: "not_found" }];
      env.mock.executeTool = async () => lookup;
      env.mock.readGuides = async () => ({
        status: "ready",
        sources: readableGuides,
        files: [syntheticGuideFile("measuring")],
        unavailable,
      });
      const finalText = "Let's walk through the measuring guide.";
      env.streams.push(
        events(completed("", { output: [guideLookup()] })),
        events(completed(finalText)),
      );
      if (mode === "voice") {
        voiceHistory(env, [
          { role: "user", text: "Help me measure this blind." },
        ]);
        await env.api.runVoiceDelegation(
          "voice",
          VOICE_ID,
          firstInput.requestId,
          new AbortController().signal,
        );
      } else {
        await env.api.startTurn("text", firstInput);
        await flush();
      }
      assert.equal(env.calls.requests.length, 2);
      assert.equal(env.calls.browserTools.length, 1);
      assert.equal(env.calls.guideReads.length, 1);
      assert.deepEqual(plain(env.calls.guideReads[0][0]), lookup);
      assert.equal(env.calls.guideReads[0][1], env.mock.origin);
      const metadata = JSON.parse(
        env.calls.requests[1].input.input.find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "guides-lookup",
        ).output,
      );
      assert.equal(metadata.documentStatus, "partial");
      assert.deepEqual(metadata.guides, readableGuides);
      assert.deepEqual(metadata.unavailableGuides, unavailable);
      assert.deepEqual(guideFiles(env.calls.requests[1].input), [
        cachedGuideFile("measuring"),
      ]);
      const { result } = env.calls.finishes[0];
      assert.equal(result.status, "complete");
      assert.equal(
        result.text,
        mode === "voice" ? finalText + " " + nextActionQuestion : finalText,
      );
      assertNextActions(result);
      assert.doesNotMatch(
        JSON.stringify(result),
        /input_file|file_data|application\/pdf|synthetic-guide|guidePresentation/,
      );
    });
});

const recommendation = (
  ids,
  selection = questionSelection,
  callId = "recommendation",
) =>
  events(
    completed("", {
      output: [
        questionCall(
          {
            message: "Here are useful choices.",
            ...selection,
            productIds: ids.map(productGid),
          },
          callId,
        ),
      ],
    }),
  );

test("ordinary multi-category discovery returns ten grounded cards and a follow-up in two completions and one browser operation", async (t) => {
  for (const mode of ["text", "voice"])
    await t.test(mode, async () => {
      const env = setup();
      const queries = [
        "living room rollers privacy",
        "living room Romans privacy",
        "living room Venetians privacy",
      ];
      const ids = Array.from({ length: 30 }, (_, i) => i + 1);
      const selected = [1, 11, 21, 2, 12, 22, 3, 13, 23, 24];
      env.streams.push(
        events(
          completed("", {
            output: [catalogCall("batch", "search_products", { queries })],
          }),
        ),
        recommendation(selected),
      );
      const dispatches = [];
      const history = [
        {
          role: "user",
          text: "Living room, daytime privacy. Show me everything.",
        },
      ];
      const reply = await env.api.generateReply(
        history,
        () => {},
        new AbortController().signal,
        async (...args) => {
          dispatches.push(args);
          const result = catalogResult(...ids);
          result.queries = queries.map((query, i) => ({
            query,
            status: "succeeded",
            productIds: ids.slice(i * 10, i * 10 + 10).map(productGid),
          }));
          return result;
        },
        mode,
      );
      assert.equal(env.calls.requests.length, 2);
      assert.deepEqual(plain(dispatches), [
        ["batch", "search_products", { queries }],
      ]);
      assert.equal(env.calls.guideReads.length, 0);
      assert.deepEqual(plain(reply.presentation), {
        callId: "recommendation",
        productIds: selected.map(productGid),
        productRefs: productRefs(selected),
      });
      assert.equal(reply.questionPresentation.callId, "recommendation");
      assert.equal(
        reply.text,
        "Here are useful choices." +
          (mode === "voice" ? ` ${questionSelection.question}` : ""),
      );
      const terminal = env.calls.requests[1].input.tools.find(
        ({ name }) => name === "ask_question",
      );
      assert.equal(terminal.parameters.properties.productIds.maxItems, 10);
      assert.ok(
        env.calls.requests.every(
          ({ input }) =>
            !input.tools.some(({ name }) => name === "show_products"),
        ),
      );
      const supplied = env.calls.requests[1].input.input.filter(
        ({ type }) => type === "function_call_output",
      );
      assert.equal(supplied.length, 1);
      assert.equal(JSON.parse(supplied[0].output).products.length, 30);
    });
});

test("missing detail evidence permits one batched lookup without a separate presentation completion", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [catalogCall("batch")] })),
    events(
      completed("", {
        output: [
          catalogCall("details", "lookup_catalog", {
            ids: [productGid(123), productGid(456)],
          }),
        ],
      }),
    ),
    recommendation([456, 123]),
  );
  const dispatches = [];
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      dispatches.push(args);
      return catalogResult(123, 456);
    },
  );
  assert.deepEqual(
    dispatches.map((args) => args[1]),
    ["search_products", "lookup_catalog"],
  );
  assert.equal(env.calls.requests.length, 3);
  assert.deepEqual(
    plain(reply.presentation.productRefs),
    productRefs([456, 123]),
  );
});

test("the initial product choice and a later Something else preserve current intent in text and voice", async (t) => {
  const selection = {
    question:
      "Do you want to start with the blind you're currently looking at, or something else?",
    answers: ["This blind", "Something else"],
  };
  for (const mode of ["text", "voice"])
    await t.test(mode, async () => {
      const env = setup();
      env.streams.push(
        events(completed("", { output: [catalogCall("product-choice")] })),
        recommendation([123], selection),
        recommendation([], {
          question: "Which room are you shopping for?",
          answers: ["Bedroom", "Living room", "Another room"],
        }),
      );
      const initial = [
        { role: "user", text: "Help me measure my windows for blinds." },
      ];
      const reply = await env.api.generateReply(
        initial,
        () => {},
        new AbortController().signal,
        async () => catalogResult(123, 456),
        mode,
      );
      assert.deepEqual(plain(reply.presentation.productIds), [productGid(123)]);
      assert.equal(reply.questionPresentation.question, selection.question);
      assert.deepEqual(
        plain(reply.questionPresentation.answers),
        selection.answers,
      );
      const followup = await env.api.generateReply(
        [
          ...initial,
          { role: "assistant", text: selection.question },
          { role: "user", text: "Something else" },
        ],
        () => {},
        new AbortController().signal,
        async () => assert.fail("Room discovery needs no research"),
        mode,
      );
      assert.equal(followup.presentation, undefined);
      assert.equal(
        followup.questionPresentation.question,
        "Which room are you shopping for?",
      );
      assert.equal(env.calls.requests.length, 3);
      assert.equal(env.calls.guideReads.length, 0);
    });
});

test("catalog titles and card order cannot rewrite the selected follow-up", async () => {
  const env = setup();
  const result = catalogResult(1, 2, 3);
  result.products[0].title = "A different blind";
  result.products[1].title = "<Untrusted title>";
  const selection = {
    question: "Would you like more colours?",
    answers: ["Show me more", "Different styles"],
  };
  env.streams.push(
    events(completed("", { output: [catalogCall("search")] })),
    recommendation([2, 1], selection),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => result,
  );
  assert.deepEqual(plain(reply.questionPresentation), {
    callId: "recommendation",
    ...selection,
  });
  assert.deepEqual(plain(reply.presentation.productRefs), [
    { id: productGid(2), title: "<Untrusted title>" },
    { id: productGid(1), title: "A different blind" },
  ]);
});

test("invalid terminal cards or question cannot publish a partial recommendation and get only one local repair", async (t) => {
  for (const [label, fields] of [
    ["duplicate", { productIds: [productGid(123), productGid(123)] }],
    ["variant", { productIds: ["gid://shopify/ProductVariant/123"] }],
    ["unverified", { productIds: [productGid(999)] }],
    [
      "too many",
      { productIds: Array.from({ length: 11 }, (_, i) => productGid(i + 1)) },
    ],
    ["empty question", { productIds: [productGid(123)], question: "" }],
    [
      "unsupported answer",
      { productIds: [productGid(123)], answers: ["Finish for now"] },
    ],
    ["extra fields", { productIds: [productGid(123)], title: "Forged title" }],
  ])
    await t.test(label, async () => {
      const env = setup();
      const observed = [];
      env.streams.push(
        events(completed("", { output: [catalogCall("search")] })),
        events(
          completed("", {
            output: [
              questionCall(
                { ...questionSelection, message: "INVALID PARTIAL", ...fields },
                "invalid",
              ),
            ],
          }),
        ),
        recommendation(
          [],
          { ...questionSelection, message: "Safe clarification." },
          "repaired",
        ),
      );
      const reply = await env.api.generateReply(
        [{ role: "assistant", text: `Earlier product ${productGid(999)}` }],
        (text) => observed.push(text),
        new AbortController().signal,
        async () =>
          catalogResult(123, ...Array.from({ length: 11 }, (_, i) => i + 1)),
      );
      assert.equal(reply.presentation, undefined);
      assert.equal(reply.questionPresentation.callId, "repaired");
      assert.doesNotMatch(JSON.stringify(observed), /INVALID PARTIAL/);
      assert.deepEqual(allowedToolNames(env.calls.requests[2].input), [
        "ask_question",
        "ask_measurement",
      ]);
      assert.equal(env.calls.requests.length, 3);
    });
});

test("a measurement without verified guide provenance cannot publish otherwise grounded cards", async () => {
  const env = setup();
  const observed = [];
  env.streams.push(
    events(completed("", { output: [catalogCall("search")] })),
    events(
      completed("", {
        output: [
          measurementCall({
            ...measurementSelection,
            productIds: [productGid(123)],
          }),
        ],
      }),
    ),
    recommendation([]),
  );
  const reply = await env.api.generateReply(
    [],
    (text) => observed.push(text),
    new AbortController().signal,
    async () => catalogResult(123),
  );
  assert.equal(reply.presentation, undefined);
  assert.equal(reply.questionPresentation.measurement, undefined);
  assert.doesNotMatch(JSON.stringify(observed), /wall to wall/);
});

test("a later turn must refresh products before recommending historical cards", async () => {
  const env = setup();
  env.streams.push(
    events(completed("", { output: [catalogCall("first")] })),
    recommendation([123]),
    recommendation([123], questionSelection, "stale"),
    recommendation([], questionSelection, "clarify"),
    events(
      completed("", {
        output: [
          catalogCall("refresh", "lookup_catalog", { ids: [productGid(123)] }),
        ],
      }),
    ),
    recommendation([123], questionSelection, "fresh"),
  );
  const execute = async () => catalogResult(123);
  const first = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    execute,
  );
  const history = [
    {
      role: "assistant",
      text: `Earlier recommendation: ${first.presentation.productIds[0]}`,
    },
    { role: "user", text: "Show it again" },
  ];
  const stale = await env.api.generateReply(
    history,
    () => {},
    new AbortController().signal,
    execute,
  );
  assert.equal(stale.presentation, undefined);
  const fresh = await env.api.generateReply(
    history,
    () => {},
    new AbortController().signal,
    execute,
  );
  assert.deepEqual(plain(fresh.presentation.productIds), [productGid(123)]);
});

test("the retired standalone show_products tool cannot execute or publish cards", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", {
        output: [
          catalogCall("retired", "show_products", {
            productIds: [productGid(123)],
          }),
        ],
      }),
    ),
    recommendation([]),
  );
  let dispatches = 0;
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => {
      dispatches++;
      return catalogResult(123);
    },
  );
  assert.equal(dispatches, 0);
  assert.equal(reply.presentation, undefined);
});

test("provider failure or cancellation before terminal completion cannot return cards", async (t) => {
  for (const mode of ["failed", "cancelled"])
    await t.test(mode, async () => {
      const env = setup();
      const controller = new AbortController();
      const observed = [];
      env.streams.push(
        events(completed("", { output: [catalogCall("search")] })),
        (async function* () {
          if (mode === "cancelled") controller.abort(new Error("Ended"));
          yield mode === "failed"
            ? { type: "response.failed" }
            : completed("", {
                output: [
                  questionCall({
                    ...questionSelection,
                    productIds: [productGid(123)],
                  }),
                ],
              });
        })(),
      );
      await assert.rejects(
        env.api.generateReply(
          [],
          (text) => observed.push(text),
          controller.signal,
          async () => catalogResult(123),
        ),
      );
      assert.equal(env.calls.requests.length, 2);
      assert.deepEqual(observed, []);
    });
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
    allowedTools(env.calls.requests[1].input).some(
      (tool) => tool.name === "ask_question",
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
    { type: "text", text: "" },
    widget,
  ]);
  generation.complete();
  await flush();
});

const VOICE_ID = "b3d1a5c9-814c-458f-a2a6-33c91b5f1d05";

const savedResumeQuestion = (numeric = true) => ({
  type: "question",
  version: 1,
  invocationId: "9c0f10a6-0e9e-4288-9521-b4c46285a404",
  ...(numeric
    ? {
        question: measurementSelection.question,
        answers: [],
        measurement: {
          productPath: guidePath,
          label: "Width",
          unit: "mm",
          instructions: "Earlier instructions must be checked again.",
        },
      }
    : questionSelection),
});

test("startup resume exposes only guide reads and the matching saved question presentation", async () => {
  for (const numeric of [true, false]) {
    const env = setup();
    const saved = savedResumeQuestion(numeric);
    env.streams.push(
      ...(numeric ? [events(completed("", { output: [guideLookup()] }))] : []),
      events(
        completed("", {
          output: [numeric ? measurementCall() : questionCall()],
        }),
      ),
    );
    const reply = await env.api.generateReply(
      [],
      () => {},
      new AbortController().signal,
      async () => guideResult(),
      "voice",
      undefined,
      guideOrigin,
      saved,
    );
    assert.deepEqual(
      allowedTools(env.calls.requests[0].input).map((tool) => tool.name),
      ["get_product_guides", numeric ? "ask_measurement" : "ask_question"],
    );
    assert.equal(
      reply.text,
      [numeric ? measurementSelection.instructions : undefined, saved.question]
        .filter(Boolean)
        .join(" "),
      "The validated response contains the exact spoken step once",
    );
    assert.equal(reply.questionPresentation.question, saved.question);
    assert.equal(env.calls.guideReads.length, numeric ? 1 : 0);
    assert.equal(env.calls.requests.length, numeric ? 2 : 1);
    assert.equal(env.streams.length, 0);
    if (numeric) {
      assert.equal(reply.questionPresentation.sourceCallId, "guides-lookup");
      assert.equal(
        reply.questionPresentation.measurement.instructions,
        measurementSelection.instructions,
      );
      assert.equal(guideFiles(env.calls.requests[1].input).length, 2);
    }
  }
});

test("startup resume rejects unsolicited actions, catalog reads and another product before dispatch", async () => {
  for (const [name, input] of [
    ["navigate", { path: guidePath }],
    ["open_checkout", {}],
    ["add_to_cart", { productPath: guidePath }],
    ["apply_measurements", { productPath: guidePath }],
    ["set_measurements", {}],
    ["configure_product", {}],
    ["search_products", {}],
    ["show_products", {}],
    ["ask_question", questionSelection],
    [
      "get_product_guides",
      { productPath: "/products/another-blind", kinds: ["measuring"] },
    ],
  ]) {
    const env = setup();
    let dispatched = 0;
    env.streams.push(
      events(completed("", { output: [catalogCall("unsafe", name, input)] })),
    );
    await assert.rejects(
      env.api.generateReply(
        [],
        () => {},
        new AbortController().signal,
        async () => {
          dispatched++;
          return guideResult();
        },
        "voice",
        undefined,
        guideOrigin,
        savedResumeQuestion(),
      ),
    );
    assert.equal(dispatched, 0, name);
    assert.equal(env.calls.guideReads.length, 0, name);
  }
});

test("startup cannot invent changed measurement metadata or reuse historic guide evidence", async () => {
  for (const changed of [
    "no_read",
    "question",
    "productPath",
    "label",
    "unit",
  ]) {
    const env = setup();
    const selection = { ...measurementSelection };
    if (changed === "question") selection.question = "A different question?";
    if (changed === "productPath")
      selection.productPath = "/products/another-blind";
    if (changed === "label") selection.label = "Drop";
    if (changed === "unit") selection.unit = "cm";
    env.streams.push(
      ...(changed !== "no_read"
        ? [events(completed("", { output: [guideLookup()] }))]
        : []),
      events(completed("", { output: [measurementCall(selection)] })),
      events(completed("Unverified instructions must not be forwarded.")),
    );
    await assert.rejects(
      env.api.generateReply(
        [{ role: "assistant", text: "I read this guide earlier." }],
        () => {},
        new AbortController().signal,
        async () => guideResult(),
        "voice",
        undefined,
        guideOrigin,
        savedResumeQuestion(),
      ),
      /Only read-only question resume tools are allowed/,
    );
  }
});

test("runner forwards durable startup scope and suppresses stale committed results", async () => {
  for (const finished of [true, false]) {
    const env = setup();
    const saved = savedResumeQuestion(false);
    voiceHistory(env, [{ role: "assistant", text: "Which matters most?" }]);
    env.rows.set("resume", {
      status: "active",
      revision: 0,
      tools: [],
      messages: [
        {
          id: "saved",
          role: "assistant",
          status: "complete",
          text: "",
          extraParts: [saved],
        },
      ],
    });
    const finish = env.mock.finish;
    env.mock.finish = async (...args) => {
      await finish(...args);
      return finished;
    };
    env.streams.push(events(completed("", { output: [questionCall()] })));
    const reply = await env.api.runVoiceDelegation(
      "resume",
      VOICE_ID,
      firstInput.requestId,
      new AbortController().signal,
      { resumeQuestionId: saved.invocationId },
    );
    assert.equal(env.calls.begins[0].resumeQuestionId, saved.invocationId);
    assert.equal(
      env.calls.finishes[0].result.resumeQuestionId,
      saved.invocationId,
    );
    assert.deepEqual(
      allowedTools(env.calls.requests[0].input).map((tool) => tool.name),
      ["get_product_guides", "discover_guides", "read_library_guides", "ask_question"],
    );
    assert.equal(!!reply, finished);
    assert.equal(env.calls.requests.length, 1);
  }
});

test("a stale startup reservation returns without a model request or active-turn leak", async () => {
  const env = setup();
  env.mock.begin = async () => ({
    snapshot: { messages: [] },
    assistantId: null,
    history: [],
    origin: guideOrigin,
  });
  const result = await env.api.runVoiceDelegation(
    "stale",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
    { resumeQuestionId: savedResumeQuestion().invocationId },
  );
  assert.equal(result, undefined);
  assert.equal(env.calls.requests.length, 0);
  assert.equal(env.calls.finishes.length, 0);
  assert.deepEqual(env.logs, []);
  await env.api.runVoiceDelegation(
    "stale",
    VOICE_ID,
    secondInput.requestId,
    new AbortController().signal,
  );
});

function voiceHistory(env, history) {
  const textBegin = env.mock.begin;
  env.mock.begin = async (id, input, voiceId, resumeQuestionId) => {
    if (!voiceId) return textBegin(id, input);
    env.calls.begins.push({ id, input, voiceId, resumeQuestionId });
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
    return {
      snapshot: env.snapshot(id),
      assistantId,
      history: plain(history),
      origin: env.mock.origin,
    };
  };
}

test("voice delegation forwards canonical caption history to the advisor without a fabricated customer message", async () => {
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
  assert.equal(
    reply.text,
    `These are verified blackout rollers. ${nextActionQuestion}`,
  );
  assertNextActions(reply);
  assert.deepEqual(plain(env.calls.begins), [
    {
      id: "voice",
      input: { requestId: firstInput.requestId, text: "" },
      voiceId: VOICE_ID,
    },
  ]);
  assert.deepEqual(
    env.calls.requests[0].input.input.filter(({role}) => role !== "developer"),
    history.map(({ role, text }) => ({ role, content: text })),
  );
  assert.equal(env.calls.requests[0].input.instructions, env.api.ROMAN_VOICE_BRIEFING_PROMPT);
  assert.equal(env.calls.requests[0].input.model, "gpt-6-luna");
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
    events(
      completed("", { output: [questionCall({message:"Two blackout rollers are displayed in the chat carousel.", ...questionSelection, productIds:[productGid(456), productGid(123)]},"voice-show")] }),
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
    productRefs: productRefs([456, 123]),
  });
  assert.equal(env.calls.browserTools.length, 1);
  assert.deepEqual(plain(env.calls.browserTools[0].slice(0, 5)), [
    "voice",
    "voice-voice-0",
    "voice-search",
    "search_products",
    { queries: ["no drill"] },
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
  assert.equal(env.calls.finishes.at(-1).result.status, "cancelled");
  assert.equal(env.calls.finishes.at(-1).result.error, undefined);
  assert.equal((await env.api.readConversation("voice")).busy, false);
  assert.equal(env.logs.length, 0);
});

test("cancel during voice initialization finishes the reserved work without calling the advisor", async () => {
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
  const cancelled = env.api.cancelVoiceDelegation("voice", VOICE_ID);
  begin.resolve();
  await Promise.all([pending, cancelled]);
  assert.equal(env.calls.requests.length, 0);
  assert.equal(env.calls.browserTools.length, 0);
  assert.ok(
    env.calls.finishes.every(({ result }) => result.status === "cancelled"),
  );
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
  assert.equal(snapshot.messages.at(-1).parts[0].text, "");
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

test("a corrected voice request silently retires its search while the replacement can finish", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Actually, choose blackout." }]);
  env.streams.push(
    events(
      completed("", {
        output: [
          catalogCall("old-search", "search_products", { queries: ["sheer"] }),
        ],
      }),
    ),
    events(completed("Here is the corrected blackout result.")),
  );
  env.mock.executeTool = async (...args) =>
    new Promise((_resolve, reject) => {
      const signal = args.at(-1);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  const original = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  await env.api.cancelVoiceDelegation("voice", VOICE_ID);
  assert.equal(await original, undefined);
  assert.deepEqual(plain(env.calls.finishes[0].result), {
    text: "",
    status: "cancelled",
  });
  const replacement = await env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    secondInput.requestId,
    new AbortController().signal,
  );
  assert.equal(
    replacement.text,
    `Here is the corrected blackout result. ${nextActionQuestion}`,
  );
  assertNextActions(replacement);
  assert.equal(env.calls.browserTools.length, 1);
  assert.equal(env.calls.finishes.at(-1).result.status, "complete");
  assert.equal((await env.api.readConversation("voice")).busy, false);
  assert.deepEqual(env.logs, []);
});

test("a genuine voice delegation provider failure remains a failed reply", async () => {
  const env = setup();
  voiceHistory(env, [{ role: "user", text: "Find me a blind." }]);
  const response = pendingReply();
  env.streams.push(response.stream);
  const pending = env.api.runVoiceDelegation(
    "voice",
    VOICE_ID,
    firstInput.requestId,
    new AbortController().signal,
  );
  await flush();
  response.fail();
  await pending;
  assert.equal(env.calls.finishes.at(-1).result.status, "failed");
  assert.match(env.calls.finishes.at(-1).result.error, /could not finish/);
  assert.equal(env.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(env.logs), /private provider failure/);
});

test("clear customer dimensions save and apply without a confirmation turn, then read the quote in text and voice", async (t) => {
  for (const mode of ["text", "voice"]) {
    for (const outcome of [
      "applied",
      "cancelled",
      "uncertain",
      "apply_error",
      "save_error",
    ]) {
      await t.test(`${mode}: ${outcome}`, async () => {
        const env = setup();
        const save = deferred();
        const apply = deferred();
        const measurementCalls = [];
        const input = {
          productPath: "/products/shade",
          width: 300,
          height: 300,
          unit: "mm",
          kind: "order",
          mount: "recess",
        };
        const draft = { ...input, updatedAt: "2026-09-16T10:00:00.000Z" };
        const nativeConfiguration = {
          ...configuration(1, input.productPath),
          measurements: { width: 300, height: 300, unit: "mm", availableUnits: ["mm"] },
          configuredPrice: "£45.00",
        };
        const appliedResult = {
          status: outcome,
          productPath: input.productPath,
          draftUpdatedAt: draft.updatedAt,
          message:
            outcome === "applied"
              ? "The confirmed dimensions were filled."
              : "The form change was not confirmed.",
        };
        let saved = false;
        env.mock.measurementTool = async (...args) => {
          measurementCalls.push(args);
          await save.promise;
          if (outcome === "save_error") throw new Error("PRIVATE_SAVE_FAILURE");
          saved = true;
          return { status: "saved", draft };
        };
        env.mock.executeTool = async (...args) => {
          assert.equal(saved, true, "Application follows the completed save");
          if (args[3] === "get_product_configuration") return nativeConfiguration;
          await apply.promise;
          if (outcome === "apply_error")
            throw new Error("PRIVATE_APPLY_FAILURE");
          return appliedResult;
        };
        const finalText =
          outcome === "applied"
            ? "300mm wide × 300mm drop are entered. The current blind quote is £45.00."
            : "I could not confirm that the product form was filled.";
        env.streams.push(
          events(
            completed("", {
              output: [catalogCall("save-order", "set_measurements", input)],
            }),
          ),
          ...(outcome === "save_error"
            ? []
            : [
                events(
                  completed("", {
                    output: [
                      catalogCall("apply-order", "apply_measurements", {
                        productPath: input.productPath,
                      }),
                    ],
                  }),
                ),
              ]),
          ...(outcome === "applied"
            ? [events(completed("", { output: [configRead(1, input.productPath)] }))]
            : []),
          events(completed(finalText)),
        );
        const text =
          "This blind needs 300mm width and 300mm drop, recess fitting.";
        let pending;
        if (mode === "voice") {
          voiceHistory(env, [{ role: "user", text }]);
          pending = env.api.runVoiceDelegation(
            "measurements",
            VOICE_ID,
            firstInput.requestId,
            new AbortController().signal,
          );
        } else {
          await env.api.startTurn("measurements", { ...firstInput, text });
        }
        await flush();
        assert.equal(measurementCalls.length, 1);
        assert.deepEqual(plain(measurementCalls[0].slice(2)), [
          "save-order",
          "set_measurements",
          input,
        ]);
        assert.equal(env.calls.browserTools.length, 0);
        assert.equal(env.calls.requests.length, 1);
        assert.equal(env.calls.finishes.length, 0);
        save.resolve();
        await flush();
        const savedOutput = env.calls.requests[1].input.input.find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === "save-order",
        );
        if (outcome === "save_error") {
          assert.match(
            JSON.parse(savedOutput.output).error,
            /could not be read or saved/,
          );
          assert.equal(env.calls.browserTools.length, 0);
        } else {
          assert.deepEqual(JSON.parse(savedOutput.output), {
            status: "saved",
            draft,
          });
          assert.ok(
            allowedTools(env.calls.requests[1].input).some(
              (tool) => tool.name === "apply_measurements",
            ),
            "Saving a draft does not consume the browser mutation allowance",
          );
          assert.equal(env.calls.browserTools.length, 1);
          assert.deepEqual(plain(env.calls.browserTools[0].slice(2, 5)), [
            "apply-order",
            "apply_measurements",
            { productPath: input.productPath },
          ]);
          assert.equal(
            env.calls.browserTools[0][1],
            measurementCalls[0][1],
            "Save and apply belong to the same reply",
          );
          assert.equal(env.calls.requests.length, 2);
          assert.equal(env.calls.finishes.length, 0);
          assert.equal(
            (await env.api.readConversation("measurements")).busy,
            true,
            "Pending form application cannot become a completed answer",
          );
          apply.resolve();
          await flush();
          const appliedOutput = env.calls.requests[2].input.input.find(
            (item) =>
              item.type === "function_call_output" &&
              item.call_id === "apply-order",
          );
          if (outcome === "apply_error")
            assert.match(
              JSON.parse(appliedOutput.output).error,
              /not confirmed.*not claim.*repeat/i,
            );
          else
            assert.deepEqual(JSON.parse(appliedOutput.output), appliedResult);
        }
        await pending;
        await flush();
        assert.equal(env.calls.finishes.length, 1);
        assert.equal(env.calls.finishes[0].result.status, "complete");
        assert.equal(
          env.calls.finishes[0].result.text,
          mode === "voice" ? `${finalText} ${nextActionQuestion}` : finalText,
        );
        assertNextActions(env.calls.finishes[0].result);
        if (outcome === "applied") {
          assert.deepEqual(
            env.calls.browserTools.map((args) => args[3]),
            ["apply_measurements", "get_product_configuration"],
          );
          const quoteOutput = env.calls.requests.at(-1).input.input.find(
            (item) => item.type === "function_call_output" && item.call_id === "read-1",
          );
          assert.deepEqual(JSON.parse(quoteOutput.output), nativeConfiguration);
        }
        assert.ok(
          env.calls.browserTools.every(
            (args) => ["apply_measurements", "get_product_configuration"].includes(args[3]),
          ),
          "Configuring dimensions never adds to or changes the cart",
        );
        assert.doesNotMatch(
          JSON.stringify(env.calls.requests),
          /PRIVATE_SAVE_FAILURE|PRIVATE_APPLY_FAILURE/,
        );
      });
    }
  }
});

test("show_view is available as a bounded browser tool without native navigation", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", {
        output: [catalogCall("show-cart", "show_view", { view: "cart" })],
      }),
    ),
    events(completed("Your cart is open.")),
  );
  const calls = [];
  await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async (...args) => {
      calls.push(args.slice(0, 3));
      return { status: "shown", view: "cart" };
    },
  );
  assert.deepEqual(plain(calls), [
    ["show-cart", "show_view", { view: "cart" }],
  ]);
  assert.ok(
    allowedTools(env.calls.requests[0].input).some(
      (tool) => tool.name === "show_view",
    ),
  );
});

test("plain prose receives one structured repair without publishing a competing question", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup(),
      visible = [];
    env.streams.push(
      events(
        { type: "response.output_text.delta", delta: "Which room?" },
        completed("", {
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Which room?" }],
            },
          ],
        }),
      ),
      events(
        completed("", {
          output: [
            questionCall({
              message: "",
              question: "Which room?",
              answers: ["Bedroom", "Living room"],
            }),
          ],
        }),
      ),
    );
    const reply = await env.api.generateReply(
      [],
      (text) => visible.push(text),
      new AbortController().signal,
      () => assert.fail("A repair cannot execute storefront work"),
      mode,
    );
    assert.equal(reply.text, mode === "voice" ? "Which room?" : "");
    assert.deepEqual(visible, [reply.text]);
    assert.equal(reply.questionPresentation.question, "Which room?");
    assert.equal(env.calls.requests.length, 2);
    assert.deepEqual(allowedToolNames(env.calls.requests[1].input), [
      "ask_question",
      "ask_measurement",
    ]);
    assert.equal(env.calls.requests[1].input.tool_choice.mode, "required");
  }
});

test("repairing a repeated written question never replays the preceding cart action", async () => {
  const env = setup(),
    executed = [],
    visible = [];
  const q = {
    question: "What would you like to do next?",
    answers: ["Find more products", "View cart"],
  };
  env.streams.push(
    events(
      completed("", { output: [catalogCall("cart-read", "get_cart", {})] }),
    ),
    events(
      completed("", { output: [catalogCall("cart-clear", "clear_cart", {})] }),
    ),
    events(
      completed("", {
        output: [
          questionCall({ ...q, message: "The cart is empty. " + q.question }),
        ],
      }),
    ),
    events(
      completed("", {
        output: [
          questionCall({ ...q, message: "The cart is empty." }, "repaired"),
        ],
      }),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    (text) => visible.push(text),
    new AbortController().signal,
    async (id, name) => {
      executed.push(name);
      return name === "get_cart"
        ? { currency: "GBP", itemCount: 0, totalPriceMinorUnits: 0, items: [] }
        : { status: "updated", message: "The cart is empty." };
    },
  );
  assert.deepEqual(executed, ["get_cart", "clear_cart"]);
  assert.deepEqual(visible, ["The cart is empty."]);
  assert.equal(reply.questionPresentation.callId, "repaired");
  assert.equal(env.calls.requests.length, 4);
  assert.deepEqual(allowedToolNames(env.calls.requests[3].input), [
    "ask_question",
    "ask_measurement",
  ]);
});

test("a fitting-only original cannot authorize a numeric measuring input", async () => {
  const env = setup();
  env.streams.push(
    events(
      completed("", { output: [guideLookup("fitting-only", ["fitting"])] }),
    ),
    events(completed("", { output: [measurementCall()] })),
    events(
      completed(
        "I need the matching measuring guide before we take that reading.",
      ),
    ),
  );
  const reply = await env.api.generateReply(
    [],
    () => {},
    new AbortController().signal,
    async () => guideResult(["fitting"]),
    "text",
    undefined,
    guideOrigin,
  );
  assert.equal(reply.questionPresentation.measurement, undefined);
  assert.equal(env.calls.requests.length, 3);
  assert.match(
    env.calls.requests[2].input.input.find(
      (i) => i.call_id === "measurement-1" && i.type === "function_call_output",
    ).output,
    /no verified measuring guide/,
  );
});

for(const mode of ['text','voice']) for(const status of ['opened','blocked']) test('checkout returns an outcome-grounded sign-off without an answer-widget repair: '+mode+' '+status,async()=>{
 const env=setup();const text=status==='opened'?'Checkout is opening in a new tab. I will be here if you need anything else.':'Choose Continue to checkout in your cart. I will be here if you need anything else.';
 env.streams.push(events(completed('',{output:[catalogCall('checkout','open_checkout',{})]})),events(completed('',{output:[{type:'message',content:[{type:'output_text',text}]}]})));
 const calls=[],visible=[];const reply=await env.api.generateReply([],value=>visible.push(value),new AbortController().signal,async(...args)=>{calls.push(args.slice(0,3));return{status}},mode);
 assert.deepEqual(plain(calls),[['checkout','open_checkout',{}]]);assert.equal(reply.text,text);assert.equal(reply.questionPresentation,undefined);assert.deepEqual(visible,[text]);assert.equal(env.calls.requests.length,2);assert.equal(env.calls.requests[1].input.tool_choice,'none');
});

test('checkout handoff rejects unsolicited follow-on tools after the browser outcome',async()=>{
 const env=setup();let executions=0;
 env.streams.push(events(completed('',{output:[catalogCall('checkout','open_checkout',{})]})),events(completed('',{output:[catalogCall('repeat','open_checkout',{})]})));
 await assert.rejects(env.api.generateReply([],()=>{},new AbortController().signal,async()=>{executions++;return{status:'opened'}}),/no further tools/);
 assert.equal(executions,1);assert.equal(env.calls.requests[1].input.tool_choice,'none');
});

function memoryReply(env, options = {}) {
  return env.api.generateReply(
    options.history ?? [], options.onText ?? (() => {}), new AbortController().signal,
    options.execute, options.mode ?? "text", undefined, guideOrigin,
    undefined, undefined, undefined, undefined, undefined, "medium",
    options.memory ?? { memo: {}, throughSequence: 10, checkpoints: [] }, options.recall,
  );
}

test("terminal memory patches stay private and use the same completion in text and voice", async () => {
  for (const mode of ["text", "voice"]) {
    const env = setup(), visible = [];
    const memoryUpdate = {
      set: [{ key: "kitchen/curtain", text: "PRIVATE_PENDING_CURTAIN: return after the blind. Source 8." }],
      forget: [],
    };
    env.streams.push(events(completed("", { output: [questionCall({
      message: "The width is saved.", question: "What is the drop?", answers: ["Help me measure"], memoryUpdate,
    })] })));
    const reply = await memoryReply(env, { mode, onText: (text) => visible.push(text) });
    assert.deepEqual(plain(reply.memoryUpdate), memoryUpdate);
    assert.doesNotMatch(JSON.stringify([visible, reply.text, reply.questionPresentation, reply.presentation]), /PRIVATE_|memoryUpdate|kitchen\/curtain/);
    assert.equal(env.calls.requests.length, 1, "memory uses the terminal answer, not a second model request");
    assert.equal(env.calls.browserTools.length, 0);
    const terminal = env.calls.requests[0].input.tools.find((tool) => tool.name === "ask_question");
    assert.ok(terminal.required === undefined);
    assert.ok(terminal.parameters.required.includes("memoryUpdate"));
    assert.deepEqual(terminal.parameters.properties.memoryUpdate.type, ["object", "null"]);
  }
});

test("an invalid private patch gets one terminal-only repair without publishing or applying it", async () => {
  const env = setup(), visible = [];
  env.streams.push(
    events(completed("", { output: [questionCall({
      ...questionSelection,
      memoryUpdate: { set: [{ key: "constructor", text: "PRIVATE_INVALID_NOTE" }], forget: [] },
    }, "invalid-memory")] })),
    events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null }, "valid-memory")] })),
  );
  const reply = await memoryReply(env, { onText: (text) => visible.push(text), execute: () => assert.fail("Repair cannot execute storefront work") });
  assert.equal(reply.memoryUpdate, undefined);
  assert.equal(reply.questionPresentation.callId, "valid-memory");
  assert.deepEqual(visible, [""]);
  assert.equal(env.calls.requests.length, 2);
  assert.deepEqual(allowedToolNames(env.calls.requests[1].input), ["ask_question", "ask_measurement"]);
  const rejection = env.calls.requests[1].input.input.find((item) => item.type === "function_call_output" && item.call_id === "invalid-memory");
  assert.match(rejection.output, /Private notes|private memory/i);
  assert.doesNotMatch(JSON.stringify([reply, visible]), /PRIVATE_INVALID_NOTE/);
});

test("automatic compaction persists the entire latest continuation and closes the terminal call", async () => {
  const env = setup(), executions = [];
  const compact = { type: "compaction", id: "compact-current", encrypted_content: "PRIVATE_COMPACT_CURRENT" };
  const reasoning = { type: "reasoning", id: "reason-current", summary: [], encrypted_content: "PRIVATE_REASON_CURRENT" };
  const read = catalogCall("cart-current", "get_cart", {});
  const terminal = questionCall({ ...questionSelection, memoryUpdate: null }, "terminal-current");
  env.streams.push(
    events(completed("", { output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Obsolete pre-compaction text." }] },
      compact, reasoning, read,
    ] })),
    events(completed("", { output: [terminal] })),
  );
  const reply = await memoryReply(env, {
    history: [{ role: "user", text: "Long durable conversation. ".repeat(1000) }],
    memory: { memo: { "kitchen/curtain": "Heading pending." }, throughSequence: 42, checkpoints: [] },
    execute: async (...args) => { executions.push(args); return { status: "ready", itemCount: 0 }; },
  });
  const continuation = plain(reply.contextCheckpoint);
  assert.equal(continuation.model, "gpt-6-luna");
  assert.equal(reply.requestedModel, "gpt-6-luna");
  assert.equal(reply.model, "gpt-5.6-luna-actual", "the provider's reported model remains the billing identity");
  assert.equal(continuation.throughSequence, 42);
  assert.deepEqual(continuation.input.slice(0, 3), [compact, reasoning, read]);
  assert.deepEqual(continuation.input.map((item) => item.type), [
    "compaction", "reasoning", "function_call", "function_call_output", "function_call", "function_call_output",
  ]);
  assert.equal(continuation.input[3].call_id, "cart-current");
  assert.deepEqual(continuation.input[4], terminal);
  assert.equal(continuation.input[5].call_id, "terminal-current");
  assert.match(continuation.input[5].output, /"displayed":true/);
  assert.doesNotMatch(JSON.stringify(continuation), /Obsolete pre-compaction/);
  assert.equal(executions.length, 1);
  assert.deepEqual(env.calls.requests[0].input.context_management, [{ type: "compaction", compact_threshold: 24000 }]);
  assert.equal(env.calls.requests[0].input.store, false);
  assert.equal(env.calls.requests.length, 2);
});

test("matching saved compaction uses only subsequent history plus current private and application references", async () => {
  const env = setup();
  const compact = { type: "compaction", encrypted_content: "PRIMARY_SAVED" };
  const memory = {
    memo: { "kitchen/blind": "Width corrected to 102 cm. Source 11." }, throughSequence: 12,
    checkpoints: [{ model: "gpt-6-luna", throughSequence: 10, input: [compact] }],
  };
  env.streams.push(events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null })] })));
  await memoryReply(env, { memory, history: [
    { role: "user", text: "OLD_WIDTH_100", sequence: 3, endSequence: 3 },
    { role: "user", text: "Actually 102 cm.", sequence: 11, endSequence: 11 },
    { role: "user", source: "memory", text: "STALE_PRIVATE_NOTE" },
    { role: "user", source: "application_state", text: "CURRENT_PRODUCT_CONFIGURATION" },
  ] });
  const input = env.calls.requests[0].input.input;
  assert.deepEqual(input.find((item) => item.type === "compaction"), compact);
  assert.match(JSON.stringify(input), /Actually 102 cm|Width corrected to 102 cm/);
  assert.equal(input.at(-1).content, "CURRENT_PRODUCT_CONFIGURATION");
  assert.doesNotMatch(JSON.stringify(input), /OLD_WIDTH_100|STALE_PRIVATE_NOTE/);
});

test("an output-budget retry discards incomplete compaction and memory patches while retaining the saved checkpoint", async () => {
  const env = setup(), visible = [];
  const compact = { type: "compaction", encrypted_content: "SAVED_COMPLETE_CHECKPOINT" };
  const memory = {
    memo: { "kitchen/blind": "Width corrected to 102 cm. Source 11." },
    throughSequence: 12,
    checkpoints: [{ model: "gpt-6-luna", throughSequence: 10, input: [compact] }],
  };
  const originalMemory = plain(memory);
  const incomplete = incompleteAnswer("max_output_tokens");
  incomplete.response.output = [
    { type: "compaction", id: "PRIVATE_INCOMPLETE_COMPACTION", encrypted_content: "PRIVATE_INCOMPLETE_CHECKPOINT" },
    { type: "reasoning", id: "PRIVATE_INCOMPLETE_REASONING", summary: [], encrypted_content: "PRIVATE_INCOMPLETE_STATE" },
    questionCall({
      ...questionSelection,
      message: "PRIVATE_INCOMPLETE_ANSWER",
      memoryUpdate: {
        set: [{ key: "kitchen/curtain", text: "PRIVATE_INCOMPLETE_NOTE" }],
        forget: ["kitchen/blind"],
      },
    }, "PRIVATE_INCOMPLETE_QUESTION"),
  ];
  env.streams.push(
    events(incomplete),
    events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null }, "complete-answer")] })),
  );
  const reply = await memoryReply(env, {
    memory,
    history: [
      { role: "user", text: "Actually 102 cm.", sequence: 11, endSequence: 11 },
      { role: "user", text: "Long durable conversation. ".repeat(1000), sequence: 12, endSequence: 12 },
    ],
    onText: (text) => visible.push(text),
    execute: async () => assert.fail("Incomplete output must not execute tools"),
  });
  assert.equal(env.calls.requests.length, 2);
  const initial = env.calls.requests[0].input;
  const retry = env.calls.requests[1].input;
  assert.equal(initial.max_output_tokens, 8192);
  assert.deepEqual(initial.context_management, [{ type: "compaction", compact_threshold: 24000 }]);
  assert.deepEqual(retry, { ...initial, max_output_tokens: 16384 });
  assert.deepEqual(retry.input.filter((item) => item.type === "compaction"), [compact]);
  assert.match(JSON.stringify(retry.input), /Actually 102 cm|Width corrected to 102 cm/);
  assert.deepEqual(memory, originalMemory);
  assert.equal(reply.contextCheckpoint, undefined);
  assert.equal(reply.memoryUpdate, undefined);
  assert.equal(reply.questionPresentation.callId, "complete-answer");
  assert.deepEqual(visible, [reply.text]);
  assert.doesNotMatch(JSON.stringify([retry, reply, visible]), /PRIVATE_INCOMPLETE/);
});

test("fallback preserves calls before a compaction item without foreign encrypted context or repeated execution", async () => {
  for (const savedFallback of [false, true]) {
    const env = setup(), executions = [];
    const call = catalogCall("confirmed-before-compaction", "show_view", { view: "cart" });
    const primary = { type: "compaction", encrypted_content: "FOREIGN_PRIMARY_COMPACTION" };
    const fallback = { type: "compaction", encrypted_content: "OWN_FALLBACK_COMPACTION" };
    env.streams.push(
      events(completed("", { output: [
        { type: "reasoning", id: "primary-reason", summary: [], encrypted_content: "FOREIGN_PRIMARY_REASONING" },
        call, primary,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "POST_COMPACTION_REFERENCE" }] },
      ] })),
      events({ type: "response.failed", response: { model: "gpt-6-luna", output: [], error: { code: "server_error", message: "Unavailable" } } }),
      events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null })] })),
    );
    const memory = {
      memo: { "kitchen/curtain": "Return to curtains." }, throughSequence: 11,
      checkpoints: [
        { model: "gpt-6-luna", throughSequence: 10, input: [{ type: "compaction", encrypted_content: "FOREIGN_SAVED_PRIMARY" }] },
        ...(savedFallback ? [{ model: "gpt-5.6-luna", throughSequence: 2, input: [fallback] }] : []),
      ],
    };
    await memoryReply(env, {
      memory, history: [
        { role: "user", text: "RAW_OLD_REQUEST", sequence: 1, endSequence: 1 },
        { role: "user", text: "Show the cart.", sequence: 11, endSequence: 11 },
        { role: "user", source: "application_state", text: "CURRENT_APPLICATION_FACTS" },
      ],
      execute: async (...args) => { executions.push(args); return { status: "shown", view: "cart" }; },
    });
    assert.equal(executions.length, 1, "confirmed storefront work is never replayed");
    const request = env.calls.requests[2].input;
    assert.equal(request.model, "gpt-5.6-luna");
    assert.doesNotMatch(JSON.stringify(request.input), /FOREIGN_/);
    assert.equal(request.input.filter((item) => item.type === "function_call" && item.call_id === call.call_id).length, 1);
    assert.equal(request.input.filter((item) => item.type === "function_call_output" && item.call_id === call.call_id).length, 1);
    assert.match(JSON.stringify(request.input), /Return to curtains|CURRENT_APPLICATION_FACTS|POST_COMPACTION_REFERENCE/);
    assert.equal(JSON.stringify(request.input).includes("OWN_FALLBACK_COMPACTION"), savedFallback);
    assert.equal(JSON.stringify(request.input).includes("RAW_OLD_REQUEST"), !savedFallback);
    assert.equal(env.calls.requests.length, 3);
  }
});

test("two historical reads leave all four ordinary storefront calls available", async () => {
  const env = setup(), recalls = [], executions = [];
  for (let index = 0; index < 2; index++)
    env.streams.push(events(completed("", { output: [catalogCall(`history-${index}`, "recall_history", { query: "kitchen", beforeSequence: index ? 10 : null })] })));
  for (let index = 0; index < 4; index++)
    env.streams.push(events(completed("", { output: [catalogCall(`cart-${index}`, "get_cart", {})] })));
  env.streams.push(events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null })] })));
  await memoryReply(env, {
    recall: async (input) => { recalls.push(input); return { referenceOnly: true, entries: [{ source: "message:8", sequence: 8, text: "Kitchen curtain pending." }] }; },
    execute: async (...args) => { executions.push(args); return { status: "ready", itemCount: 0 }; },
  });
  assert.equal(recalls.length, 2);
  assert.equal(executions.length, 4);
  assert.equal(env.calls.requests.length, 7);
  assert.ok(allowedToolNames(env.calls.requests[1].input).includes("recall_history"));
  assert.ok(!allowedToolNames(env.calls.requests[2].input).includes("recall_history"));
  assert.ok(allowedToolNames(env.calls.requests[5].input).includes("get_cart"));
  assert.ok(!allowedToolNames(env.calls.requests[6].input).includes("get_cart"));
  assert.match(env.calls.requests[1].input.input.find((item) => item.type === "function_call_output" && item.call_id === "history-0").output, /message:8/);
});

test("an unsolicited third historical read is rejected before retrieval", async () => {
  const env = setup();
  let reads = 0;
  for (let index = 0; index < 3; index++)
    env.streams.push(events(completed("", { output: [catalogCall(`history-${index}`, "recall_history", { query: "", beforeSequence: null })] })));
  await assert.rejects(memoryReply(env, {
    recall: async () => { reads++; return { referenceOnly: true, entries: [] }; },
  }), /history retrieval budget/);
  assert.equal(reads, 2);
  assert.equal(env.calls.requests.length, 3);
  assert.equal(env.calls.browserTools.length, 0);
});

test("guide PDFs alone do not trigger compaction while long durable guide conversations can compact", async () => {
  for (const longHistory of [false, true]) {
    const env = setup();
    env.mock.readGuides = async () => ({
      status: "ready", sources: guideResult(["measuring"]).guides,
      files: [{ ...syntheticGuideFile("measuring"), file_data: "data:application/pdf;base64," + Buffer.from("%PDF-1.7\n" + "synthetic-content ".repeat(4000) + "\n%%EOF").toString("base64") }],
    });
    env.streams.push(
      events(completed("", { output: [guideLookup("guide-size-gate", ["measuring"])] })),
      events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null })] })),
    );
    await memoryReply(env, {
      history: [{ role: "user", text: longHistory ? "Long durable history. ".repeat(1500) : "Help me measure." }],
      execute: async () => guideResult(["measuring"]),
    });
    assert.equal(guideFiles(env.calls.requests[1].input).length, 1);
    assert.ok(guideFiles(env.calls.requests[1].input)[0].file_data.length > 60000);
    for (const request of env.calls.requests)
      assert.equal(!!request.input.context_management, longHistory);
  }
});

test("model-specific history loads only when needed and is reused across that model's tool rounds", async () => {
  const env = setup(), loaded = [];
  env.streams.push(
    events(completed("", { output: [catalogCall("primary-cart", "get_cart", {})] })),
    events({ type: "response.failed", response: { model: "gpt-6-luna", output: [], error: { code: "server_error", message: "Unavailable" } } }),
    events(completed("", { output: [catalogCall("fallback-cart", "get_cart", {})] })),
    events(completed("", { output: [questionCall({ ...questionSelection, memoryUpdate: null })] })),
  );
  await memoryReply(env, {
    history: [{ role: "user", text: "UNBOUNDED_INITIAL_HISTORY_MUST_NOT_BE_USED" }],
    memory: {
      memo: {}, throughSequence: 21, checkpoints: [],
      historyForModel: async (model) => {
        loaded.push(model);
        return [{ role: "user", text: model === "gpt-6-luna" ? "PRIMARY_SUFFIX" : "FALLBACK_RAW_HISTORY", sequence: 20, endSequence: 20 }];
      },
    },
    execute: async () => ({ status: "ready", itemCount: 0 }),
  });
  assert.deepEqual(loaded, ["gpt-6-luna", "gpt-5.6-luna"]);
  assert.equal(env.calls.requests.length, 4);
  for (const [index, request] of env.calls.requests.entries()) {
    const serialized = JSON.stringify(request.input.input);
    assert.doesNotMatch(serialized, /UNBOUNDED_INITIAL_HISTORY/);
    assert.equal(serialized.includes("PRIMARY_SUFFIX"), index < 2);
    assert.equal(serialized.includes("FALLBACK_RAW_HISTORY"), index >= 2);
  }
});
