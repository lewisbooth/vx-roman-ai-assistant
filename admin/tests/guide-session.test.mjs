import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/guides/session.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const origin = "https://hd-dev-single.myshopify.com";
const productPath = "/products/synthetic-roller";
const plain = (value) => JSON.parse(JSON.stringify(value));

function setup() {
  let now = 1_800_000_000_000;
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    URL,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
  });
  const api = module.exports;
  const id = randomUUID();
  const session = (options = {}) => {
    const kinds = options.kinds ?? ["measuring"];
    const bytes = Buffer.alloc(options.fileBytes ?? 64, 65);
    bytes.write("%PDF-1.7\nSynthetic original guide\n");
    return {
      sourceCallId: "call_synthetic-guides",
      sourceAssistantId: randomUUID(),
      productPath,
      expiresAt: now + api.GUIDE_SESSION_TTL_MS,
      kinds,
      origin,
      pageId: randomUUID(),
      sources: kinds.map((kind) => ({
        kind,
        url: `${origin}/cdn/shop/files/${kind}.pdf?v=1`,
      })),
      files: kinds.map((kind) => ({
        type: "input_file",
        detail: "high",
        filename: `${kind}-guide.pdf`,
        file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
      })),
    };
  };
  const read = (saved, conversationId = id) =>
    api.readGuideSession(conversationId, saved.origin, {
      productPath: saved.productPath,
      pageId: saved.pageId,
    });
  return {
    api,
    id,
    session,
    read,
    advance(ms) {
      now += ms;
    },
  };
}

test("cached originals require the same conversation, origin, product and uninterrupted page episode", () => {
  const state = setup();
  const saved = state.session();
  state.api.saveGuideSession(state.id, saved);
  assert.deepEqual(plain(state.read(saved)), saved);
  assert.equal(state.read(saved, randomUUID()), undefined);
  assert.equal(
    state.api.readGuideSession(state.id, "https://other-store.test", saved),
    undefined,
  );
  assert.equal(
    state.api.readGuideSession(state.id, origin, undefined),
    undefined,
  );
  assert.equal(
    state.api.readGuideSession(state.id, origin, {
      productPath: "/products/another-roller",
      pageId: saved.pageId,
    }),
    undefined,
  );
  assert.equal(
    state.api.readGuideSession(state.id, origin, {
      productPath,
      pageId: randomUUID(),
    }),
    undefined,
  );
  assert.deepEqual(
    plain(state.read(saved)),
    saved,
    "Mismatched callers cannot overwrite a session",
  );
  state.api.clearGuideSession(state.id);
  state.api.clearGuideSession(state.id);
  assert.equal(state.read(saved), undefined);
});

test("reads never slide the fixed expiry and expired originals cannot be recovered", () => {
  const state = setup();
  assert.equal(state.api.GUIDE_SESSION_TTL_MS, 30 * 60_000);
  const saved = state.session();
  state.api.saveGuideSession(state.id, saved);
  state.advance(state.api.GUIDE_SESSION_TTL_MS - 1);
  assert.equal(state.read(saved).expiresAt, saved.expiresAt);
  state.api.saveGuideSession(state.id, {
    ...saved,
    expiresAt: saved.expiresAt + 1000,
  });
  assert.equal(
    state.read(saved).expiresAt,
    saved.expiresAt,
    "Saving an unchanged receipt cannot slide expiry either",
  );
  state.advance(1);
  assert.equal(state.read(saved), undefined);
  assert.throws(
    () => state.api.saveGuideSession(state.id, saved),
    /Invalid original-guide session receipt/,
  );
});

test("saved and returned arrays, source metadata and PDF bytes cannot mutate cache authority", () => {
  const state = setup();
  const saved = state.session({ kinds: ["measuring", "fitting"] });
  const expected = plain(saved);
  state.api.saveGuideSession(state.id, saved);
  saved.kinds[0] = "other";
  saved.sources[0].url = "https://evil.test/replaced.pdf";
  saved.files[0].file_data = "changed";
  saved.expiresAt += 1000;
  const read = state.read(expected);
  assert.deepEqual(plain(read), expected);
  for (const item of [
    read,
    read.kinds,
    read.sources,
    read.files,
    ...read.sources,
    ...read.files,
  ])
    assert.equal(Object.isFrozen(item), true);
  assert.throws(
    () => {
      read.kinds.push("fitting");
    },
    { name: "TypeError" },
  );
  assert.throws(
    () => {
      read.sources[0].url = "changed";
    },
    { name: "TypeError" },
  );
  assert.throws(
    () => {
      read.files[0].file_data = "changed";
    },
    { name: "TypeError" },
  );
  assert.throws(
    () => {
      read.sourceAssistantId = randomUUID();
    },
    { name: "TypeError" },
  );
  assert.deepEqual(plain(state.read(expected)), expected);
});

