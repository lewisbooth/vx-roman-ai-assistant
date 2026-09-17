import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/conversations/model.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "model-api",
      setup(build) {
        build.onResolve({ filter: /^openai$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export default class OpenAI { constructor() { this.responses={create:(...args)=>mock.create(...args)}; } }`,
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
      type: "message",
      content: [{ type: "output_text", text: "Synthetic reply." }],
    },
  ],
) => ({
  type: `response.${status}`,
  response: {
    model: "gpt-5.6-luna-observed",
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
function setup(scripts) {
  const records = [];
  const requests = [];
  const controller = new AbortController();
  const mock = {
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
  });
  const record = async (value) => records.push(plain(value));
  return {
    records,
    requests,
    controller,
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
        r.model === "gpt-5.6-luna-observed" && r.serviceTier === "priority",
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

test("ordinary text and voice replies receive next-action choices without another provider round", async () => {
  const replies = [];
  for (const mode of ["text", "voice"]) {
    const app = setup([events(terminal())]);
    const reply = plain(await app.run(undefined, { mode }));
    replies.push(reply);
    assert.equal(app.requests.length, 1);
    assert.deepEqual(
      app.records.map((usage) => usage.status),
      ["pending", "completed"],
    );
    assert.equal(app.records.at(-1).totalTokens, 15);
    assert.match(
      reply.questionPresentation.callId,
      /^next-actions-[0-9a-f-]{36}$/,
    );
    assert.deepEqual(reply.questionPresentation.answers, [
      "Help me measure",
      "Explore products",
      "Find my style",
    ]);
    assert.equal(
      reply.questionPresentation.question,
      "What would you like to do next?",
    );
    assert.equal(
      reply.text,
      mode === "text"
        ? "Synthetic reply."
        : "Synthetic reply. What would you like to do next?",
    );
    assert.equal(reply.model, "gpt-5.6-luna-observed");
    assert.equal(reply.serviceTier, "priority");
  }
  assert.notEqual(
    replies[0].questionPresentation.callId,
    replies[1].questionPresentation.callId,
  );
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
            arguments: JSON.stringify(question),
          },
        ]),
      ),
      events(
        terminal("completed", tokens(25, 7), [
          {
            type: "message",
            content: [{ type: "output_text", text: overview }],
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
    assert.equal(app.requests.length, 2);
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

test("saved-question resume failure retains its neutral limitation without inventing another question", async () => {
  const resumeQuestion = {
    type: "question",
    version: 1,
    invocationId: "saved-question",
    question: "Which room are you measuring?",
    answers: ["Kitchen", "Bedroom"],
  };
  const app = setup([events(terminal())]);
  const reply = plain(
    await app.run(undefined, { mode: "voice", resumeQuestion }),
  );
  assert.match(reply.text, /saved question could not be safely restored/);
  assert.equal(reply.questionPresentation, undefined);
  assert.doesNotMatch(reply.text, /What would you like to do next/);
  assert.equal(app.requests.length, 1);
  assert.equal(app.records.at(-1).totalTokens, 15);
});

test("unreadable guide recovery keeps its safe choices rather than general measuring actions", async () => {
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
  assert.match(reply.text, /couldn't read the product's official guides/);
  assert.match(reply.questionPresentation.callId, /^guide-recovery-/);
  assert.deepEqual(reply.questionPresentation.answers, [
    "Explore other colours",
    "Find another product",
  ]);
  assert.equal(app.requests.length, 1);
  assert.equal(app.records.at(-1).totalTokens, 25);
});
