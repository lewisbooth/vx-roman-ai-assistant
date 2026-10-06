import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import sharp from "sharp";

const bundle = await build({
  stdin: {
    contents: `export * from './admin/visualizations/image.server'; export * from './admin/visualizations/product-images.server'; export * from './admin/visualizations/provider.server'; export * from './admin/visualizations/prompt.server'; export * from './admin/visualizations/usage.server';`,
    resolveDir: cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["sharp"],
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const {
  imageCanvasForPhoto,
  parseImageCanvas,
  normalizeRoomPhoto,
  normalizeProductImage,
  validateProviderImage,
  isPublicImageAddress,
  validateProductImageUrl,
  fetchProductReferences,
  buildVisualizationPrompt,
  productNameGuidance,
  productImageRolePrompt,
  readImageProviderUsage,
  jsonHasDuplicateKeys,
  generateVisualizationAttempt,
  PRIMARY_IMAGE_MODEL,
  FALLBACK_IMAGE_MODEL,
} = module.exports;

const photo = (width = 32, height = 24) =>
  sharp({ create: { width, height, channels: 3, background: "#decab1" } })
    .png()
    .toBuffer();

test("1K canvas preserves donor rational selection, largest tie-break and portrait transpose", () => {
  const cases = [
    [1000, 1000, "1024x1024"],
    [4000, 3000, "1152x864"],
    [3000, 2000, "1248x832"],
    [1920, 1080, "1280x720"],
    [1120, 2000, "672x1200"],
    [2000, 1000, "1440x720"],
    [3000, 1000, "1728x576"],
    [10000, 1000, "1728x576"],
    [1, 1, "1024x1024"],
    [2, 1, "1440x720"],
    [2147483647, 1, "1728x576"],
    [2147483647, 2147483647, "1024x1024"],
  ];
  for (const [width, height, expected] of cases) {
    assert.equal(imageCanvasForPhoto(width, height).size, expected);
    const result = imageCanvasForPhoto(height, width);
    assert.equal(result.size, expected.split("x").reverse().join("x"));
  }
  for (const invalid of [
    "auto",
    "1024X1024",
    "01024x1024",
    "800x800",
    "1040x1024",
    "2000x400",
    "1024x1024 ",
  ])
    assert.throws(() => parseImageCanvas(invalid));
  for (const dimensions of [
    [0, 1],
    [1, -1],
    [1.5, 1],
  ])
    assert.throws(() => imageCanvasForPhoto(...dimensions));
});

test("room normalization stores the exact legal canvas with metadata removed; product images never upscale", async () => {
  const source = await sharp(await photo(80, 40))
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const { image, canvas } = await normalizeRoomPhoto(source, {
    contentType: "image/jpeg",
  });
  assert.equal(canvas.size, "720x1440");
  assert.equal(image.width, canvas.width);
  assert.equal(image.height, canvas.height);
  assert.match(image.sha256, /^[a-f0-9]{64}$/);
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.format, "jpeg");
  const reference = await normalizeProductImage(await photo(3, 2));
  assert.deepEqual([reference.width, reference.height], [3, 2]);
  const resized = await normalizeProductImage(await photo(1600, 1200));
  assert.ok(resized.width * resized.height <= 1_048_576);
  assert.ok(
    Math.abs(resized.width / resized.height - 4 / 3) < 1 / resized.height,
  );
  await assert.rejects(
    validateProviderImage(image.bytes, parseImageCanvas("1024x1024")),
    { code: "image_canvas_mismatch" },
  );
});

test("image boundary rejects spoofed, animated/unsupported, incomplete, oversized and cancelled inputs", async () => {
  const source = await photo();
  await assert.rejects(
    normalizeRoomPhoto(source, { contentType: "image/jpeg" }),
    { code: "image_type_mismatch" },
  );
  await assert.rejects(
    normalizeRoomPhoto(source.subarray(0, source.length - 12)),
    { code: "image_invalid" },
  );
  await assert.rejects(normalizeRoomPhoto(Buffer.alloc(0)), {
    code: "image_empty",
  });
  await assert.rejects(normalizeRoomPhoto(Buffer.alloc(25 * 1024 * 1024 + 1)), {
    code: "image_too_large",
  });
  const gif = await sharp(source).gif().toBuffer();
  await assert.rejects(normalizeRoomPhoto(gif), {
    code: "image_format_unsupported",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    normalizeRoomPhoto(source, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("bounded native processing rejects queue overflow and releases permits after failure/cancellation", async () => {
  const source = await photo();
  const pending = Array.from({ length: 12 }, () =>
    normalizeProductImage(source),
  );
  await assert.rejects(normalizeProductImage(source), {
    code: "image_processing_busy",
  });
  const results = await Promise.all(pending);
  assert.equal(results.length, 12);
  const failed = Array.from({ length: 12 }, () =>
    normalizeProductImage(Buffer.from("bad")),
  );
  const outcomes = await Promise.allSettled(failed);
  assert.ok(outcomes.every((item) => item.status === "rejected"));
  assert.ok(await normalizeProductImage(source));
});

test("queued cancellation removes the waiter without consuming a native permit", async () => {
  const source = await photo();
  const active = Array.from({ length: 4 }, () => normalizeProductImage(source));
  const controller = new AbortController();
  const cancelled = normalizeProductImage(source, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const queued = Array.from({ length: 8 }, () => normalizeProductImage(source));
  await Promise.all([...active, ...queued]);
  assert.ok(await normalizeProductImage(source));
});

test("prompt preserves sole-base-scene, installation scale, blackout/pane cues and explicit cleanup", () => {
  const prompt = buildVisualizationPrompt({
    productTitle: "BiFold ClickFIT DuoShade Navy Blackout Pleated Blind",
    cleanup: true,
    roles: ["installation", "detail"],
    targetDescription: "Left kitchen window",
    configurationSummary:
      "Lining: Blackout; Control Options: Electric SmartView",
  });
  assert.match(prompt, /sole base scene/);
  assert.match(prompt, /magnification must never override the roomset's scale/);
  assert.match(prompt, /Do not show sunlight transmitting through the fabric/);
  assert.match(prompt, /mounts individually at each glass pane/);
  assert.match(prompt, /Image 2 \(product reference 1\): installation/);
  assert.match(prompt, /Image 3 \(product reference 2\): detail/);
  assert.match(prompt, /OPTIONAL ROOM CLEANUP/);
  assert.match(prompt, /CUSTOMER TARGET \(untrusted placement description/);
  assert.match(prompt, /SELECTED OPTIONS \(untrusted storefront labels/);
  assert.match(prompt, /do not establish hidden dimensions, exact scale/);
  assert.throws(
    () =>
      buildVisualizationPrompt({
        productTitle: "Blind",
        cleanup: false,
        configurationSummary: "x".repeat(1201),
      }),
    /bounded configuration summary/,
  );
  assert.doesNotMatch(
    buildVisualizationPrompt({
      productTitle: "Roman blind",
      cleanup: false,
      roles: ["unknown"],
    }),
    /OPTIONAL ROOM CLEANUP|PRODUCT REFERENCE ROLES/,
  );
  assert.equal(productImageRolePrompt(undefined), "");
  assert.match(
    productNameGuidance("Blackout Curtains"),
    /does not cover or darken exposed glass/,
  );
  assert.throws(() =>
    buildVisualizationPrompt({ productTitle: "bad\nname", cleanup: false }),
  );
});

test("usage is nullable, bounded and sanitized; unsupported cache fields never imply zero or measured splits", () => {
  const usage = {
    input_tokens: 200,
    output_tokens: 40,
    total_tokens: 240,
    input_tokens_details: {
      text_tokens: 80,
      image_tokens: 120,
      cached_tokens: 50,
    },
    output_tokens_details: { image_tokens: 40, text_tokens: 0 },
    secret: "private",
    payload: ["image"],
    "bad-key": 1,
  };
  const parsed = readImageProviderUsage({ usage });
  assert.deepEqual(parsed.usage, {
    textInputTokens: 80,
    textCachedInputTokens: null,
    imageInputTokens: 120,
    imageCachedInputTokens: null,
    imageOutputTokens: 40,
  });
  assert.equal(parsed.usageValid, true);
  assert.doesNotMatch(parsed.usageEvidenceJson, /private|payload|bad-key/);
  const unknown = readImageProviderUsage({}).usage;
  assert.ok(Object.values(unknown).every((count) => count === null));
  for (const invalid of [
    { ...usage, input_tokens: "200" },
    { ...usage, total_tokens: 241 },
    { ...usage, output_tokens_details: { image_tokens: 39, text_tokens: 1 } },
    {
      ...usage,
      input_tokens_details: { text_tokens: 80.5, image_tokens: 120 },
    },
  ]) {
    const result = readImageProviderUsage({ usage: invalid });
    assert.equal(result.usageValid, false);
    assert.deepEqual(result.usage, unknown);
  }
  assert.equal(
    jsonHasDuplicateKeys('{"usage":{"input_tokens":1,"input_tokens":2}}'),
    true,
  );
  assert.equal(
    jsonHasDuplicateKeys('{"usage":{"input_tokens":1,"\\u0069nput_tokens":2}}'),
    true,
  );
  assert.equal(
    jsonHasDuplicateKeys('{"data":[{"image":"a"},{"image":"b"}],"usage":{}}'),
    false,
  );
});

const cdn = "https://cdn.shopify.com";
const shop = "https://shop.example.com";
const productUrl = `${cdn}/s/files/1/1234/5678/files/product.jpg?v=123`;

test("product fetch accepts narrow trusted product paths and only public DNS, before fetching any batch member", async () => {
  for (const address of ["8.8.8.8", "104.16.120.21", "2606:4700::1111"])
    assert.equal(isPublicImageAddress(address), true, address);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "2002:808:808::1",
    "3fff::1",
  ])
    assert.equal(isPublicImageAddress(address), false, address);
  assert.equal(validateProductImageUrl(productUrl, [cdn]).origin, cdn);
  assert.equal(
    validateProductImageUrl(`${shop}/cdn/shop/files/product.jpg`, [shop])
      .origin,
    shop,
  );
  for (const url of [
    "http://cdn.shopify.com/s/files/1/1234/files/product.jpg",
    `${cdn}/admin/product.jpg`,
    "https://cdn.shopify.com.evil.test/s/files/1/1234/files/product.jpg",
    `${cdn}/s/files/1/1234/files/product.jpg#fragment`,
    `https://user:pass@cdn.shopify.com/s/files/1/1234/files/product.jpg`,
  ])
    assert.throws(() => validateProductImageUrl(url, [cdn]), {
      name: "ProductImageError",
    });
  let requests = 0;
  const options = {
    allowedOrigins: [cdn],
    resolve: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    download: async () => {
      requests++;
      return { bytes: await photo(), contentType: "image/png" };
    },
  };
  await assert.rejects(
    fetchProductReferences([{ url: productUrl, role: "unknown" }], options),
    { name: "ProductImageError" },
  );
  assert.equal(requests, 0);
  await assert.rejects(
    fetchProductReferences(
      [
        { url: productUrl, role: "unknown" },
        { url: `${cdn}/bad.png`, role: "unknown" },
      ],
      options,
    ),
  );
  assert.equal(requests, 0);
});

test("product reference download and normalization preserve order/roles and run sequentially", async () => {
  let active = 0;
  let maximum = 0;
  const references = [
    { url: productUrl, role: "installation" },
    { url: productUrl.replace("product.jpg", "detail.jpg"), role: "detail" },
  ];
  const prepared = await fetchProductReferences(references, {
    allowedOrigins: [cdn],
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    download: async () => {
      active++;
      maximum = Math.max(maximum, active);
      const bytes = await photo();
      active--;
      return { bytes, contentType: "image/png" };
    },
  });
  assert.equal(maximum, 1);
  assert.deepEqual(
    prepared.map(({ url, role }) => ({ url, role })),
    references,
  );
  assert.equal(prepared[0].image.width, 32);
});

test("reference preparation cancellation aborts pending DNS and never starts a download", async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = fetchProductReferences(
    [{ url: productUrl, role: "unknown" }],
    {
      allowedOrigins: [cdn],
      signal: controller.signal,
      resolve: async () => new Promise(() => {}),
      download: async () => {
        requests++;
        return { bytes: await photo(), contentType: "image/png" };
      },
    },
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests, 0);
});

const room = (await normalizeRoomPhoto(await photo())).image;
const input = (onReceipt, overrides = {}) => ({
  model: PRIMARY_IMAGE_MODEL,
  requestId: "attempt-123",
  ownerId: "owner-123",
  room,
  references: [{ url: productUrl, role: "installation", image: room }],
  productTitle: "Roman Blind",
  cleanup: false,
  signal: new AbortController().signal,
  onReceipt,
  ...overrides,
});
const providerUsage = {
  input_tokens: 200,
  output_tokens: 40,
  total_tokens: 240,
  input_tokens_details: { text_tokens: 80, image_tokens: 120 },
};

test("one provider call uses exact donor settings/order and durably settles usage before result processing", async () => {
  let calls = 0;
  let settled = false;
  const result = await generateVisualizationAttempt(
    input(async (receipt) => {
      assert.equal(receipt.outcome, "succeeded");
      assert.equal(receipt.usage.imageOutputTokens, 40);
      settled = true;
    }),
    {
      apiKey: "test-only-key",
      fetch: async (url, options) => {
        calls++;
        assert.equal(url, "https://api.openai.com/v1/images/edits");
        assert.equal(options.redirect, "error");
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, PRIMARY_IMAGE_MODEL);
        assert.equal(payload.quality, "auto");
        assert.equal(payload.size, `${room.width}x${room.height}`);
        assert.equal(payload.output_format, "jpeg");
        assert.equal(payload.n, 1);
        assert.equal(payload.stream, false);
        assert.equal(payload.images.length, 2);
        assert.ok(
          payload.images.every((image) =>
            image.image_url.startsWith("data:image/jpeg;base64,"),
          ),
        );
        return Response.json(
          {
            data: [{ b64_json: room.bytes.toString("base64") }],
            usage: providerUsage,
          },
          { headers: { "x-request-id": "req_123" } },
        );
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(settled, true);
  assert.equal(result.image.width, room.width);
  assert.equal(result.receipt.providerRequestId, "req_123");
});

test("successful charged reply remains settled when image decoding or receipt persistence fails", async () => {
  let receipts = 0;
  const result = await generateVisualizationAttempt(
    input(async (receipt) => {
      receipts++;
      assert.equal(receipt.outcome, "succeeded");
      assert.equal(receipt.usage.textInputTokens, 80);
    }),
    {
      apiKey: "test-only-key",
      fetch: async () =>
        Response.json({
          data: [{ b64_json: "not base64!" }],
          usage: providerUsage,
        }),
    },
  );
  assert.equal(result.image, null);
  assert.equal(result.imageErrorCode, "provider_image_invalid");
  assert.equal(receipts, 1);
  let calls = 0;
  await assert.rejects(
    generateVisualizationAttempt(
      input(async () => {
        throw new Error("receipt database unavailable");
      }),
      {
        apiKey: "test-only-key",
        fetch: async () => {
          calls++;
          return Response.json({
            data: [{ b64_json: "not base64!" }],
            usage: providerUsage,
          });
        },
      },
    ),
    /receipt database unavailable/,
  );
  assert.equal(calls, 1);
});

test("Flare continuation is permitted only for exact unambiguous primary model rejections", async () => {
  const cases = [
    [404, { error: { code: "model_not_found" } }, true],
    [
      503,
      {
        error: {
          code: "server_is_overloaded",
          type: "service_unavailable_error",
        },
      },
      true,
    ],
    [503, { error: { code: "server_is_overloaded" } }, false],
    [404, { error: { code: "model_not_found" }, usage: null }, false],
    [404, { error: { code: "model_not_found" }, data: [] }, false],
    [500, { error: { code: "model_not_found" } }, false],
    [429, { error: { code: "rate_limit_exceeded" } }, false],
    [403, { error: { code: "model_not_found" } }, false],
    [408, { error: { code: "model_not_found" } }, false],
  ];
  for (const [status, body, expected] of cases) {
    let calls = 0;
    const result = await generateVisualizationAttempt(
      input(async () => {}),
      {
        apiKey: "test-only-key",
        fetch: async () => {
          calls++;
          return Response.json(body, {
            status,
            headers: { "retry-after": "2" },
          });
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.receipt.fallbackEligible, expected);
    assert.equal(result.receipt.retryAfterSeconds, expected ? 2 : null);
    if (expected) assert.equal(result.receipt.outcome, "failed");
  }
  const child = await generateVisualizationAttempt(
    input(async () => {}, { model: FALLBACK_IMAGE_MODEL }),
    {
      apiKey: "test-only-key",
      fetch: async () =>
        Response.json({ error: { code: "model_not_found" } }, { status: 404 }),
    },
  );
  assert.equal(child.receipt.fallbackEligible, false);
});

test("uncertain transport, invalid JSON, duplicate usage and oversized replies never trigger retries", async () => {
  const cases = [
    [
      async () => {
        throw new Error("network failure");
      },
      "provider_connection_failed",
    ],
    [async () => new Response("invalid json"), "provider_invalid_response"],
    [
      async () =>
        new Response(
          '{"error":{"code":"model_not_found"},"error":{"code":"model_not_found"}}',
          { status: 404 },
        ),
      "provider_http_404",
    ],
    [
      async () =>
        new Response("{}", {
          headers: { "content-length": String(16 * 1024 * 1024 + 1) },
        }),
      "provider_response_too_large",
    ],
  ];
  for (const [fetcher, expected] of cases) {
    let calls = 0;
    let receipts = 0;
    const result = await generateVisualizationAttempt(
      input(async () => {
        receipts++;
      }),
      {
        apiKey: "test-only-key",
        fetch: async (...args) => {
          calls++;
          return fetcher(...args);
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(receipts, 1);
    assert.equal(result.receipt.errorCode, expected);
    assert.equal(result.receipt.fallbackEligible, false);
  }
});

test("actual streamed body bounds and cancelled primary still record one unknown receipt", async () => {
  let cancelled = false;
  let receipts = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const tooLarge = await generateVisualizationAttempt(
    input(async () => {
      receipts++;
    }),
    {
      apiKey: "test-only-key",
      fetch: async () => new Response(stream),
    },
  );
  assert.equal(tooLarge.receipt.errorCode, "provider_response_too_large");
  assert.equal(tooLarge.receipt.outcome, "unknown");
  assert.equal(cancelled, true);
  assert.equal(receipts, 1);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const stopped = await generateVisualizationAttempt(
    input(
      async () => {
        receipts++;
      },
      { signal: controller.signal },
    ),
    {
      apiKey: "test-only-key",
      fetch: async () => {
        calls++;
        throw new Error("should not dispatch");
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(stopped.receipt.errorCode, "provider_cancelled");
  assert.equal(stopped.receipt.fallbackEligible, false);
  assert.equal(receipts, 2);
});

test("large image-string scanning stays linear and accepts no duplicate billing keys", () => {
  const text = JSON.stringify({
    data: [{ b64_json: "A".repeat(14 * 1024 * 1024) }],
    usage: providerUsage,
  });
  assert.equal(jsonHasDuplicateKeys(text), false);
});
