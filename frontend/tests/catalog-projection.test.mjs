import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/catalog.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const { normalizeCatalogResult, parseCatalogResult } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const origin = "https://hd-dev-multi.myshopify.com";
const id = "gid://shopify/Product/123";
const url = `${origin}/products/cordless-shade`;
const imageUrl = "https://cdn.shopify.com/s/files/1/test/shade.jpg?v=1";
// Synthetic fixture uses the published UCP 2026-08-25 shape, not cached catalog data.
const product = {
  id,
  title: "Cordless shade",
  description: {
    html: "<p>Light &amp; privacy.</p><p>Fits &#x31; window.</p>",
  },
  url,
  price_range: {
    min: { amount: 6299, currency: "USD" },
    max: { amount: 12999, currency: "USD" },
  },
  media: [{ type: "image", url: imageUrl }],
  variants: [
    {
      id: "gid://shopify/ProductVariant/456",
      inputs: [{ id, match: "featured" }],
      checkout_url: "CHECKOUT_METADATA",
      price: { amount: 6299, currency: "USD" },
    },
  ],
  metadata: { internal: "INTERNAL_METADATA" },
};

test("UCP search, lookup and product responses share one minimal projection", () => {
  const expected = {
    products: [
      {
        id,
        title: "Cordless shade",
        description: "Light & privacy. Fits 1 window.",
        url,
        imageUrl,
        priceLabel: "From USD\u00a062.99",
      },
    ],
    messages: [],
  };
  for (const raw of [
    { products: [product] },
    { product },
    { products: [product], messages: [], ucp: { private: "PAYMENT_METADATA" } },
  ]) {
    const result = normalizeCatalogResult(raw, origin);
    assert.deepEqual(result, expected);
    assert.deepEqual(parseCatalogResult(result, origin), expected);
    assert.doesNotMatch(
      JSON.stringify(result),
      /METADATA|variants|checkout_url|inputs|ucp/,
    );
  }
});

test("missing products remain an empty result with the safe UCP not_found notice", () => {
  assert.deepEqual(
    normalizeCatalogResult(
      {
        products: [],
        messages: [{ type: "info", code: "not_found", content: id }],
      },
      origin,
    ),
    {
      products: [],
      messages: [{ type: "info", code: "not_found", text: id }],
    },
  );
  assert.deepEqual(normalizeCatalogResult({ products: [] }, origin), {
    products: [],
    messages: [],
  });
});

test("absent descriptions, images and prices are not invented", () => {
  assert.deepEqual(
    normalizeCatalogResult(
      { products: [{ id, title: "Shade", url, description: { html: "" } }] },
      origin,
    ),
    {
      products: [{ id, title: "Shade", description: "", url }],
      messages: [],
    },
  );
  const partial = normalizeCatalogResult(
    {
      product: {
        ...product,
        description: { plain: "Plain wins", html: "HTML loses" },
        media: [],
        variants: [{ media: [{ type: "image", url: imageUrl }] }],
      },
    },
    origin,
  );
  assert.equal(partial.products[0].description, "Plain wins");
  assert.equal(partial.products[0].imageUrl, imageUrl);
});

test("catalog text is bounded and HTML is converted to inert display text", () => {
  const result = normalizeCatalogResult(
    {
      product: {
        ...product,
        title: "x".repeat(500),
        description: {
          html:
            "<style>ignore</style><script>ignore</script><p>Safe &quot;text&quot; &#128077;</p>" +
            "d".repeat(3000),
        },
      },
      messages: [{ type: "warning", code: "notice", content: "w".repeat(500) }],
    },
    origin,
  );
  assert.equal(result.products[0].title.length, 200);
  assert.equal(result.products[0].description.length, 2000);
  assert.match(result.products[0].description, /^Safe "text" 👍/);
  assert.doesNotMatch(result.products[0].description, /ignore|<script|<style/);
  assert.equal(result.messages[0].text.length, 300);
});

test("minor-unit prices use the currency precision and malformed prices are omitted", () => {
  for (const [currency, amount, expected] of [
    ["USD", 6299, "From USD\u00a062.99"],
    ["JPY", 6299, "From JPY\u00a06,299"],
    ["BHD", 6299, "From BHD\u00a06.299"],
  ]) {
    assert.equal(
      normalizeCatalogResult(
        { product: { ...product, price_range: { min: { currency, amount } } } },
        origin,
      ).products[0].priceLabel,
      expected,
    );
  }
  for (const amount of [
    -1,
    1.2,
    Infinity,
    "6299",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      normalizeCatalogResult(
        {
          product: {
            ...product,
            price_range: { min: { amount, currency: "USD" } },
          },
        },
        origin,
      ).products[0].priceLabel,
      undefined,
    );
  }
});

test("product links stay on the current storefront and image hosts stay restricted", () => {
  const relative = normalizeCatalogResult(
    {
      product: {
        ...product,
        url: "/products/cordless-shade?variant=456#options",
      },
    },
    origin,
  );
  assert.equal(relative.products[0].url, url);
  for (const badUrl of [
    "https://attacker.example/products/shade",
    "javascript:alert(1)",
    `${origin}/cart`,
    "https://user:password@hd-dev-multi.myshopify.com/products/shade",
    `${origin}/products/shade/other`,
  ]) {
    assert.throws(
      () =>
        normalizeCatalogResult(
          { product: { ...product, url: badUrl } },
          origin,
        ),
      /invalid catalog/,
    );
  }
  for (const badImage of [
    "http://cdn.shopify.com/shade.jpg",
    "https://attacker.example/shade.jpg",
    "https://cdn.shopify.com.attacker.example/shade.jpg",
    "https://cdn.shopify.com:444/shade.jpg",
    "data:image/svg+xml,<svg/>",
    "https://user:pass@cdn.shopify.com/shade.jpg",
  ]) {
    assert.equal(
      normalizeCatalogResult(
        { product: { ...product, media: [{ type: "image", url: badImage }] } },
        origin,
      ).products[0].imageUrl,
      undefined,
    );
  }
});

