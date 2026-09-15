import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/conversations/browser-tools.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "tool-repository-boundary",
      setup(build) {
        build.onResolve({ filter: /repository\.server$/ }, (args) => ({
          path: args.path,
          namespace: "repository-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "repository-stub" }, () => ({
          contents: `
        export const createToolInvocation=(...args)=>mock.create(...args);
        export const completeToolInvocation=(...args)=>mock.complete(...args);
        export const failToolInvocation=(...args)=>mock.fail(...args);
        export const getConversationOrigin=(...args)=>mock.origin(...args);
      `,
        }));
      },
    },
  ],
});

const origin = "https://hd-dev-multi.myshopify.com";
const claim = {
  clientId: "4a90c250-6a6c-4165-8728-0b5028ea3ffd",
  claimToken: "test-claim-token",
};
const product = {
  id: "gid://shopify/Product/123",
  title: "Current catalog shade",
  description: "Current details",
  url: `${origin}/products/shade`,
  imageUrl: "https://cdn.shopify.com/shade.jpg",
  priceLabel: "From USD 62.99",
};
const result = { products: [product], messages: [] };
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const calls = { create: [], complete: [], fail: [], origin: [] };
  const deadlines = [];
  let sequence = 0;
  const mock = {
    beforeCreate: undefined,
    beforeComplete: undefined,
    create: async (...args) => {
      calls.create.push(args);
      await mock.beforeCreate?.(...args);
      return { id: `invocation-${++sequence}` };
    },
    complete: async (...args) => {
      calls.complete.push(args);
      await mock.beforeComplete?.(...args);
    },
    fail: async (...args) => {
      calls.fail.push(args);
    },
    origin: async (...args) => {
      calls.origin.push(args);
      return origin;
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    mock,
    URL,
    Intl,
    AbortSignal: {
      any: (signals) => AbortSignal.any(signals),
      timeout: (milliseconds) => {
        const controller = new AbortController();
        deadlines.push({ milliseconds, controller });
        return controller.signal;
      },
    },
  });
  return { api: module.exports, mock, calls, deadlines };
}

function request(env, signal = new AbortController().signal) {
  return env.api.requestBrowserTool(
    "conversation-1",
    "assistant-1",
    "provider-call-1",
    "search_products",
    { query: " no drill " },
    signal,
  );
}

test("browser result reaches its waiter only after durable IDs-only completion", async () => {
  const env = setup();
  const gate = deferred();
  env.mock.beforeComplete = () => gate.promise;
  let resolved = false;
  const pending = request(env).then((value) => {
    resolved = true;
    return value;
  });
  await flush();
  assert.deepEqual(plain(env.calls.create[0]), [
    "conversation-1",
    "assistant-1",
    {
      providerCallId: "provider-call-1",
      name: "search_products",
      arguments: { query: "no drill" },
    },
  ]);
  const submission = env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  await flush();
  assert.equal(resolved, false);
  assert.deepEqual(plain(env.calls.complete[0]), [
    "conversation-1",
    "invocation-1",
    claim,
    { productIds: [product.id] },
  ]);
  assert.doesNotMatch(
    JSON.stringify(env.calls.complete),
    /Current catalog shade|Current details|imageUrl|priceLabel|cdn.shopify.com/,
  );
  gate.resolve();
  await submission;
  assert.deepEqual(plain(await pending), result);
  assert.equal(env.deadlines[0].milliseconds, 45000);
  assert.deepEqual(env.calls.fail, []);
});

test("invalid projected data cannot complete a tool or release a waiting model", async () => {
  const env = setup();
  const pending = request(env);
  await flush();
  for (const invalid of [
    { ...result, token: "UNEXPECTED_PRIVATE_FIELD" },
    {
      ...result,
      products: [
        { ...product, url: "https://attacker.example/products/shade" },
      ],
    },
    {
      ...result,
      products: [
        { ...product, imageUrl: "https://attacker.example/image.jpg" },
      ],
    },
    { products: Array(11).fill(product), messages: [] },
  ])
    await assert.rejects(
      env.api.submitBrowserToolResult(
        "conversation-1",
        "invocation-1",
        claim,
        invalid,
      ),
      { status: 400 },
    );
  assert.equal(env.calls.complete.length, 0);
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  assert.deepEqual(plain(await pending), result);
});

