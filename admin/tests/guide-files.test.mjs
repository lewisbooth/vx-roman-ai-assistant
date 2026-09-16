import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/guides/files.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const origin = "https://hd-dev-single.myshopify.com";
const pdf = Buffer.from("%PDF-1.7\npublic guide fixture\n%%EOF");
const pairedGuides = {
  status: "found",
  productPath:
    "/products/perfect-fit-chromium-thermal-blackout-black-roller-blind",
  guides: [
    {
      kind: "measuring",
      url: "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/Measuring-for-all-Roller-blinds.pdf?v=1744119133",
    },
    { kind: "fitting", url: `${origin}/cdn/shop/files/fitting.pdf?v=2` },
  ],
};
const maxBytes = 4 * 1024 * 1024;
const plain = (value) => JSON.parse(JSON.stringify(value));
const guide = (name = "measuring", version = 1) => ({
  status: "found",
  productPath: "/products/shade",
  guides: [
    {
      kind: "measuring",
      url: `${origin}/cdn/shop/files/${name}.pdf?v=${version}`,
    },
  ],
});
const response = (bytes = pdf, headers = {}) =>
  new Response(bytes, {
    headers: { "content-type": "application/pdf", ...headers },
  });

function setup(fetcher = async () => response()) {
  const calls = [];
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const exports = {};
  const module = { exports };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports,
    require,
    URL,
    AbortController,
    AbortSignal,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetcher(url, options);
    },
    setTimeout(callback, ms) {
      const id = ++nextTimer;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  return {
    calls,
    timers,
    advance(ms) {
      now += ms;
    },
    timeout() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      assert.equal(timer.ms, 10_000);
      timer.callback();
    },
    read(
      result = guide(),
      signal = new AbortController().signal,
      storefrontOrigin = origin,
    ) {
      return module.exports.readProductGuideFiles(
        result,
        storefrontOrigin,
        signal,
      );
    },
  };
}

test("verified measuring and fitting PDFs become high-detail file inputs with exact source metadata", async () => {
  const ctx = setup();
  const result = guide();
  result.guides.push({
    kind: "fitting",
    url: `${origin}/cdn/shop/files/fitting.pdf?v=2`,
  });
  const loaded = await ctx.read(result);
  assert.equal(loaded.status, "ready");
  assert.deepEqual(plain(loaded.sources), result.guides);
  assert.deepEqual(
    plain(loaded.files),
    ["measuring", "fitting"].map((kind) => ({
      type: "input_file",
      filename: `${kind}-guide.pdf`,
      detail: "high",
      file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
    })),
  );
  for (const call of ctx.calls) {
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.cache, "no-store");
    assert.deepEqual(plain(call.options.headers), {
      Accept: "application/pdf",
    });
    assert.equal(call.options.signal.aborted, false);
  }
  assert.equal(ctx.timers.size, 0);
  assert.equal(JSON.stringify(loaded.sources).includes("base64"), false);
});

test("unavailable guides produce no fetch and strict validation rejects unsupported or mismatched inputs", async () => {
  const ctx = setup();
  assert.deepEqual(
    plain(await ctx.read({ ...guide(), status: "unavailable", guides: [] })),
    {
      status: "unavailable",
      reason: "no_guides",
    },
  );
  for (const result of [
    { ...guide(), extra: "not part of the contract" },
    { ...guide(), productPath: "/cart" },
    { ...guide(), guides: [] },
    { ...guide(), guides: [...guide().guides, ...guide().guides] },
    { ...guide(), guides: Array(3).fill(guide().guides[0]) },
    ...[
      "https://evil.example/cdn/shop/files/guide.pdf",
      `${origin}/account/logout`,
      `${origin}/cdn/shop/files/guide.pdf?private=1`,
      `${origin}/cdn/shop/files/guide.pdf#page=1`,
      `${origin}/cdn/shop/files/%2e%2e/guide.pdf`,
      "https://user:secret@hd-dev-single.myshopify.com/cdn/shop/files/guide.pdf",
    ].map((url) => ({ ...guide(), guides: [{ kind: "measuring", url }] })),
  ]) {
    assert.deepEqual(plain(await ctx.read(result)), {
      status: "unavailable",
      reason: "invalid_guides",
    });
  }
  assert.deepEqual(
    plain(
      await ctx.read(guide(), undefined, "https://other-store.myshopify.com"),
    ),
    {
      status: "unavailable",
      reason: "invalid_guides",
    },
  );
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.timers.size, 0);
});

test("failed HTTP, redirects and private network errors yield categorical failures without leaking details", async () => {
  for (const fetcher of [
    async () => new Response("Login required", { status: 403 }),
    async () => ({ ...response(), body: null, ok: true, redirected: true }),
    async () => {
      throw new TypeError("private upstream connection details");
    },
  ]) {
    const ctx = setup(fetcher);
    assert.deepEqual(plain(await ctx.read()), {
      status: "unavailable",
      reason: "network",
    });
    assert.equal(ctx.timers.size, 0);
  }
});

