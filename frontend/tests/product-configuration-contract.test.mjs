import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["shared/product-configuration.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { parseProductConfigurationResult: parse } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
function snapshot() {
  return {
    status: "available",
    productPath: "/products/roller",
    configurationId: "10000000-0000-4000-8000-000000000001",
    measurements: null,
    message: "Current native controls.",
    configuredPrice: "£65.89",
    controls: [
      {
        id: "c0",
        label: "Motor",
        kind: "radio",
        options: [
          { id: "o0", label: "Electric", selected: true, available: true },
        ],
      },
      {
        id: "c1",
        label: "Remote",
        kind: "radio",
        parent: { controlId: "c0", optionId: "o0" },
        options: [
          { id: "o0", label: "No remote", selected: true, available: true },
          {
            id: "o1",
            label: "Multi-channel remote",
            selected: false,
            available: true,
            priceLabel: "+ £19.95",
          },
        ],
      },
      {
        id: "c2",
        label: "Mount",
        kind: "select",
        parent: { controlId: "c1", optionId: "o1" },
        options: [
          { id: "o0", label: "Wall", selected: true, available: false },
        ],
      },
    ],
  };
}
test("native hierarchy and distinct option/total prices survive shared validation", () => {
  const input = snapshot();
  assert.deepEqual(parse("get_product_configuration", input), input);
  const result = parse("get_product_configuration", input);
  result.controls[1].parent.optionId = "o1";
  assert.equal(
    input.controls[1].parent.optionId,
    "o0",
    "projected metadata is not a mutable alias",
  );
});

test("historical snapshots preserve absent hierarchy and unknown quote fields", () => {
  const input = snapshot();
  delete input.configuredPrice;
  for (const control of input.controls) {
    delete control.parent;
    for (const option of control.options) delete option.priceLabel;
  }
  assert.deepEqual(parse("get_product_configuration", input), input);
  const missing = {
    status: "unavailable",
    productPath: input.productPath,
    configurationId: null,
    controls: [],
    measurements: null,
    configuredPrice: null,
    message: "Unavailable.",
  };
  assert.deepEqual(parse("get_product_configuration", missing), missing);
});

test("malformed, missing or cyclic parents cannot authorize dependent choices", () => {
  for (const mutate of [
    (s) => (s.controls[1].parent = { controlId: "c9", optionId: "o0" }),
    (s) => (s.controls[1].parent = { controlId: "c0", optionId: "o9" }),
    (s) => (s.controls[1].parent = { controlId: "c1", optionId: "o0" }),
    (s) => (s.controls[0].parent = { controlId: "c1", optionId: "o0" }),
    (s) => (s.controls[1].parent.selector = "input"),
    (s) => (s.controls[1].parent = null),
    (s) => (s.controls[0].options[0].selected = false),
    (s) => (s.controls[0].options[0].available = false),
    (s) => (s.controls[2].options[0].available = true),
  ]) {
    const input = snapshot();
    mutate(input);
    assert.throws(() => parse("get_product_configuration", input));
  }
});

test("quote labels are bounded plain display values with unknown distinct from zero", () => {
  for (const value of [
    "",
    " ",
    "Price unknown",
    "x".repeat(121),
    "£9\n.99",
    19.95,
    { amount: 19.95 },
  ]) {
    const input = snapshot();
    input.configuredPrice = value;
    assert.throws(() => parse("get_product_configuration", input));
  }
  for (const value of ["£0.00", "65,89 €", null]) {
    const input = snapshot();
    input.configuredPrice = value;
    assert.equal(
      parse("get_product_configuration", input).configuredPrice,
      value,
    );
  }
  for (const value of [null, "", "x".repeat(121), "£19.95\nprivate", 19.95]) {
    const input = snapshot();
    input.controls[1].options[1].priceLabel = value;
    assert.throws(() => parse("get_product_configuration", input));
  }
  const unavailable = {
    status: "unavailable",
    productPath: "/products/roller",
    configurationId: null,
    controls: [],
    measurements: null,
    message: "Unavailable.",
    configuredPrice: "£65.89",
  };
  assert.throws(() => parse("get_product_configuration", unavailable));
});