test("a rejected claim or persistence failure does not release the waiter", async () => {
  const env = setup();
  let resolved = false;
  const pending = request(env).then((value) => {
    resolved = true;
    return value;
  });
  await flush();
  const rejection = Object.assign(
    new Error("Claim is not owned by this tab."),
    { status: 409 },
  );
  env.mock.beforeComplete = async (...args) => {
    assert.equal(args[2].claimToken, "wrong-claim");
    throw rejection;
  };
  await assert.rejects(
    env.api.submitBrowserToolResult(
      "conversation-1",
      "invocation-1",
      { ...claim, claimToken: "wrong-claim" },
      result,
    ),
    { status: 409 },
  );
  await flush();
  assert.equal(resolved, false);
  env.mock.beforeComplete = undefined;
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  assert.deepEqual(plain(await pending), result);
});

test("the browser can report a bounded lookup failure without fabricating products", async () => {
  const env = setup();
  const pending = request(env);
  await flush();
  for (const error of ["", " ", "x".repeat(501), 42]) {
    await assert.rejects(
      env.api.submitBrowserToolResult(
        "conversation-1",
        "invocation-1",
        claim,
        undefined,
        error,
      ),
      { status: 400 },
    );
  }
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    undefined,
    "The storefront catalog is unavailable.",
  );
  assert.deepEqual(plain(await pending), {
    error: "The storefront catalog is unavailable.",
  });
  assert.deepEqual(plain(env.calls.complete[0][3]), {
    productIds: [],
    error: "The storefront catalog is unavailable.",
  });
});

test("unrelated invocation completion never resolves the active waiter", async () => {
  const env = setup();
  let resolved = false;
  const pending = request(env).then((value) => {
    resolved = true;
    return value;
  });
  await flush();
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "different-invocation",
    claim,
    result,
  );
  await flush();
  assert.equal(resolved, false);
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  await pending;
});

test("lookup deadlines and End aborts fail durable work and release the conversation slot", async () => {
  for (const cause of ["deadline", "end"]) {
    const env = setup();
    const controller = new AbortController();
    const pending = request(env, controller.signal);
    const rejected = assert.rejects(pending, /lookup did not finish/);
    await flush();
    await assert.rejects(request(env), /already running/);
    if (cause === "deadline") env.deadlines[0].controller.abort();
    else controller.abort();
    await rejected;
    assert.deepEqual(plain(env.calls.fail), [
      [
        "conversation-1",
        "invocation-1",
        "The storefront lookup was interrupted or timed out.",
      ],
    ]);
    const next = request(env);
    await flush();
    await env.api.submitBrowserToolResult(
      "conversation-1",
      "invocation-2",
      claim,
      result,
    );
    await next;
    env.deadlines.at(-1).controller.abort();
    await flush();
    assert.equal(
      env.calls.fail.length,
      1,
      "completed work is no longer attached to the deadline",
    );
  }
});

test("aborted or invalid calls never create a durable invocation", async () => {
  const env = setup();
  const controller = new AbortController();
  controller.abort(new Error("Conversation ended"));
  await assert.rejects(request(env, controller.signal), /Conversation ended/);
  await assert.rejects(
    env.api.requestBrowserTool(
      "conversation-1",
      "assistant-1",
      "provider-call-1",
      "clear_cart",
      {},
      new AbortController().signal,
    ),
    /not supported/,
  );
  assert.deepEqual(env.calls.create, []);
});

test("abort during durable invocation creation still fails and cleans up the created row", async () => {
  const env = setup();
  const gate = deferred();
  const controller = new AbortController();
  env.mock.beforeCreate = () => gate.promise;
  const pending = request(env, controller.signal);
  const rejected = assert.rejects(pending, /lookup did not finish/);
  controller.abort();
  gate.resolve();
  await rejected;
  assert.equal(env.calls.fail.length, 1);
  assert.equal(env.calls.fail[0][1], "invocation-1");
});
