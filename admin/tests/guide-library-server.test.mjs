import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/guides/library.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const origin = "https://hd-dev-single.myshopify.com";
const sectionId = `s_${"1".repeat(24)}`;
const guideId = (number) => `g_${number.toString(16).padStart(24, "0")}`;
const pdf = Buffer.from("%PDF-1.7\nSynthetic library guide\n%%EOF");
const response = (bytes = pdf) =>
  new Response(bytes, { headers: { "content-type": "application/pdf" } });
const plain = (value) => JSON.parse(JSON.stringify(value));
const discovery = (library = "blinds", count = 3) => ({
  library,
  pagePath: `/pages/measuring-${library}`,
  title: `${library} measuring library`,
  sections: [
    {
      id: sectionId,
      title: "Measuring guides",
      text: "Native library guidance, with conditions.",
    },
  ],
  guides: Array.from({ length: count }, (_, index) => ({
    id: guideId(index + 1),
    title:
      ["Roller blinds", "Angled bay windows", "Curtains"][index] ??
      `Guide ${index}`,
    section: sectionId,
    url: `${origin}/cdn/shop/files/library-${index + 1}.pdf?v=1`,
  })),
  diagramNotice:
    "Diagrams and videos were not interpreted; do not infer instructions that depend on them.",
});

function setup(fetcher = async () => response()) {
  let now = 1_800_000_000_000;
  const calls = [];
  const timers = new Map();
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    URL,
    AbortController,
    AbortSignal,
    structuredClone,
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
      const id = Symbol();
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const api = module.exports;
  const id = randomUUID();
  const provenance = {
    sourceCallId: "call_library",
    sourceAssistantId: randomUUID(),
  };
  const save = (
    result = discovery(),
    conversationId = id,
    receipt = provenance,
  ) => api.saveLibraryDiscovery(conversationId, origin, result, receipt);
  const read = (inventory, ids = [guideId(1)], options = {}) =>
    api.readLibraryGuides(
      options.conversationId ?? id,
      options.origin ?? origin,
      {
        discoveryId: inventory.discoveryId,
        guideIds: ids,
        refresh: options.refresh ?? false,
      },
      options.signal ?? new AbortController().signal,
      options.attachedUrls,
    );
  return {
    api,
    id,
    provenance,
    calls,
    timers,
    save,
    read,
    advance(ms) {
      now += ms;
    },
  };
}

test("discovery stores scoped HTML authority but later inventory contains neither page text nor originals", () => {
  const state = setup();
  const input = discovery();
  const saved = state.save(input);
  assert.deepEqual(plain(saved.source), {
    ...state.provenance,
    library: "blinds",
    pagePath: "/pages/measuring-blinds",
    expiresAt: 1_800_000_000_000 + 30 * 60_000,
    guideIds: [],
  });
  assert.equal(state.calls.length, 0);
  assert.equal(saved.guides.length, 3);
  assert.doesNotMatch(
    JSON.stringify(saved),
    /Native library guidance|file_data|base64|\.pdf/,
  );
  assert.deepEqual(plain(saved.sections), [
    { id: sectionId, title: "Measuring guides" },
  ]);
  input.guides[0].title = "Caller changed";
  saved.guides[0].title = "Caller changed again";
  saved.source.guideIds.push(guideId(1));
  const restored = state.api.readLibraryInventory(state.id, origin);
  assert.equal(restored[0].guides[0].title, "Roller blinds");
  assert.deepEqual(plain(restored[0].source.guideIds), []);
  assert.deepEqual(
    plain(state.api.readLibraryInventory(randomUUID(), origin)),
    [],
  );
  assert.deepEqual(
    plain(state.api.readLibraryInventory(state.id, "https://other-shop.test")),
    [],
  );
});