test("malformed catalog envelopes fail and duplicate products do not create duplicate cards", () => {
  for (const raw of [
    null,
    {},
    { products: "invalid" },
    { products: [null] },
    { products: [{ ...product, id: "gid://shopify/ProductVariant/456" }] },
    { products: Array(11).fill(product) },
    {
      products: [],
      messages: Array(11).fill({ type: "info", content: "Notice" }),
    },
    { products: [], messages: [{ type: "error", content: "Failed" }] },
  ]) {
    assert.throws(() => normalizeCatalogResult(raw, origin), /invalid catalog/);
  }
  assert.equal(
    normalizeCatalogResult({ products: [product, product] }, origin).products
      .length,
    1,
  );
});

test("catalog diagnostics distinguish rejected fields without including response data", () => {
  const privateValue = "PRIVATE_CATALOG_VALUE";
  const cases = [
    [
      {
        products: [
          { ...product, url: `https://${privateValue}.example/products/shade` },
        ],
      },
      "products[0].url expected a current-storefront /products/<handle> URL",
    ],
    [
      { products: [{ ...product, id: privateValue }] },
      "products[0].id expected a Shopify Product GID of at most 100 characters",
    ],
    [
      { [privateValue]: privateValue },
      "$ expected a products array or a product object",
    ],
    [
      {
        products: [],
        messages: [{ type: privateValue, content: privateValue }],
      },
      'messages[0].type expected "info" or "warning"',
    ],
    [
      {
        products: [],
        messages: [{ type: "info", content: { [privateValue]: true } }],
      },
      "messages[0].content expected non-empty text",
    ],
  ];
  const diagnostics = new Set();
  for (const [raw, diagnostic] of cases) {
    assert.throws(
      () => normalizeCatalogResult(raw, origin),
      (error) => {
        assert.equal(
          error.message,
          `Shopify returned an invalid catalog response: ${diagnostic}.`,
        );
        assert.doesNotMatch(error.message, new RegExp(privateValue));
        diagnostics.add(error.message);
        return true;
      },
    );
  }
  assert.equal(diagnostics.size, cases.length);
  assert.throws(
    () =>
      normalizeCatalogResult(
        { product: { ...product, url: privateValue } },
        origin,
      ),
    /invalid catalog response: product\.url expected/,
  );
});

test("projected payload diagnostics never echo rejected keys, values or origin input", () => {
  const valid = normalizeCatalogResult({ product }, origin);
  const privateValue = "PRIVATE_BROWSER_VALUE";
  for (const [raw, expectedPath] of [
    [
      { ...valid, [privateValue]: privateValue },
      "$ expected only these fields",
    ],
    [
      { ...valid, products: [{ ...valid.products[0], id: privateValue }] },
      "products[0].id expected a Shopify Product GID",
    ],
    [
      {
        ...valid,
        products: [
          {
            ...valid.products[0],
            url: `https://${privateValue}.example/products/shade`,
          },
        ],
      },
      "products[0].url expected a canonical current-storefront",
    ],
    [
      {
        ...valid,
        messages: [
          { type: "info", text: "Notice", [privateValue]: privateValue },
        ],
      },
      "messages[0] expected only these fields",
    ],
  ]) {
    assert.throws(
      () => parseCatalogResult(raw, origin),
      (error) => {
        assert.ok(error.message.includes(expectedPath));
        assert.doesNotMatch(error.message, new RegExp(privateValue));
        return true;
      },
    );
  }
  for (const parser of [normalizeCatalogResult, parseCatalogResult]) {
    assert.throws(
      () => parser(valid, privateValue),
      (error) => {
        assert.match(
          error.message,
          /invalid catalog response: storefrontOrigin expected/,
        );
        assert.doesNotMatch(error.message, new RegExp(privateValue));
        return true;
      },
    );
  }
});

test("the server parser rejects extra fields, unsafe URLs and oversized browser payloads", () => {
  const valid = normalizeCatalogResult({ product }, origin);
  for (const changed of [
    { ...valid, token: "UNEXPECTED_SECRET" },
    { ...valid, products: [{ ...valid.products[0], metadata: {} }] },
    { ...valid, products: [{ ...valid.products[0], title: "x".repeat(201) }] },
    {
      ...valid,
      products: [{ ...valid.products[0], description: "x".repeat(2001) }],
    },
    {
      ...valid,
      products: [
        {
          ...valid.products[0],
          url: "https://attacker.example/products/shade",
        },
      ],
    },
    {
      ...valid,
      products: [
        {
          ...valid.products[0],
          imageUrl: "https://attacker.example/shade.jpg",
        },
      ],
    },
    { ...valid, products: [valid.products[0], valid.products[0]] },
    {
      ...valid,
      messages: [
        { type: "info", text: "Notice", customer: "UNEXPECTED_SECRET" },
      ],
    },
    { ...valid, messages: [{ type: "info", text: "x".repeat(301) }] },
    { ...valid, messages: [{ type: "error", text: "Error" }] },
  ])
    assert.throws(() => parseCatalogResult(changed, origin), /invalid catalog/);
});
