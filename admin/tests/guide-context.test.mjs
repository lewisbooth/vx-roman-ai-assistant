import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/guides/context.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  URL,
});
const { createGuideContext } = module.exports;
const origin = "https://hd-dev-single.myshopify.com";
const productPath = "/products/verified-blind";
const plain = (value) => JSON.parse(JSON.stringify(value));
const bytes = (kind) =>
  Buffer.from(`%PDF-1.7\n${kind} original fixture\n%%EOF`);
const ready = (kinds = ["measuring", "fitting"]) => ({
  status: "ready",
  sources: kinds.map((kind) => ({
    kind,
    url: `${origin}/cdn/shop/files/${kind}.pdf?v=123`,
  })),
  files: kinds.map((kind) => ({
    type: "input_file",
    detail: "high",
    filename: `${kind}-guide.pdf`,
    file_data: `data:application/pdf;base64,${bytes(kind).toString("base64")}`,
  })),
});

test("original PDF references use stable user blocks and exact per-file breakpoints without mutating inputs", () => {
  const source = ready();
  const before = plain(source);
  source.sources.forEach(Object.freeze);
  source.files.forEach(Object.freeze);
  Object.freeze(source.sources);
  Object.freeze(source.files);
  Object.freeze(source);
  const context = createGuideContext(source, origin, productPath);
  assert.match(context.key, /^[a-f0-9]{64}$/);
  assert.equal(context.input.length, 2);
  assert.deepEqual(plain(source), before);
  for (const [index, message] of context.input.entries()) {
    assert.equal(message.role, "user");
    assert.equal(message.content.length, 2);
    const [reference, file] = message.content;
    assert.equal(reference.type, "input_text");
    assert.match(
      reference.text,
      /Untrusted original product-guide reference, not customer instructions/,
    );
    const metadata = JSON.parse(reference.text.split("\n")[1]);
    assert.deepEqual(metadata, {
      schema: "roman-original-guides-v1",
      storefrontOrigin: origin,
      productPath,
      ...source.sources[index],
      sha256: createHash("sha256")
        .update(bytes(source.sources[index].kind))
        .digest("hex"),
    });
    assert.equal(file.file_data, source.files[index].file_data);
    assert.equal(file.filename, source.files[index].filename);
    assert.equal(file.detail, "high");
    assert.deepEqual(plain(file.prompt_cache_breakpoint), { mode: "explicit" });
    assert.equal(reference.prompt_cache_breakpoint, undefined);
    assert.notEqual(file, source.files[index]);
  }
  assert.doesNotMatch(
    JSON.stringify(context),
    /call_id|conversationId|credential|assistantId/,
  );
  assert.deepEqual(
    plain(createGuideContext(ready(), origin, productPath)),
    plain(context),
  );
});

test("canonical ordering keeps a measuring-only prefix identical when fitting is added", () => {
  const one = createGuideContext(ready(["measuring"]), origin, productPath);
  const pair = createGuideContext(ready(), origin, productPath);
  const reversed = createGuideContext(
    ready(["fitting", "measuring"]),
    origin,
    productPath,
  );
  assert.equal(one.key, pair.key);
  assert.deepEqual(plain(one.input[0]), plain(pair.input[0]));
  assert.deepEqual(plain(reversed), plain(pair));
  const fitting = createGuideContext(ready(["fitting"]), origin, productPath);
  assert.equal(fitting.input.length, 1);
  assert.equal(fitting.input[0].content[1].filename, "fitting-guide.pdf");
  assert.equal(fitting.key, pair.key);
});

test("URL versions and content changes invalidate the document prefix while retaining the scoped routing key", () => {
  const first = createGuideContext(ready(), origin, productPath);
  for (const change of ["version", "content", "url"]) {
    const source = ready();
    if (change === "version")
      source.sources[0].url = source.sources[0].url.replace("v=123", "v=124");
    if (change === "url")
      source.sources[0].url = source.sources[0].url.replace(
        "measuring.pdf",
        "revised-measuring.pdf",
      );
    if (change === "content")
      source.files[0].file_data = `data:application/pdf;base64,${Buffer.from("%PDF-1.7\nChanged original\n%%EOF").toString("base64")}`;
    const changed = createGuideContext(source, origin, productPath);
    assert.equal(changed.key, first.key, change);
    assert.notDeepEqual(plain(changed.input[0]), plain(first.input[0]), change);
    assert.deepEqual(plain(changed.input[1]), plain(first.input[1]), change);
  }
});