test("entry limit evicts least-recently-used sessions and ignores mismatched reads", () => {
  const state = setup();
  const entries = Array.from({ length: 17 }, () => ({
    id: randomUUID(),
    value: state.session(),
  }));
  for (const { id, value } of entries.slice(0, 16))
    state.api.saveGuideSession(id, value);
  assert.ok(state.read(entries[0].value, entries[0].id));
  state.api.readGuideSession(entries[1].id, origin, {
    productPath,
    pageId: randomUUID(),
  });
  state.api.saveGuideSession(entries[16].id, entries[16].value);
  assert.equal(state.read(entries[1].value, entries[1].id), undefined);
  assert.ok(state.read(entries[0].value, entries[0].id));
  for (const { id, value } of entries.slice(2))
    assert.ok(state.read(value, id));
});

test("the conservative base64 byte budget evicts originals below the entry limit", () => {
  const state = setup();
  const entries = Array.from({ length: 4 }, () => ({
    id: randomUUID(),
    value: state.session({ fileBytes: 3 * 1024 * 1024 }),
  }));
  for (const { id, value } of entries) state.api.saveGuideSession(id, value);
  assert.equal(state.read(entries[0].value, entries[0].id), undefined);
  const retained = entries
    .slice(1)
    .map(({ id, value }) => state.read(value, id));
  assert.ok(retained.every(Boolean));
  assert.ok(
    retained
      .flatMap((session) => session.files)
      .reduce((sum, file) => sum + 2 * file.file_data.length, 0) <=
      32 * 1024 * 1024,
  );
  state.api.clearGuideSession(entries[1].id);
  const replacement = state.session({ fileBytes: 3 * 1024 * 1024 });
  state.api.saveGuideSession(state.id, replacement);
  assert.ok(state.read(entries[2].value, entries[2].id));
  assert.ok(state.read(replacement));
});

test("replacement and expired entries release their full byte accounting", () => {
  const state = setup();
  const large = state.session({ fileBytes: 3 * 1024 * 1024 });
  state.api.saveGuideSession(state.id, large);
  const small = state.session();
  state.api.saveGuideSession(state.id, small);
  assert.deepEqual(plain(state.read(small)), small);
  state.advance(state.api.GUIDE_SESSION_TTL_MS);
  const entries = Array.from({ length: 3 }, () => ({
    id: randomUUID(),
    value: state.session({ fileBytes: 3 * 1024 * 1024 }),
  }));
  for (const { id, value } of entries) state.api.saveGuideSession(id, value);
  assert.equal(state.read(small), undefined);
  for (const { id, value } of entries) assert.ok(state.read(value, id));
});

test("invalid receipts and substituted or mismatched documents never replace validated originals", () => {
  const state = setup();
  const original = state.session();
  state.api.saveGuideSession(state.id, original);
  for (const change of [
    (value) => {
      value.sourceCallId = "";
    },
    (value) => {
      value.sourceCallId = "x".repeat(201);
    },
    (value) => {
      value.sourceAssistantId = "not-an-assistant";
    },
    (value) => {
      value.pageId = "not-a-page";
    },
    (value) => {
      value.expiresAt = NaN;
    },
    (value) => {
      value.expiresAt += 1;
    },
    (value) => {
      value.expiresAt -= state.api.GUIDE_SESSION_TTL_MS;
    },
    (value) => {
      value.kinds = ["fitting"];
    },
    (value) => {
      value.kinds = ["measuring", "measuring"];
    },
    (value) => {
      value.productPath = "/cart";
    },
    (value) => {
      value.productPath += "/";
    },
    (value) => {
      value.sources[0].url = "https://evil.test/guide.pdf";
    },
    (value) => {
      value.sources[0].url += "&token=secret";
    },
    (value) => {
      value.files[0].file_data = "data:application/pdf;base64,eA==";
    },
    (value) => {
      value.files[0].filename = "fitting-guide.pdf";
    },
    (value) => {
      value.files[0].file_id = "substitute";
    },
    (value) => {
      value.prompt = "Must never be stored";
    },
    (value) => {
      value.files = [];
    },
  ]) {
    const bad = state.session();
    change(bad);
    assert.throws(() => state.api.saveGuideSession(state.id, bad));
    assert.deepEqual(plain(state.read(original)), original);
  }
  assert.throws(() =>
    state.api.saveGuideSession("invalid-conversation", original),
  );
});