test("selected same-kind roller and bay originals retain source identity, diagrams and exact URLs", async () => {
  const state = setup();
  const saved = state.save();
  const result = await state.read(saved, [guideId(1), guideId(2)]);
  assert.equal(result.status, "ready");
  assert.deepEqual(plain(result.guides.map(({ title }) => title)), [
    "Roller blinds",
    "Angled bay windows",
  ]);
  assert.deepEqual(plain(result.source.guideIds), [guideId(1), guideId(2)]);
  assert.equal(result.files.length, 2);
  assert.equal(result.input.length, 2);
  assert.ok(result.input.every((item) => item.role === "user"));
  assert.doesNotMatch(
    JSON.stringify(result.input),
    /productPath|sourceAssistantId|sourceCallId/,
  );
  for (let index = 0; index < 2; index++) {
    assert.equal(result.files[index].detail, "high");
    assert.equal(
      result.files[index].file_data,
      `data:application/pdf;base64,${pdf.toString("base64")}`,
    );
    assert.equal(result.files[index].filename, `${guideId(index + 1)}.pdf`);
    assert.match(result.input[index].content[0].text, /reference|reference/i);
    assert.deepEqual(
      plain(result.input[index].content[1].prompt_cache_breakpoint),
      { mode: "explicit" },
    );
    assert.equal(state.calls[index].url, discovery().guides[index].url);
    assert.equal(state.calls[index].options.credentials, "omit");
    assert.equal(state.calls[index].options.redirect, "error");
  }
  assert.equal(state.timers.size, 0);
  result.files[0].file_data = "tampered";
  result.guides[0].url = "https://untrusted.test/file.pdf";
  const again = await state.read(saved, [guideId(1), guideId(2)]);
  assert.equal(state.calls.length, 2);
  assert.equal(
    again.files[0].file_data,
    `data:application/pdf;base64,${pdf.toString("base64")}`,
  );
  assert.equal(again.guides[0].url, discovery().guides[0].url);
});

test("selection cannot inject URLs, unknown IDs or another conversation's discovery", async () => {
  const state = setup();
  const saved = state.save();
  for (const ids of [
    [guideId(40)],
    [guideId(1), guideId(1)],
    [],
    [guideId(1), guideId(2), guideId(3)],
  ])
    await assert.rejects(state.read(saved, ids), /Select/);
  for (const input of [
    {
      discoveryId: saved.discoveryId,
      guideIds: [guideId(1)],
      refresh: false,
      url: discovery().guides[0].url,
    },
    { discoveryId: saved.discoveryId, guideIds: [guideId(1)] },
    {
      discoveryId: saved.discoveryId,
      guideIds: [guideId(1)],
      refresh: "false",
    },
  ])
    assert.throws(() => state.api.parseLibraryReadCall(input), /Select/);
  for (const options of [
    { conversationId: randomUUID() },
    { origin: "https://other-shop.test" },
  ])
    assert.deepEqual(plain(await state.read(saved, [guideId(1)], options)), {
      status: "unavailable",
      reason: "discovery_unavailable",
    });
  assert.equal(state.calls.length, 0);
});

test("guide-card selection requires a scoped successful read and returns a detached exact source without another download", async () => {
  const state = setup();
  const saved = state.save();
  const selection = { discoveryId: saved.discoveryId, guideId: guideId(1) };
  const select = (input = selection, id = state.id, shop = origin) =>
    state.api.selectLibraryGuide(id, shop, input);
  assert.throws(() => select(), /no current verified read/);
  await state.read(saved);
  const selected = select();
  assert.deepEqual(plain(selected.guide), discovery().guides[0]);
  assert.deepEqual(plain(selected.source), {
    ...plain(saved.source),
    guideIds: [guideId(1)],
  });
  selected.guide.title = "Changed by caller";
  selected.source.guideIds.length = 0;
  assert.deepEqual(plain(select().guide), discovery().guides[0]);
  assert.deepEqual(plain(select().source.guideIds), [guideId(1)]);
  for (const input of [
    { ...selection, guideId: guideId(2) },
    { ...selection, guideId: guideId(99) },
    { ...selection, discoveryId: randomUUID() },
  ])
    assert.throws(() => select(input), /no current verified read/);
  assert.throws(
    () => select(selection, randomUUID()),
    /no current verified read/,
  );
  assert.throws(
    () => select(selection, state.id, "https://another-store.test"),
    /no current verified read/,
  );
  assert.equal(state.calls.length, 1);
  state.advance(state.api.LIBRARY_SESSION_TTL_MS);
  assert.throws(() => select(), /no current verified read/);
  assert.equal(state.calls.length, 1);
});