test("HTTP 404 is a missing file and is fetched again on the next attempt", async () => {
  let reply = new Response("Private upstream error body", { status: 404 });
  const missing = reply;
  const ctx = setup(async () => reply);
  assert.deepEqual(plain(await ctx.read()), {
    status: "unavailable",
    reason: "not_found",
  });
  assert.equal(missing.body.locked, false);
  assert.equal(ctx.timers.size, 0);
  reply = response();
  assert.equal((await ctx.read()).status, "ready");
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.timers.size, 0);
});

test("PDF MIME and magic bytes are both required and invalid responses release their reader", async () => {
  for (const [body, type] of [
    [pdf, "text/html"],
    [pdf, "application/octet-stream"],
    [Buffer.from("<html>login</html>"), "application/pdf"],
    [Buffer.alloc(0), "application/pdf"],
    [Buffer.from("%PDF"), "application/pdf"],
    [Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]), "application/pdf"],
  ]) {
    const reply = response(body, { "content-type": type });
    const ctx = setup(async () => reply);
    assert.deepEqual(plain(await ctx.read()), {
      status: "unavailable",
      reason: "invalid_pdf",
    });
    assert.equal(reply.body.locked, false);
    assert.equal(ctx.timers.size, 0);
  }
  const ctx = setup(async () =>
    response(pdf, { "content-type": "Application/PDF; charset=binary" }),
  );
  assert.equal((await ctx.read()).status, "ready");
});

test("declared and actual streamed size limits cancel the reader without caching partial bytes", async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(pdf);
        if (!declared) controller.enqueue(new Uint8Array(maxBytes));
      },
      cancel() {
        cancelled++;
      },
    });
    let reply = new Response(body, {
      headers: {
        "content-type": "application/pdf",
        ...(declared ? { "content-length": String(maxBytes + 1) } : {}),
      },
    });
    const ctx = setup(async () => reply);
    assert.deepEqual(plain(await ctx.read()), {
      status: "unavailable",
      reason: "too_large",
    });
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
    assert.equal(ctx.timers.size, 0);
    reply = response();
    assert.equal((await ctx.read()).status, "ready");
    assert.equal(ctx.calls.length, 2);
  }
});

test("chunked PDF signatures and the exact 4 MiB limit are accepted", async () => {
  const bytes = Buffer.alloc(maxBytes, 32);
  pdf.copy(bytes);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    },
  });
  const ctx = setup(
    async () =>
      new Response(stream, { headers: { "content-type": "application/pdf" } }),
  );
  const loaded = await ctx.read();
  assert.equal(loaded.status, "ready");
  assert.equal(
    Buffer.from(loaded.files[0].file_data.split(",")[1], "base64").length,
    maxBytes,
  );
  assert.equal(stream.locked, false);
});

test("either missing guide preserves the other file, its exact source URL and a per-kind failure without caching failures", async () => {
  for (const failedKind of ["measuring", "fitting"]) {
    let failing = true;
    const failedGuide = pairedGuides.guides.find(
      (source) => source.kind === failedKind,
    );
    const successfulGuide = pairedGuides.guides.find(
      (source) => source.kind !== failedKind,
    );
    const ctx = setup(async (url) =>
      url === failedGuide.url && failing
        ? new Response("Missing file", { status: 404 })
        : response(),
    );
    const partial = await ctx.read(pairedGuides);
    assert.equal(partial.status, "ready");
    assert.deepEqual(plain(partial.sources), [successfulGuide]);
    assert.equal(partial.files.length, 1);
    assert.equal(
      partial.files[0].filename,
      `${successfulGuide.kind}-guide.pdf`,
    );
    assert.deepEqual(plain(partial.unavailable), [
      { kind: failedKind, reason: "not_found" },
    ]);
    assert.deepEqual(
      ctx.calls.map((call) => call.url),
      pairedGuides.guides.map((source) => source.url),
    );
    assert.equal(ctx.timers.size, 0);
    failing = false;
    const retried = await ctx.read(pairedGuides);
    assert.equal(retried.files.length, 2);
    assert.deepEqual(plain(retried.sources), pairedGuides.guides);
    assert.equal(retried.unavailable, undefined);
    assert.equal(
      ctx.calls.length,
      3,
      "only the successfully read file may be cached",
    );
  }
});

test("all failed guides return the first categorical failure without attachments", async () => {
  const ctx = setup(async (url) =>
    url === pairedGuides.guides[0].url
      ? response(Buffer.from("Not a PDF"))
      : new Response("Missing", { status: 404 }),
  );
  assert.deepEqual(plain(await ctx.read(pairedGuides)), {
    status: "unavailable",
    reason: "invalid_pdf",
  });
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.timers.size, 0);
  await ctx.read(pairedGuides);
  assert.equal(ctx.calls.length, 4);
});