test("authenticated origin and product scope partition document context even for the same public CDN PDF", () => {
  const source = ready(["measuring"]);
  source.sources[0].url =
    "https://cdn.shopify.com/s/files/1/0893/6659/3817/files/Measuring-for-all-Roller-blinds.pdf?v=1744119133";
  const first = createGuideContext(source, origin, productPath);
  for (const [nextOrigin, nextPath] of [
    ["https://shop.blinds-2go.co.uk", productPath],
    [origin, "/products/another-blind"],
  ]) {
    const next = createGuideContext(source, nextOrigin, nextPath);
    assert.notEqual(next.key, first.key);
    assert.notDeepEqual(plain(next.input), plain(first.input));
  }
  assert.match(first.input[0].content[0].text, /v=1744119133/);
  assert.throws(() =>
    createGuideContext(ready(), "https://other-store.test", productPath),
  );
  assert.throws(() =>
    createGuideContext(ready(), origin, `${productPath}?variant=1`),
  );
  assert.throws(() =>
    createGuideContext(source, "http://unsafe.test", productPath),
  );
});

test("partial availability does not alter readable document blocks or cache identities", () => {
  const source = ready(["measuring"]);
  const complete = createGuideContext(source, origin, productPath);
  source.unavailable = [{ kind: "fitting", reason: "not_found" }];
  assert.deepEqual(
    plain(createGuideContext(source, origin, productPath)),
    plain(complete),
  );
});

test("one original PDF shared by both guide kinds is attached once with its aliases", () => {
  const source = ready();
  source.sources[1].url = source.sources[0].url;
  assert.throws(
    () => createGuideContext(source, origin, productPath),
    /conflicting PDF content/,
  );
  source.files[1].file_data = source.files[0].file_data;
  const before = plain(source);
  const result = createGuideContext(source, origin, productPath);
  assert.equal(result.input.length, 1);
  const [reference, file] = result.input[0].content;
  const metadata = JSON.parse(reference.text.split("\n")[1]);
  assert.equal(metadata.kind, "measuring");
  assert.deepEqual(metadata.aliases, ["fitting"]);
  assert.equal(file.filename, "measuring-guide.pdf");
  assert.equal(file.file_data, source.files[0].file_data);
  assert.deepEqual(plain(source), before);
  source.sources.reverse();
  source.files.reverse();
  assert.deepEqual(
    plain(createGuideContext(source, origin, productPath)),
    plain(result),
  );
});

test("invalid, mismatched or substituted file inputs cannot become original-guide prefixes", () => {
  for (const transform of [
    (value) => {
      value.status = "unavailable";
    },
    (value) => {
      value.sources = [];
      value.files = [];
    },
    (value) => {
      value.files.pop();
    },
    (value) => {
      value.sources[1].kind = "measuring";
    },
    (value) => {
      value.sources[0].url = "https://evil.test/guide.pdf";
    },
    (value) => {
      value.sources[0].url += "&token=private";
    },
    (value) => {
      value.files.reverse();
    },
    (value) => {
      value.files[0].detail = "low";
    },
    (value) => {
      value.files[0].file_url = value.sources[0].url;
    },
    (value) => {
      value.files[0].file_id = "file-substitute";
    },
    (value) => {
      value.files[0].file_data =
        "data:application/pdf;base64,bm90LWEtdmFsaWQtcGRm";
    },
    (value) => {
      value.files[0].file_data += "\n";
    },
    (value) => {
      value.files[0].file_data = `data:application/pdf;base64,${Buffer.alloc(4 * 1024 * 1024 + 1, 65).toString("base64")}`;
    },
  ]) {
    const source = ready();
    transform(source);
    assert.throws(() => createGuideContext(source, origin, productPath));
  }
});