test("guide-card arguments cannot supply a URL or replace a discovery identifier", () => {
  const state = setup();
  const saved = state.save();
  const selection = { discoveryId: saved.discoveryId, guideId: guideId(1) };
  for (const input of [
    { ...selection, url: discovery().guides[0].url },
    { ...selection, guideId: discovery().guides[0].url },
    { guideId: selection.guideId },
    { ...selection, discoveryId: "invented" },
  ])
    assert.throws(
      () => state.api.parseLibraryGuideSelection(input),
      /Select one previously read/,
    );
  assert.equal(state.calls.length, 0);
});

test("a failed refresh revokes guide-card eligibility instead of presenting the older PDF", async () => {
  let available = true;
  const state = setup(async () =>
    available ? response() : new Response(null, { status: 404 }),
  );
  const saved = state.save();
  const input = { discoveryId: saved.discoveryId, guideId: guideId(1) };
  await state.read(saved);
  assert.equal(
    state.api.selectLibraryGuide(state.id, origin, input).guide.id,
    guideId(1),
  );
  available = false;
  assert.equal(
    (await state.read(saved, [guideId(1)], { refresh: true })).status,
    "unavailable",
  );
  assert.throws(
    () => state.api.selectLibraryGuide(state.id, origin, input),
    /no current verified read/,
  );
  assert.equal(state.calls.length, 2);
});

test("receipt validation binds fixed source pages, authentic source IDs and immutable expiry", () => {
  const state = setup();
  const saved = state.save();
  for (const change of [
    { pagePath: "/pages/other" },
    { library: "anything" },
    { sourceAssistantId: "not-a-uuid" },
    { sourceCallId: "contains spaces" },
    { guideIds: [guideId(1), guideId(1)] },
    { guideIds: [guideId(1), guideId(2), guideId(3)] },
    { expiresAt: saved.source.expiresAt + 1 },
    { arbitrary: "field" },
  ])
    assert.throws(
      () => state.api.parseLibrarySourceReceipt({ ...saved.source, ...change }),
      /Invalid/,
    );
  state.advance(10 * 60_000);
  const duplicate = state.save();
  assert.equal(duplicate.discoveryId, saved.discoveryId);
  assert.equal(duplicate.source.expiresAt, saved.source.expiresAt);
  const changed = discovery();
  changed.sections[0].text = "Changed source under same receipt";
  assert.throws(() => state.save(changed), /cannot change/);
  state.advance(20 * 60_000);
  assert.deepEqual(plain(state.api.readLibraryInventory(state.id, origin)), []);
  assert.throws(
    () => state.api.parseLibrarySourceReceipt(saved.source),
    /Invalid/,
  );
});

test("HTML can support a scoped question; undiscovered or unread PDFs cannot manufacture authority", async () => {
  const state = setup();
  const saved = state.save();
  const page = {
    productPath: "/products/synthetic-roller",
    pageId: randomUUID(),
  };
  const html = state.api.bindLibrarySource(
    state.id,
    origin,
    saved.source,
    page,
  );
  assert.deepEqual(plain(html.source.guideIds), []);
  for (const source of [
    { ...saved.source, guideIds: [guideId(1)] },
    { ...saved.source, sourceCallId: "invented" },
    { ...saved.source, sourceAssistantId: randomUUID() },
  ])
    assert.throws(
      () => state.api.bindLibrarySource(state.id, origin, source, page),
      /cannot be bound/,
    );
  const read = await state.read(saved);
  state.api.bindLibrarySource(state.id, origin, read.source, page);
  assert.deepEqual(
    plain(state.api.readBoundLibrarySource(state.id, origin, page).source),
    plain(read.source),
  );
  const copy = state.api.readBoundLibrarySource(state.id, origin, page);
  copy.source.guideIds.length = 0;
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, page).source.guideIds
      .length,
    1,
  );
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, {
      ...page,
      pageId: randomUUID(),
    }),
    undefined,
  );
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, page),
    undefined,
    "Returning cannot revive the prior page episode",
  );
  assert.equal(
    state.api.readLibraryInventory(state.id, origin).length,
    1,
    "General discovery remains available after leaving a product",
  );
  state.api.bindLibrarySource(state.id, origin, read.source, page);
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, undefined),
    undefined,
  );
});

