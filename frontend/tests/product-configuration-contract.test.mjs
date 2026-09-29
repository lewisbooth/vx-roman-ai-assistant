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

function withGuarantee() {
  const input = snapshot();
  input.controls.push({
    id: "c3",
    label: "Guarantee a Perfect Fit",
    kind: "radio",
    purpose: "measurement_guarantee",
    description:
      "Order a replacement of the same blind at no additional charge unless the new measurements are larger.",
    options: [
      {
        id: "o0",
        label: "Don't insure measurements",
        selected: true,
        available: true,
      },
      {
        id: "o1",
        label: "Insure measurements",
        selected: false,
        available: true,
        priceLabel: "+ £12.00",
      },
    ],
  });
  return input;
}

test("the explicit guarantee purpose preserves native terms and separate fee without changing the product quote", () => {
  const input = withGuarantee();
  assert.deepEqual(parse("get_product_configuration", input), input);
  assert.equal(
    parse("get_product_configuration", input).configuredPrice,
    "£65.89",
  );
});

test("guarantee metadata is a bounded, paired contract, not a generic insurance capability", () => {
  for (const change of [
    (c) => delete c.description,
    (c) => delete c.purpose,
    (c) => (c.purpose = "cart_insurance"),
    (c) => (c.description = "x".repeat(1201)),
    (c) => (c.description = "Terms\nprivate"),
    (c) => (c.kind = "checkbox"),
    (c) => (c.parent = { controlId: "c0", optionId: "o0" }),
    (c) => c.options.pop(),
    (c) => (c.confirmed = true),
  ]) {
    const input = withGuarantee();
    change(input.controls[3]);
    assert.throws(() => parse("get_product_configuration", input));
  }
});

function measurementSnapshot() {
  const input = snapshot();
  input.measurements = {
    unit: "mm",
    width: null,
    height: null,
    availableUnits: ["mm", "cm", "in"],
    entry: "single_pair",
    constraints: [
      {
        unit: "mm",
        width: { kind: "number", min: 400, max: 2330, step: 1, stepBase: 400 },
        height: { kind: "number", min: 400, max: 2400, step: 1, stepBase: 400 },
      },
      {
        unit: "cm",
        width: {
          kind: "number",
          min: null,
          max: null,
          step: "any",
          stepBase: 0,
        },
        height: { kind: "number", min: 40, max: 240, step: 0.1, stepBase: 40 },
      },
      {
        unit: "in",
        width: { kind: "select", values: [4, 8, 9] },
        height: { kind: "select", values: [4, 8, 9] },
        fractions: {
          width: { kind: "select", values: [0, 0.125, 0.25, 0.75] },
          height: { kind: "select", values: [0, 0.125, 0.25, 0.75] },
        },
      },
    ],
  };
  return input;
}
test("native measurement constraints survive transport with exact inch parts and no mutable aliases", () => {
  const input = measurementSnapshot(),
    result = parse("get_product_configuration", input);
  assert.deepEqual(result, input);
  result.measurements.constraints[2].fractions.width.values[0] = 0.5;
  assert.equal(input.measurements.constraints[2].fractions.width.values[0], 0);
  result.measurements.constraints[0].width.min = 10;
  assert.equal(input.measurements.constraints[0].width.min, 400);
  delete input.measurements.entry;
  delete input.measurements.constraints;
  assert.deepEqual(
    parse("get_product_configuration", input),
    input,
    "historical measurement results remain readable",
  );
});

test("native measurement constraints reject unsupported units, invalid limits and oversized or ambiguous choices", () => {
  for (const mutate of [
    (m) => (m.entry = "multi_pair"),
    (m) => (m.unit = null),
    (m) => m.constraints.push(m.constraints[0]),
    (m) => (m.constraints[1].unit = "mm"),
    (m) => (m.constraints[1].unit = "feet"),
    (m) => m.availableUnits.pop(),
    (m) => (m.constraints[0].width.min = 3000),
    (m) => (m.constraints[0].width.max = Infinity),
    (m) => (m.constraints[0].width.step = 0),
    (m) => (m.constraints[0].width.stepBase = "0"),
    (m) => (m.constraints[0].width.selector = "input"),
    (m) =>
      (m.constraints[1].fractions = {
        width: { kind: "select", values: [0] },
        height: { kind: "select", values: [0] },
      }),
    (m) => delete m.constraints[2].fractions,
    (m) => (m.constraints[2].width.values = [4, 4]),
    (m) => (m.constraints[2].width.values = [4.5]),
    (m) => (m.constraints[2].fractions.width.values = [1]),
    (m) => (m.constraints[2].fractions.width.values = []),
    (m) =>
      (m.constraints[2].width.values = Array.from(
        { length: 513 },
        (_, i) => i,
      )),
  ]) {
    const input = measurementSnapshot();
    mutate(input.measurements);
    assert.throws(() => parse("get_product_configuration", input));
  }
});