test("one file timing out does not prevent reading the remaining guide", async () => {
  const ctx = setup(async (url, { signal }) => {
    if (url === pairedGuides.guides[1].url) return response();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const reading = ctx.read(pairedGuides);
  ctx.timeout();
  const partial = await reading;
  assert.equal(partial.status, "ready");
  assert.deepEqual(plain(partial.sources), [pairedGuides.guides[1]]);
  assert.deepEqual(plain(partial.unavailable), [
    { kind: "measuring", reason: "timeout" },
  ]);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.timers.size, 0);
});

test("caller abort after one successful file never returns a partial reply", async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const ctx = setup(async (url) =>
    url === pairedGuides.guides[0].url
      ? response()
      : new Response(body, { headers: { "content-type": "application/pdf" } }),
  );
  const controller = new AbortController();
  const reason = new Error("The customer ended this turn");
  const reading = ctx.read(pairedGuides, controller.signal);
  const rejected = assert.rejects(reading, (error) => error === reason);
  await setImmediate();
  assert.equal(ctx.calls.length, 2);
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(ctx.timers.size, 0);
});

test("caller abort before fetch or during a pending body preserves its exact reason and releases resources", async () => {
  const initial = setup();
  const before = new AbortController();
  const reason = new Error("caller stopped this turn");
  before.abort(reason);
  await assert.rejects(
    initial.read(guide(), before.signal),
    (error) => error === reason,
  );
  assert.equal(initial.calls.length, 0);

  let cancelled = 0;
  const body = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const ctx = setup(
    async () =>
      new Response(body, { headers: { "content-type": "application/pdf" } }),
  );
  const controller = new AbortController();
  const reading = ctx.read(guide(), controller.signal);
  const rejected = assert.rejects(reading, (error) => error === reason);
  await setImmediate();
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(ctx.calls[0].options.signal.aborted, true);
  assert.equal(ctx.timers.size, 0);
});

test("fetch and stalled body timeouts return timeout and clean up without retrying", async () => {
  const fetchCtx = setup(
    async (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const fetching = fetchCtx.read();
  fetchCtx.timeout();
  assert.deepEqual(plain(await fetching), {
    status: "unavailable",
    reason: "timeout",
  });
  assert.equal(fetchCtx.calls.length, 1);
  assert.equal(fetchCtx.timers.size, 0);

  let cancelled = 0;
  const body = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  const bodyCtx = setup(
    async () =>
      new Response(body, { headers: { "content-type": "application/pdf" } }),
  );
  const reading = bodyCtx.read();
  await setImmediate();
  bodyCtx.timeout();
  assert.deepEqual(plain(await reading), {
    status: "unavailable",
    reason: "timeout",
  });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(bodyCtx.calls.length, 1);
  assert.equal(bodyCtx.timers.size, 0);
});

test("the cache isolates exact origin and file version, expires after fifteen minutes, and cannot be mutated by callers", async () => {
  const ctx = setup();
  const first = await ctx.read();
  first.sources[0].url = "https://evil.example";
  first.files[0].file_data = "changed";
  const cached = await ctx.read();
  assert.equal(cached.sources[0].url, guide().guides[0].url);
  assert.match(cached.files[0].file_data, /^data:application\/pdf;base64,/);
  assert.equal(ctx.calls.length, 1);
  await ctx.read(guide("measuring", 2));
  const secondOrigin = "https://hd-dev-multi.myshopify.com";
  await ctx.read(
    {
      ...guide(),
      guides: [
        {
          kind: "measuring",
          url: `${secondOrigin}/cdn/shop/files/measuring.pdf?v=1`,
        },
      ],
    },
    undefined,
    secondOrigin,
  );
  assert.equal(ctx.calls.length, 3);
  ctx.advance(15 * 60_000 - 1);
  await ctx.read();
  assert.equal(ctx.calls.length, 3);
  ctx.advance(1);
  await ctx.read();
  assert.equal(ctx.calls.length, 4);
  assert.equal(ctx.timers.size, 0);
});

test("cache entry and byte bounds evict least recently used files", async () => {
  const small = setup();
  for (let index = 0; index < 16; index++)
    await small.read(guide(`small-${index}`));
  await small.read(guide("small-0"));
  await small.read(guide("small-16"));
  await small.read(guide("small-0"));
  assert.equal(small.calls.length, 17);
  await small.read(guide("small-1"));
  assert.equal(small.calls.length, 18);

  const bytes = Buffer.alloc(maxBytes, 32);
  pdf.copy(bytes);
  const large = setup(async () => response(bytes));
  for (let index = 0; index < 9; index++)
    await large.read(guide(`large-${index}`));
  await large.read(guide("large-1"));
  assert.equal(large.calls.length, 9);
  await large.read(guide("large-0"));
  assert.equal(large.calls.length, 10);
});