test("headings and links without page text cannot authorize numeric guidance until an original is read", async () => {
  const state = setup();
  const result = discovery();
  result.sections[0].text = "";
  const saved = state.save(result);
  const page = {
    productPath: "/products/synthetic-roller",
    pageId: randomUUID(),
  };
  assert.throws(
    () => state.api.bindLibrarySource(state.id, origin, saved.source, page),
    /cannot be bound/,
  );
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, page),
    undefined,
  );
  const read = await state.read(saved);
  assert.deepEqual(
    plain(
      state.api.bindLibrarySource(state.id, origin, read.source, page).source
        .guideIds,
    ),
    [guideId(1)],
  );
});

test("partial PDF failure returns only readable source IDs and never lends authority to a failed companion", async () => {
  const state = setup(async (url) =>
    url.includes("library-1")
      ? new Response(null, { status: 404 })
      : response(),
  );
  const saved = state.save();
  const result = await state.read(saved, [guideId(1), guideId(2)]);
  assert.equal(result.status, "ready");
  assert.deepEqual(plain(result.source.guideIds), [guideId(2)]);
  assert.deepEqual(plain(result.unavailable), [
    { id: guideId(1), reason: "not_found" },
  ]);
  assert.equal(result.files.length, 1);
  assert.equal(result.input.length, 1);
  const failed = await state.read(saved, [guideId(1)]);
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.reason, "not_found");
  assert.equal(state.calls.length, 3, "Failed downloads are not cached");
});

test("refresh rereads bytes, and failed refresh removes old PDF authority instead of silently recovering stale files", async () => {
  let version = 1;
  const state = setup(async () =>
    version === 3
      ? new Response(null, { status: 404 })
      : response(Buffer.from(`%PDF-1.7\nversion ${version}`)),
  );
  const saved = state.save();
  const first = await state.read(saved);
  version = 2;
  const fresh = await state.read(saved, [guideId(1)], { refresh: true });
  assert.notEqual(first.files[0].file_data, fresh.files[0].file_data);
  assert.equal(state.calls.length, 2);
  const page = {
    productPath: "/products/synthetic-roller",
    pageId: randomUUID(),
  };
  state.api.bindLibrarySource(state.id, origin, fresh.source, page);
  version = 3;
  assert.equal(
    (await state.read(saved, [guideId(1)], { refresh: true })).reason,
    "not_found",
  );
  assert.equal(
    state.api.readBoundLibrarySource(state.id, origin, page),
    undefined,
  );
  assert.throws(
    () => state.api.bindLibrarySource(state.id, origin, first.source, page),
    /cannot be bound/,
  );
  assert.equal((await state.read(saved)).reason, "not_found");
  assert.equal(state.calls.length, 4);
});

test("duplicate PDF links share one download while source, file and input arrays remain aligned", async () => {
  const state = setup();
  const input = discovery();
  input.guides[1].url = input.guides[0].url;
  const saved = state.save(input);
  const result = await state.read(saved, [guideId(1), guideId(2)], {
    refresh: true,
  });
  assert.equal(state.calls.length, 1);
  assert.equal(result.input.length, 2);
  assert.equal(result.files.length, result.guides.length);
  assert.equal(result.files[0].file_data, result.files[1].file_data);
  assert.deepEqual(plain(result.source.guideIds), [guideId(1), guideId(2)]);
});

