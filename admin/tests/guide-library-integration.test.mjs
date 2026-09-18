import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * from "./admin/conversations/model.server.ts"; export * from "./admin/guides/library.server.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "mock-provider-only",
      setup(build) {
        build.onResolve({ filter: /^openai$/ }, () => ({
          path: "openai",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `export default class OpenAI { constructor() { this.responses = { create: (...args) => mock.response(...args) }; } }`,
        }));
      },
    },
  ],
});
const runnerBundle = await build({
  stdin: {
    contents: `export * from "./admin/conversations/runner.server.ts"; export * from "./admin/guides/library.server.ts";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "runner-lifecycle-boundaries",
      setup(build) {
        build.onResolve(
          { filter: /(?:model|repository|browser-tools|service)\.server$/ },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("model.server")
            ? `export const TEXT_MODEL="gpt-5.6-terra"; export const generateReply=(...args)=>mock.generate(...args);`
            : path.endsWith("browser-tools.server")
              ? `export const requestBrowserTool=()=>{throw new Error("Unexpected browser call")};`
              : path.endsWith("service.server")
                ? `export const executeMeasurementTool=()=>{throw new Error("Unexpected measurement call")};`
                : path.includes("usage")
                  ? `export const recordModelUsage=()=>{};`
                  : `export const beginTurn=(...args)=>mock.begin(...args);
         export const getSnapshot=(...args)=>mock.snapshot(...args);
         export const finishTurn=(...args)=>mock.finish(...args);
         export const failPending=()=>{};
         export const getReadRevision=()=>0;
         export const endConversation=(...args)=>mock.end(...args);`,
        }));
      },
    },
  ],
});
const origin = "https://hd-dev-single.myshopify.com";
const productPath = "/products/synthetic-roller";
const sectionId = `s_${"a".repeat(24)}`;
const guideId = (number) => `g_${number.toString(16).padStart(24, "0")}`;
const library = () => ({
  library: "blinds",
  pagePath: "/pages/measuring-blinds",
  title: "Measuring blinds",
  sections: [
    {
      id: sectionId,
      title: "Angled bay windows",
      text: "Synthetic native method with product-specific conditions.",
    },
  ],
  guides: [1, 2].map((id) => ({
    id: guideId(id),
    title: id === 1 ? "Roller guide" : "Angled bay guide",
    section: sectionId,
    url: `${origin}/cdn/shop/files/guide-${id}.pdf?v=1`,
  })),
  diagramNotice:
    "Diagrams and videos were not interpreted; do not infer instructions that depend on them.",
});
const measurement = () => ({
  question: "What is the width?",
  instructions: "Follow the verified synthetic guide's width method.",
  productPath,
  label: "Width",
  unit: "mm",
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const call = (name, args, callId = `call_${randomUUID()}`) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: callId,
});
const message = (text) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});
const files = (request) =>
  request.input
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === "input_file");
const outputs = (request) =>
  request.input
    .filter((item) => item.type === "function_call_output")
    .map((item) => JSON.parse(item.output));

function setup() {
  const module = { exports: {} };
  const requests = [],
    browser = [],
    downloads = [],
    usage = [],
    activity = [];
  let plans = [];
  let productGuides = { status: "unavailable", productPath, guides: [] };
  let currentPage = { productPath, pageId: randomUUID() };
  let assistantId = randomUUID();
  const id = randomUUID();
  const mock = {
    download: async (url) =>
      new Response(Buffer.from(`%PDF-1.7\nSynthetic ${url}\n%%EOF`), {
        headers: { "content-type": "application/pdf" },
      }),
    response: async (request, options) => {
      options.signal.throwIfAborted();
      requests.push(plain(request));
      assert.ok(plans.length, "Unexpected extra provider request");
      const plan = plans.shift();
      const output = typeof plan === "function" ? await plan(request) : plan;
      return (async function* () {
        yield {
          type: "response.completed",
          response: {
            model: "gpt-5.6-terra",
            service_tier: "priority",
            output,
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          },
        };
      })();
    },
  };
  const execute = async (callId, name, args) => {
    browser.push({ callId, name, args: plain(args) });
    if (name === "discover_guides") return library();
    if (name === "get_product_guides") return productGuides;
    if (name === "get_store_support")
      return {
        status: "found",
        phone: "01234 567890",
        hours: "Monday to Friday, 9am to 5pm",
        contactUrl: `${origin}/pages/contact`,
      };
    if (name === "navigate") {
      currentPage = {
        productPath: "/products/another-roller",
        pageId: randomUUID(),
      };
      return {
        status: "navigated",
        url: `${origin}/products/another-roller`,
        title: "Another roller",
      };
    }
    throw new Error(`Unexpected browser tool ${name}`);
  };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    URL,
    AbortController,
    AbortSignal,
    structuredClone,
    setTimeout,
    clearTimeout,
    console: { warn() {}, error() {} },
    fetch: async (url, options) => {
      options.signal.throwIfAborted();
      downloads.push(url);
      return mock.download(url, options);
    },
  });
  const api = module.exports;
  const inventory = () => api.readLibraryInventory(id, origin);
  const reuse = () => ({
    inventory: inventory(),
    bound: api.readBoundLibrarySource(id, origin, currentPage),
    discover: (sourceCallId, result) =>
      api.saveLibraryDiscovery(id, origin, result, {
        sourceCallId,
        sourceAssistantId: assistantId,
      }),
    read: (input, signal, attachedUrls) =>
      api.readLibraryGuides(id, origin, input, signal, attachedUrls),
    bind: async (source, requestedPath) => {
      if (
        !currentPage ||
        (requestedPath && requestedPath !== currentPage.productPath)
      )
        return undefined;
      return api.bindLibrarySource(id, origin, source, currentPage);
    },
  });
  return {
    api,
    id,
    requests,
    browser,
    downloads,
    usage,
    activity,
    inventory,
    productGuides(value) {
      productGuides = value;
    },
    download(fetcher) {
      mock.download = fetcher;
    },
    page(value) {
      currentPage = value;
    },
    async seed({ read = true } = {}) {
      const saved = api.saveLibraryDiscovery(id, origin, library(), {
        sourceCallId: "earlier_library",
        sourceAssistantId: randomUUID(),
      });
      const source = read
        ? (
            await api.readLibraryGuides(
              id,
              origin,
              {
                discoveryId: saved.discoveryId,
                guideIds: [guideId(1)],
                refresh: false,
              },
              new AbortController().signal,
            )
          ).source
        : saved.source;
      if (currentPage) api.bindLibrarySource(id, origin, source, currentPage);
      return saved;
    },
    async run(responses, options = {}) {
      plans = [...responses];
      assistantId = randomUUID();
      const result = await api.generateReply(
        options.history ?? [
          { role: "user", text: "Help me measure this angled bay." },
        ],
        () => {},
        options.signal ?? new AbortController().signal,
        execute,
        options.mode ?? "text",
        (value) => usage.push(value),
        origin,
        options.resume,
        (value) => activity.push(plain(value ?? null)),
        undefined,
        reuse(),
      );
      assert.equal(plans.length, 0, "Planned responses were unused");
      return result;
    },
  };
}

test("failed PDP read falls back to a discovered library, selected same-kind originals and one sourced numeric input", async () => {
  const state = setup();
  const result = await state.run([
    [
      call("get_product_guides", {
        productPath,
        kinds: ["measuring"],
        refresh: false,
      }),
    ],
    [call("discover_guides", { library: "blinds" }, "library_discovery")],
    () => [
      call("read_library_guides", {
        discoveryId: state.inventory()[0].discoveryId,
        guideIds: [guideId(1), guideId(2)],
        refresh: false,
      }),
    ],
    [call("ask_measurement", measurement())],
  ]);
  assert.equal(state.requests.length, 4);
  assert.deepEqual(
    state.browser.map(({ name }) => name),
    ["get_product_guides", "discover_guides"],
  );
  assert.equal(state.downloads.length, 2);
  assert.deepEqual(
    state.requests.map((request) => files(request).length),
    [0, 0, 0, 2],
  );
  assert.deepEqual(
    plain(result.questionPresentation.librarySource.source.guideIds),
    [guideId(1), guideId(2)],
  );
  assert.equal(result.questionPresentation.sourceCallId, "library_discovery");
  assert.equal(
    result.questionPresentation.measurement.productPath,
    productPath,
  );
  assert.equal(state.activity.at(-1), null);
  const serializedOutputs = JSON.stringify(outputs(state.requests.at(-1)));
  assert.doesNotMatch(serializedOutputs, /file_data|base64/);
  assert.match(serializedOutputs, /Diagrams and videos were not interpreted/);
  assert.match(serializedOutputs, /Angled bay guide/);
  for (const request of state.requests) {
    assert.equal(request.model, "gpt-5.6-terra");
    assert.equal(request.reasoning.effort, "medium");
    assert.equal(request.service_tier, "fast");
    assert.equal(request.store, false);
  }
  assert.equal(
    state.usage.filter(({ status }) => status === "completed").length,
    4,
  );
});

test("cached grounded numeric follow-up uses one request without automatic PDFs or discovery text", async () => {
  const state = setup();
  await state.seed();
  const downloads = state.downloads.length;
  const result = await state.run(
    [
      [
        call("ask_measurement", {
          ...measurement(),
          label: "Drop",
          question: "What is the drop?",
        }),
      ],
    ],
    {
      history: [
        { role: "assistant", text: "Previously verified synthetic method." },
        { role: "user", text: "Width: 500 mm" },
      ],
    },
  );
  assert.equal(state.requests.length, 1);
  assert.equal(files(state.requests[0]).length, 0);
  assert.equal(state.downloads.length, downloads);
  assert.equal(state.browser.length, 0);
  assert.deepEqual(state.activity, []);
  assert.equal(result.questionPresentation.measurement.label, "Drop");
  assert.doesNotMatch(
    JSON.stringify(state.requests[0].input),
    /Synthetic native method/,
  );
});

test("explicit cached PDF selection attaches only its original with no browser read or download", async () => {
  const state = setup();
  const saved = await state.seed();
  const result = await state.run([
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(1)],
        refresh: false,
      }),
    ],
    [call("ask_measurement", measurement())],
  ]);
  assert.equal(state.requests.length, 2);
  assert.deepEqual(
    state.requests.map((request) => files(request).length),
    [0, 1],
  );
  assert.equal(state.downloads.length, 1);
  assert.equal(state.browser.length, 0);
  assert.equal(
    result.questionPresentation.librarySource.source.guideIds.length,
    1,
  );
});





test("a library read grounds the same reply's terminal numeric question without display work", async () => {
  const state = setup();
  const saved = await state.seed({ read: false });
  const result = await state.run([
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(1)],
        refresh: false,
      }),
    ],
    [call("ask_measurement", measurement(), "numeric_step")],
  ]);
  assert.deepEqual(
    plain(result.questionPresentation.librarySource.source.guideIds),
    [guideId(1)],
  );
  assert.equal(result.questionPresentation.measurement.label, "Width");
  assert.equal(state.requests.length, 2);
  assert.equal(state.downloads.length, 1);
  assert.equal(state.browser.length, 0);
});

test("a terminal library measurement preserves only the authored guide introduction from earlier rounds", async (t) => {
  for (const apostrophe of ["'", "’"])
    await t.test(
      apostrophe === "'" ? "straight apostrophe" : "curly apostrophe",
      async () => {
        const state = setup();
        const saved = await state.seed();
        const intro = `Let${apostrophe}s walk through the measuring guide.`;
        const selection = {
          discoveryId: saved.discoveryId,
          guideIds: [guideId(1)], refresh: false,
        };
        const result = await state.run(
          [
            [
              message(`I am checking the selected original. ${intro}`),
              call("read_library_guides", selection),
            ],
            [call("ask_measurement", measurement())],
          ],
          { mode: "voice" },
        );
        assert.equal(
          result.text,
          `${intro} ${measurement().instructions} ${measurement().question}`,
        );
        assert.doesNotMatch(result.text, /checking/);
        assert.equal(state.requests.length, 2);
      },
    );
});

test("a later library numeric question does not reuse a historical voice introduction", async () => {
  const state = setup();
  await state.seed();
  const result = await state.run(
    [
      [call("ask_measurement", measurement())],
    ],
    {
      mode: "voice",
      history: [
        { role: "assistant", text: "Let's walk through the measuring guide." },
        { role: "user", text: "Show that guide again, then continue." },
      ],
    },
  );
  assert.equal(result.text, "");
  assert.equal(
    result.questionPresentation.measurement.instructions,
    measurement().instructions,
  );
  assert.equal(state.requests.length, 1);
});



test("library PDF prefixes stay identical across reversed selections and remain demand-driven", async () => {
  const state = setup();
  const saved = await state.seed({ read: false });
  for (const ids of [
    [guideId(2), guideId(1)],
    [guideId(1), guideId(2)],
  ])
    await state.run([
      [
        call("read_library_guides", {
          discoveryId: saved.discoveryId,
          guideIds: ids,
          refresh: false,
        }),
      ],
      [message("The requested originals support this synthetic method.")],
    ]);
  const [initial, first, followup, second] = state.requests;
  assert.deepEqual([files(initial).length, files(followup).length], [0, 0]);
  const prefix = (request) =>
    request.input.slice(
      0,
      request.input.findLastIndex(
        (item) =>
          Array.isArray(item.content) &&
          item.content.some((part) => part.type === "input_file"),
      ) + 1,
    );
  assert.deepEqual(prefix(first), prefix(second));
  assert.equal(first.prompt_cache_key, second.prompt_cache_key);
  assert.deepEqual(
    files(first).map(({ filename }) => filename),
    [`${guideId(1)}.pdf`, `${guideId(2)}.pdf`],
  );
  assert.equal(state.downloads.length, 2);
});

test("identical PDP and library originals attach once while both source references and bindings survive", async () => {
  const state = setup();
  const saved = await state.seed({ read: false });
  state.productGuides({
    status: "found",
    productPath,
    guides: [
      { kind: "measuring", url: library().guides[0].url },
      { kind: "fitting", url: `${origin}/cdn/shop/files/fitting.pdf?v=1` },
    ],
  });
  await state.run([
    [
      call("get_product_guides", {
        productPath,
        kinds: ["measuring", "fitting"],
        refresh: false,
      }),
    ],
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(2), guideId(1)],
        refresh: false,
      }),
    ],
    [message("The requested originals support this synthetic method.")],
  ]);
  const request = state.requests.at(-1);
  assert.deepEqual(
    state.requests.map((value) => files(value).length),
    [0, 2, 3],
  );
  const parts = request.input.flatMap((item) =>
    Array.isArray(item.content) ? item.content : [],
  );
  assert.equal(parts.filter((part) => part.prompt_cache_breakpoint).length, 4);
  assert.deepEqual(
    files(request).map(({ filename }) => filename),
    ["measuring-guide.pdf", "fitting-guide.pdf", `${guideId(2)}.pdf`],
  );
  const referenceIndex = request.input.findIndex(
    (item) =>
      Array.isArray(item.content) &&
      item.content.length === 1 &&
      item.content[0].text?.includes(`"id":"${guideId(1)}"`),
  );
  const lastFileIndex = request.input.findLastIndex(
    (item) =>
      Array.isArray(item.content) &&
      item.content.some((part) => part.type === "input_file"),
  );
  assert.ok(referenceIndex > lastFileIndex);
  assert.equal(request.input[referenceIndex].role, "user");
  assert.match(
    request.input[referenceIndex].content[0].text,
    /Untrusted original library guide reference/,
  );
  assert.match(
    JSON.stringify(request.input),
    /Application product-guide binding/,
  );
  assert.match(
    JSON.stringify(request.input),
    /Verified library prior-read binding/,
  );
  assert.equal(state.downloads.length, 3);
});

test("PDF deduplication requires both the exact URL and original bytes", async (t) => {
  for (const sameUrl of [false, true])
    await t.test(sameUrl ? "changed original" : "different URL", async () => {
      const state = setup();
      const saved = await state.seed({ read: false });
      const response = (body) =>
        new Response(Buffer.from(`%PDF-1.7\n${body}\n%%EOF`), {
          headers: { "content-type": "application/pdf" },
        });
      state.download(async () => response("Original content"));
      state.productGuides({
        status: "found",
        productPath,
        guides: [
          {
            kind: "measuring",
            url: sameUrl
              ? library().guides[0].url
              : `${origin}/cdn/shop/files/another.pdf?v=1`,
          },
        ],
      });
      await state.run([
        [
          call("get_product_guides", {
            productPath,
            kinds: ["measuring"],
            refresh: false,
          }),
        ],
        () => {
          if (sameUrl) state.download(async () => response("Changed content"));
          return [
            call("read_library_guides", {
              discoveryId: saved.discoveryId,
              guideIds: [guideId(1)],
              refresh: sameUrl,
            }),
          ];
        },
        [message("Use only the original relevant to this step.")],
      ]);
      const originals = files(state.requests.at(-1));
      assert.equal(originals.length, 2);
      assert.equal(originals[0].file_data === originals[1].file_data, !sameUrl);
    });
});

test("a failed explicit refresh removes an earlier original from subsequent model context", async () => {
  const state = setup();
  const saved = await state.seed();
  const result = await state.run([
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(1)],
        refresh: false,
      }),
    ],
    () => {
      state.download(async () => new Response(null, { status: 404 }));
      return [
        call("read_library_guides", {
          discoveryId: saved.discoveryId,
          guideIds: [guideId(1)],
          refresh: true,
        }),
      ];
    },
    [
      message(
        "That refreshed PDF is unavailable; I cannot rely on its old content.",
      ),
    ],
  ]);
  assert.deepEqual(
    state.requests.map((request) => files(request).length),
    [0, 1, 0],
  );
  assert.equal(result.questionPresentation.measurement, undefined);
  assert.equal(state.downloads.length, 2);
  assert.equal(outputs(state.requests.at(-1)).at(-1).status, "unavailable");
});

test("model-authored PDF URLs and unknown IDs never reach the downloader", async () => {
  const state = setup();
  const saved = await state.seed({ read: false });
  const result = await state.run([
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(1)],
        refresh: false,
        url: "https://attacker.invalid/private.pdf",
      }),
    ],
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(99)],
        refresh: false,
      }),
    ],
    [message("I cannot read those selected documents.")],
  ]);
  assert.equal(state.downloads.length, 0);
  assert.equal(state.browser.length, 0);
  assert.equal(files(state.requests.at(-1)).length, 0);
  assert.equal(
    outputs(state.requests.at(-1)).filter((value) => value.error).length,
    2,
  );
  assert.ok(result.questionPresentation.answers.length);
});

test("general library guidance works without a selected product but cannot create a product measurement binding", async () => {
  const state = setup();
  state.page(undefined);
  const result = await state.run([
    [call("discover_guides", { library: "blinds" })],
    [call("ask_measurement", measurement())],
    [
      message(
        "Choose the blind type so I can match the right measuring method.",
      ),
    ],
  ]);
  assert.equal(result.questionPresentation.measurement, undefined);
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, undefined),
    undefined,
  );
  assert.equal(state.downloads.length, 0);
  assert.equal(files(state.requests.at(-1)).length, 0);
  assert.match(
    outputs(state.requests.at(-1)).at(-1).error,
    /No measurement input/,
  );
});

test("saved numeric voice resume may reuse its bound library evidence without repeating PDFs", async () => {
  const state = setup();
  await state.seed();
  const args = measurement();
  const resume = {
    type: "question",
    version: 1,
    invocationId: randomUUID(),
    question: args.question,
    answers: [],
    measurement: {
      productPath,
      label: args.label,
      unit: args.unit,
      instructions: args.instructions,
    },
  };
  const result = await state.run([[call("ask_measurement", args)]], {
    mode: "voice",
    resume,
  });
  assert.equal(result.text, "");
  assert.equal(result.questionPresentation.measurement.label, "Width");
  assert.equal(state.requests.length, 1);
  assert.equal(files(state.requests[0]).length, 0);
  const tools = state.requests[0].tools.map(({ name }) => name);
  assert.deepEqual(
    tools.sort(),
    ["ask_measurement", "get_product_guides", "read_library_guides"].sort(),
  );
});

test("support details come from the footer tool, without fabricating missing fields or reading PDFs", async () => {
  const state = setup();
  const result = await state.run([
    [call("get_store_support", {})],
    [message("Contact the store using its verified phone or contact page.")],
  ]);
  assert.deepEqual(
    state.browser.map(({ name }) => name),
    ["get_store_support"],
  );
  assert.deepEqual(outputs(state.requests[1])[0], {
    status: "found",
    phone: "01234 567890",
    hours: "Monday to Friday, 9am to 5pm",
    contactUrl: `${origin}/pages/contact`,
  });
  assert.equal(files(state.requests[1]).length, 0);
  assert.equal(state.downloads.length, 0);
  assert.ok(result.questionPresentation.answers.length);
});

function runnerSetup() {
  const id = randomUUID(),
    assistantId = randomUUID();
  let pageId = randomUUID();
  let status = "active";
  const finishes = [];
  const snapshot = () => ({
    id,
    status,
    revision: 0,
    tools: [],
    busy: true,
    messages: [
      {
        id: pageId,
        role: "context",
        status: "complete",
        createdAt: "2026-09-17T10:00:00Z",
        parts: [
          {
            type: "page_view",
            path: productPath,
            title: "Synthetic roller",
            occurredAt: "2026-09-17T10:00:00Z",
          },
        ],
      },
    ],
  });
  const mock = {
    begin: async () => ({
      assistantId,
      origin,
      history: [],
      snapshot: snapshot(),
    }),
    snapshot: async () => snapshot(),
    finish: async (...args) => {
      finishes.push(args);
      return true;
    },
    end: async () => {
      status = "ended";
      return snapshot();
    },
  };
  const module = { exports: {} };
  runInNewContext(runnerBundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    URL,
    AbortController,
    AbortSignal,
    structuredClone,
    console: { warn() {}, error() {} },
  });
  const api = module.exports;
  return {
    id,
    api,
    mock,
    finishes,
    snapshot,
    newEpisode() {
      pageId = randomUUID();
    },
    run(generate) {
      mock.generate = generate;
      return api.runVoiceDelegation(
        id,
        randomUUID(),
        randomUUID(),
        new AbortController().signal,
      );
    },
  };
}

const successfulReply = {
  text: "Verified guidance.",
  model: "gpt-5.6-terra",
  serviceTier: "priority",
};

test("runner discards discovery authority when the producing reply fails or its atomic finish is stale", async () => {
  for (const outcome of ["failed", "stale"]) {
    const state = runnerSetup();
    if (outcome === "stale")
      state.mock.finish = async (...args) => {
        state.finishes.push(args);
        return false;
      };
    const result = await state.run(async (...args) => {
      const reuse = args[10];
      const inventory = reuse.discover("call_current_library", library());
      assert.ok(await reuse.bind(inventory.source, productPath));
      if (outcome === "failed") throw new Error("Synthetic provider failure");
      return successfulReply;
    });
    assert.equal(result, undefined);
    assert.deepEqual(
      plain(state.api.readLibraryInventory(state.id, origin)),
      [],
    );
    assert.equal(
      state.finishes[0][2].status,
      outcome === "failed" ? "failed" : "complete",
    );
  }
});

test("runner End during the binding snapshot read cannot restore cleared authority", async () => {
  const state = runnerSetup();
  let release;
  state.mock.snapshot = () =>
    new Promise((resolve) => {
      release = () => resolve(state.snapshot());
    });
  const pending = state.run(async (...args) => {
    const reuse = args[10];
    const inventory = reuse.discover("call_current_library", library());
    await reuse.bind(inventory.source, productPath);
    assert.fail("An aborted bind cannot proceed to generation completion");
  });
  for (let index = 0; index < 20 && !release; index++) await setImmediate();
  assert.ok(release);
  await state.api.endTurn(state.id);
  release();
  assert.equal(await pending, undefined);
  assert.deepEqual(plain(state.api.readLibraryInventory(state.id, origin)), []);
});

test("runner cannot transplant one source binding across a leave-return page episode during its turn", async () => {
  const state = runnerSetup();
  await state.run(async (...args) => {
    const reuse = args[10];
    const inventory = reuse.discover("call_current_library", library());
    const bound = await reuse.bind(inventory.source, productPath);
    assert.ok(bound);
    state.newEpisode();
    assert.equal(await reuse.bind(inventory.source, productPath), undefined);
    return successfulReply;
  });
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, {
      productPath,
      pageId: state.snapshot().messages[0].id,
    }),
    undefined,
  );
});

test("runner retains successful source authority only after a successful reply completion", async () => {
  const state = runnerSetup();
  const result = await state.run(async (...args) => {
    const reuse = args[10];
    const inventory = reuse.discover("call_current_library", library());
    await reuse.bind(inventory.source, productPath);
    return successfulReply;
  });
  assert.deepEqual(plain(result), successfulReply);
  assert.equal(state.api.readLibraryInventory(state.id, origin).length, 1);
  assert.ok(
    state.api.readBoundLibrarySource(state.id, origin, {
      productPath,
      pageId: state.snapshot().messages[0].id,
    }),
  );
});

test("a model read over the combined original budget cannot authorize unread evidence", async () => {
  const state = setup();
  const saved = await state.seed({ read: false });
  state.productGuides({
    status: "found",
    productPath,
    guides: ["measuring", "fitting"].map((kind) => ({
      kind,
      url: `${origin}/cdn/shop/files/pdp-${kind}.pdf?v=1`,
    })),
  });
  await state.run([
    [
      call("get_product_guides", {
        productPath,
        kinds: ["measuring", "fitting"],
        refresh: false,
      }),
    ],
    [
      call("read_library_guides", {
        discoveryId: saved.discoveryId,
        guideIds: [guideId(1), guideId(2)],
        refresh: false,
      }),
    ],
    [message("The requested additional evidence was unavailable.")],
  ]);
  const toolOutputs = outputs(state.requests.at(-1));
  assert.equal(toolOutputs[1].reason, "document_limit");
  assert.equal(
    state.downloads.length,
    2,
    "Only the accepted PDP originals are downloaded",
  );
  assert.deepEqual(
    state.requests.map((request) => files(request).length),
    [0, 2, 2],
  );

});
