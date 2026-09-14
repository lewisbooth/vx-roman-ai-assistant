import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const profile = JSON.parse(
  await readFile(
    new URL(
      "../../extensions/vx-roman-ai-assistant/assets/roman-agent-profile.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function registry(value, name) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${name} must be a JSON object`,
  );
}

test("Roman publishes the required UCP platform registries even when empty", () => {
  // https://ucp.dev/2026-08-25/schemas/profile.json#/$defs/platform_schema
  // https://ucp.dev/2026-08-25/schemas/ucp.json#/$defs/platform_schema
  registry(profile.ucp, "ucp");
  assert.match(profile.ucp.version, /^\d{4}-\d{2}-\d{2}$/);
  registry(profile.ucp.services, "ucp.services");
  registry(profile.ucp.payment_handlers, "ucp.payment_handlers");
  registry(profile.ucp.capabilities, "ucp.capabilities");
  assert.deepEqual(
    profile.ucp.services,
    {},
    "Roman does not host a commerce service",
  );
  assert.deepEqual(
    profile.ucp.payment_handlers,
    {},
    "Roman does not handle payments",
  );
});

test("catalog capabilities declare complete platform metadata with matching schema authority", () => {
  // Unlike response metadata, platform capability entries require spec/schema.
  // https://ucp.dev/2026-08-25/schemas/capability.json#/$defs/platform_schema
  const capabilities = profile.ucp.capabilities;
  assert.deepEqual(Object.keys(capabilities).sort(), [
    "dev.shopify.catalog",
    "dev.ucp.shopping.catalog.lookup",
    "dev.ucp.shopping.catalog.search",
  ]);
  for (const [name, entries] of Object.entries(capabilities)) {
    assert.ok(
      Array.isArray(entries) && entries.length > 0,
      `${name} must declare a supported version`,
    );
    for (const entry of entries) {
      assert.equal(entry.version, profile.ucp.version);
      const spec = new URL(entry.spec);
      const schema = new URL(entry.schema);
      assert.equal(spec.protocol, "https:");
      assert.equal(schema.protocol, "https:");
      assert.equal(
        schema.hostname,
        name.split(".").slice(0, 2).reverse().join("."),
      );
      assert.ok(schema.pathname.includes(`/${profile.ucp.version}/`));
      for (const parent of Array.isArray(entry.extends)
        ? entry.extends
        : entry.extends
          ? [entry.extends]
          : []) {
        assert.ok(
          capabilities[parent]?.some(
            (capability) => capability.version === entry.version,
          ),
          `${name} requires its parent ${parent}`,
        );
      }
    }
  }
});