test("caller cancellation after a successful first file throws instead of returning partial guidance", async () => {
  const controller = new AbortController();
  const reason = new Error("Customer ended this turn");
  const state = setup(async (url) => {
    if (url.includes("library-2")) {
      controller.abort(reason);
      throw reason;
    }
    return response();
  });
  const saved = state.save();
  await assert.rejects(
    state.read(saved, [guideId(1), guideId(2)], { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(state.calls.length, 2);
  assert.equal(state.timers.size, 0);
});

test("clearing a conversation during an in-flight download cannot resurrect its cache or product binding", async () => {
  let resolve;
  const state = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const saved = state.save();
  const pending = state.read(saved);
  await setImmediate();
  state.api.clearLibrarySession(state.id);
  resolve(response());
  assert.deepEqual(plain(await pending), {
    status: "unavailable",
    reason: "discovery_unavailable",
  });
  assert.deepEqual(plain(state.api.readLibraryInventory(state.id, origin)), []);
  assert.equal(state.timers.size, 0);
});

test("only two originals per library session remain in memory; immutable discovery TTL also bounds reused files", async () => {
  const state = setup();
  const saved = state.save();
  await state.read(saved, [guideId(1), guideId(2)]);
  await state.read(saved, [guideId(3)]);
  state.advance(16 * 60_000);
  await state.read(saved, [guideId(1), guideId(2)]);
  assert.equal(
    state.calls.length,
    4,
    "The evicted original rereads after the shared downloader TTL; retained original does not",
  );
  state.advance(14 * 60_000);
  assert.equal((await state.read(saved)).reason, "discovery_unavailable");
  assert.equal(state.calls.length, 4);
});

test("entry and byte budgets evict oldest sessions rather than allowing unbounded retained originals", async () => {
  const state = setup();
  const first = state.save();
  for (let index = 0; index < 16; index++)
    state.save(discovery(), randomUUID());
  assert.equal((await state.read(first)).reason, "discovery_unavailable");

  const large = Buffer.alloc(4 * 1024 * 1024, 65);
  large.write("%PDF-1.7\n");
  const budget = setup(async () => response(large));
  const previous = budget.save();
  await budget.read(previous, [guideId(1), guideId(2)]);
  const otherId = randomUUID();
  const other = budget.save(discovery(), otherId);
  await budget.read(other, [guideId(1), guideId(2)], {
    conversationId: otherId,
  });
  assert.deepEqual(
    plain(budget.api.readLibraryInventory(budget.id, origin)),
    [],
  );
  assert.equal(budget.api.readLibraryInventory(otherId, origin).length, 1);
});

test("a new discovery replaces the old library receipt without overwriting the other library", async () => {
  const state = setup();
  const first = state.save();
  const curtains = state.save(discovery("curtains", 0), state.id, {
    ...state.provenance,
    sourceCallId: "call_curtains",
  });
  const replacement = state.save(discovery(), state.id, {
    ...state.provenance,
    sourceCallId: "call_blinds_fresh",
  });
  assert.equal((await state.read(first)).reason, "discovery_unavailable");
  assert.equal((await state.read(replacement)).status, "ready");
  const inventory = state.api.readLibraryInventory(state.id, origin);
  assert.equal(inventory.length, 2);
  assert.equal(
    inventory.find((item) => item.library === "curtains").discoveryId,
    curtains.discoveryId,
  );
});

test("the attachment budget rejects verified URLs before downloading or authorizing a new guide", async () => {
  const state = setup();
  const saved = state.save();
  const attachedUrls = new Set(
    [1, 2, 3].map((id) => `${origin}/cdn/shop/files/previous-${id}.pdf?v=1`),
  );
  const before = [...attachedUrls];
  const result = await state.read(saved, [guideId(1)], {
    attachedUrls,
    refresh: true,
  });
  assert.deepEqual(plain(result), {
    status: "unavailable",
    reason: "document_limit",
  });
  assert.deepEqual([...attachedUrls], before);
  assert.equal(state.calls.length, 0);
  assert.throws(
    () =>
      state.api.selectLibraryGuide(state.id, origin, {
        discoveryId: saved.discoveryId,
        guideId: guideId(1),
      }),
    /no current verified read/,
  );
  assert.throws(
    () =>
      state.api.bindLibrarySource(
        state.id,
        origin,
        { ...saved.source, guideIds: [guideId(1)] },
        { productPath: "/products/synthetic-roller", pageId: randomUUID() },
      ),
    /cannot be bound/,
  );
  assert.deepEqual(
    plain(state.api.readLibraryInventory(state.id, origin)[0].source.guideIds),
    [],
  );

  const allowed = await state.read(saved);
  assert.equal(allowed.status, "ready");
  assert.equal(state.calls.length, 1);
  assert.equal(
    (await state.read(saved, [guideId(1)], { attachedUrls, refresh: true }))
      .reason,
    "document_limit",
  );
  const sharedUrl = new Set([...before.slice(0, 2), discovery().guides[0].url]);
  assert.equal(
    (await state.read(saved, [guideId(1)], { attachedUrls: sharedUrl })).status,
    "ready",
  );
  assert.equal(
    state.calls.length,
    1,
    "A denied refresh neither evicts nor downloads the prior valid original",
  );
  assert.equal(
    state.api.selectLibraryGuide(state.id, origin, {
      discoveryId: saved.discoveryId,
      guideId: guideId(1),
    }).guide.id,
    guideId(1),
  );
});
