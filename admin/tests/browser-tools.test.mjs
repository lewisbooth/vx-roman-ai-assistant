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
        build.onResolve(
          { filter: /repository\.server$|measurements\/service\.server$/ },
          (args) => ({
            path: args.path,
            namespace: "repository-stub",
          }),
        );
        build.onLoad(
          { filter: /.*/, namespace: "repository-stub" },
          (args) => ({
            contents: args.path.includes("measurements")
              ? `export const getMeasurementDraft=(...args)=>mock.measurementDraft(...args);`
              : `
        export const createToolInvocation=(...args)=>mock.create(...args);
        export const completeToolInvocation=(...args)=>mock.complete(...args);
        export const failToolInvocation=(...args)=>mock.fail(...args);
        export const getBrowserToolContext=(...args)=>mock.context(...args);
        export const claimToolInvocation=(...args)=>mock.claim(...args);
      `,
          }),
        );
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
  const calls = { create: [], complete: [], fail: [], context: [] };
  const deadlines = [];
  let sequence = 0;
  const mock = {
    measurementDraft: async () => null,
    claim: async () => ({ claimed: true }),
    beforeCreate: undefined,
    beforeComplete: undefined,
    beforeFail: undefined,
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
      return await mock.beforeFail?.(...args);
    },
    context: async (...args) => {
      calls.context.push(args);
      return {
        origin,
        name: mock.toolName ?? "search_products",
        arguments: mock.toolArguments ?? {},
      };
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

test("guide lookup preserves only verified current-product links and releases after durable completion", async () => {
  const env = setup();
  env.mock.toolName = "get_product_guides";
  env.mock.toolArguments = { productPath: "/products/shade" };
  const gate = deferred();
  env.mock.beforeComplete = () => gate.promise;
  let resolved = false;
  const pending = env.api
    .requestBrowserTool(
      "conversation-1",
      "assistant-1",
      "guide-call",
      "get_product_guides",
      env.mock.toolArguments,
      new AbortController().signal,
    )
    .then((value) => {
      resolved = true;
      return value;
    });
  await flush();
  assert.deepEqual(plain(env.calls.create[0][2]), {
    providerCallId: "guide-call",
    name: "get_product_guides",
    arguments: env.mock.toolArguments,
  });
  const guide = {
    kind: "measuring",
    url: `${origin}/cdn/shop/files/Shade_Measuring.pdf?v=123456`,
  };
  const result = {
    status: "found",
    productPath: "/products/shade",
    guides: [guide],
  };
  for (const invalid of [
    { ...result, productPath: "/products/other" },
    {
      ...result,
      guides: [
        {
          ...guide,
          url: "https://other-store.myshopify.com/cdn/shop/files/Measuring.pdf",
        },
      ],
    },
    {
      ...result,
      guides: [
        {
          ...guide,
          url: `${origin}/cdn/shop/files/Measuring.pdf?download=true`,
        },
      ],
    },
    {
      ...result,
      guides: [{ ...guide, url: `${origin}/cdn/shop/files/Measuring.html` }],
    },
    { ...result, instructions: "Unverified PDF instructions" },
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
  const submission = env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  await flush();
  assert.equal(resolved, false);
  assert.deepEqual(plain(env.calls.complete[0][3]), {
    productIds: [],
    outcome: result,
  });
  gate.resolve();
  await submission;
  assert.deepEqual(plain(await pending), result);
});

test("unavailable current-product guides are an explicit empty result, not an invented guide", async () => {
  const env = setup();
  env.mock.toolName = "get_product_guides";
  env.mock.toolArguments = { productPath: "/products/shade" };
  const pending = env.api.requestBrowserTool(
    "conversation-1",
    "assistant-1",
    "guide-call",
    "get_product_guides",
    env.mock.toolArguments,
    new AbortController().signal,
  );
  await flush();
  const result = {
    status: "unavailable",
    productPath: "/products/shade",
    guides: [],
  };
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  assert.deepEqual(plain(await pending), result);
  assert.deepEqual(plain(env.calls.complete[0][3]), {
    productIds: [],
    outcome: result,
  });
});

test("declined cart approval reaches the model only after its durable decision", async () => {
  const env = setup();
  const gate = deferred();
  const outcome = {
    status: "cancelled",
    message: "The shopper declined this change.",
  };
  env.mock.claim = async () => {
    await gate.promise;
    return { claimed: false, outcome };
  };
  let resolved = false;
  const pending = env.api
    .requestBrowserTool(
      "conversation-1",
      "assistant-1",
      "call-1",
      "clear_cart",
      {},
      new AbortController().signal,
    )
    .then((value) => {
      resolved = true;
      return value;
    });
  await flush();
  const decision = env.api.claimBrowserTool("conversation-1", "invocation-1", {
    ...claim,
    confirmed: false,
  });
  await flush();
  assert.equal(resolved, false);
  gate.resolve();
  assert.deepEqual(plain(await decision), { claimed: false });
  assert.deepEqual(plain(await pending), outcome);
  assert.equal(env.calls.complete.length, 0);
});

test("confirmed addition facts reach the model only after durable completion", async () => {
  const env = setup();
  env.mock.toolName = "add_to_cart";
  env.mock.toolArguments = { productPath: "/products/shade" };
  const gate = deferred();
  env.mock.beforeComplete = () => gate.promise;
  let resolved = false;
  const pending = env.api
    .requestBrowserTool(
      "conversation-1",
      "assistant-1",
      "add-call",
      "add_to_cart",
      env.mock.toolArguments,
      new AbortController().signal,
    )
    .then((value) => {
      resolved = true;
      return value;
    });
  await flush();
  const result = {
    status: "added",
    message: "The theme confirmed this addition.",
    addedProduct: {
      productPath: "/products/shade",
      title: "Configured shade",
      measurements: { width: 18.125, height: 36.5, unit: "in" },
    },
  };
  await assert.rejects(
    env.api.submitBrowserToolResult("conversation-1", "invocation-1", claim, {
      ...result,
      addedProduct: {
        ...result.addedProduct,
        privateProperties: { email: "private@example.test" },
      },
    }),
    { status: 400 },
  );
  assert.equal(env.calls.complete.length, 0);
  const submission = env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  await flush();
  assert.equal(resolved, false);
  assert.deepEqual(plain(env.calls.complete[0][3]), {
    productIds: [],
    outcome: result,
  });
  gate.resolve();
  await submission;
  assert.deepEqual(plain(await pending), result);
});

test("cart timeout returns the persisted uncertain outcome without another operation", async () => {
  const env = setup();
  const outcome = {
    status: "uncertain",
    message: "Check the cart; this must not be replayed.",
  };
  env.mock.beforeFail = async () => outcome;
  const pending = env.api.requestBrowserTool(
    "conversation-1",
    "assistant-1",
    "call-1",
    "clear_cart",
    {},
    new AbortController().signal,
  );
  await flush();
  env.deadlines[0].controller.abort();
  assert.deepEqual(plain(await pending), outcome);
  assert.equal(env.calls.create.length, 1);
  assert.equal(env.calls.fail.length, 1);
});

test("applying measurements resolves a saved order draft before exposing the browser command", async () => {
  const env = setup();
  const draft = {
    productPath: "/products/shade",
    width: 300,
    height: 400,
    unit: "mm",
    kind: "order",
    mount: "recess",
    updatedAt: "2026-09-15T10:00:00.000Z",
  };
  const makeRequest = (args = { productPath: draft.productPath }) =>
    env.api.requestBrowserTool(
      "conversation-1",
      "assistant-1",
      "call-1",
      "apply_measurements",
      args,
      new AbortController().signal,
    );
  await assert.rejects(makeRequest(), /Save explicit order dimensions/);
  env.mock.measurementDraft = async () => ({ ...draft, kind: "window" });
  await assert.rejects(makeRequest(), /saved order dimensions/);
  await assert.rejects(
    makeRequest({ productPath: draft.productPath, draft }),
    /Supply positive/,
  );
  assert.equal(env.calls.create.length, 0);
  env.mock.measurementDraft = async () => draft;
  env.mock.toolName = "apply_measurements";
  env.mock.toolArguments = { productPath: draft.productPath, draft };
  const pending = makeRequest();
  await flush();
  assert.deepEqual(
    plain(env.calls.create[0][2].arguments),
    env.mock.toolArguments,
  );
  const result = {
    status: "applied",
    productPath: draft.productPath,
    draftUpdatedAt: draft.updatedAt,
    message: "Dimensions filled; review the form.",
  };
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  assert.deepEqual(plain(await pending), result);
  assert.deepEqual(plain(env.calls.complete[0][3]), {
    productIds: [],
    outcome: result,
  });
});

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
    const rejected = assert.rejects(pending, /action did not finish/);
    await flush();
    await assert.rejects(request(env), /already running/);
    if (cause === "deadline") env.deadlines[0].controller.abort();
    else controller.abort();
    await rejected;
    assert.deepEqual(plain(env.calls.fail), [
      [
        "conversation-1",
        "invocation-1",
        "The storefront action was interrupted or timed out.",
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
      "checkout",
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
  const rejected = assert.rejects(pending, /action did not finish/);
  controller.abort();
  gate.resolve();
  await rejected;
  assert.equal(env.calls.fail.length, 1);
  assert.equal(env.calls.fail[0][1], "invocation-1");
});

test("navigation validates its own result against the stored tool and releases after persistence", async () => {
  const env = setup();
  env.mock.toolName = "navigate";
  const pending = env.api.requestBrowserTool(
    "conversation-1",
    "assistant-1",
    "navigation-1",
    "navigate",
    { path: "/products/shade?variant=123#details" },
    new AbortController().signal,
  );
  await flush();
  for (const invalid of [
    result,
    { status: "navigated", path: "https://attacker.example/" },
    { status: "navigated", path: "//attacker.example/" },
    { status: "navigated", path: "/cart", extra: true },
    { status: "pending", path: "/cart" },
  ]) {
    await assert.rejects(
      env.api.submitBrowserToolResult(
        "conversation-1",
        "invocation-1",
        claim,
        invalid,
      ),
      { status: 400 },
    );
  }
  assert.equal(env.calls.complete.length, 0);
  const navigation = {
    status: "navigated",
    path: "/products/shade?variant=123#details",
  };
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    navigation,
  );
  assert.deepEqual(plain(await pending), navigation);
  assert.deepEqual(plain(env.calls.complete[0][3]), { productIds: [] });
  assert.deepEqual(plain(env.calls.context[0]), [
    "conversation-1",
    "invocation-1",
  ]);
});

test("a browser cannot submit a navigation result for a catalog invocation", async () => {
  const env = setup();
  await assert.rejects(
    env.api.submitBrowserToolResult("conversation-1", "invocation-1", claim, {
      status: "navigated",
      path: "/cart",
    }),
    { status: 400 },
  );
  assert.equal(env.calls.complete.length, 0);
});

test("a waiter owns the conversation while durable creation is pending, including after cancellation", async () => {
  const env = setup();
  const gate = deferred();
  const controller = new AbortController();
  env.mock.beforeCreate = () => gate.promise;
  const old = request(env, controller.signal);
  const rejected = assert.rejects(old, /action did not finish/);
  await flush();
  await assert.rejects(request(env), /already running/);
  controller.abort();
  await assert.rejects(request(env), /already running/);
  assert.equal(
    env.calls.create.length,
    1,
    "No replacement invocation is created while an old DB operation can still return",
  );
  gate.resolve();
  await rejected;
  assert.equal(env.calls.fail[0][1], "invocation-1");
  env.mock.beforeCreate = undefined;
  const next = request(env);
  await flush();
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-2",
    claim,
    result,
  );
  assert.deepEqual(plain(await next), result);
});

test("cancelled durable cleanup keeps its slot until complete and late results cannot release its replacement", async () => {
  const env = setup();
  const cleanup = deferred();
  env.mock.beforeFail = () => cleanup.promise;
  const controller = new AbortController();
  const old = request(env, controller.signal);
  const rejected = assert.rejects(old, /action did not finish/);
  await flush();
  controller.abort();
  await flush();
  await assert.rejects(request(env), /already running/);
  cleanup.resolve();
  await rejected;
  let resolved = false;
  const next = request(env).then((value) => {
    resolved = true;
    return value;
  });
  await flush();
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  await flush();
  assert.equal(
    resolved,
    false,
    "A late result for the cancelled action cannot resolve the new waiter",
  );
  await assert.rejects(request(env), /already running/);
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-2",
    claim,
    result,
  );
  assert.deepEqual(plain(await next), result);
  assert.equal(env.calls.fail.length, 1);
});

test("a failed durable creation releases its reservation without failing an unrelated row", async () => {
  const env = setup();
  env.mock.beforeCreate = async () => {
    throw new Error("Database create failed");
  };
  await assert.rejects(request(env), /Database create failed/);
  assert.equal(env.calls.fail.length, 0);
  env.mock.beforeCreate = undefined;
  const next = request(env);
  await flush();
  await env.api.submitBrowserToolResult(
    "conversation-1",
    "invocation-1",
    claim,
    result,
  );
  assert.deepEqual(plain(await next), result);
});
