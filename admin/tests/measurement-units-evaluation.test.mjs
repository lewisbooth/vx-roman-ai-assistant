import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  createConfigurationFixture,
  gradeConfigurationReply,
  parseEvaluationOptions,
} from "../evals/configuration.mjs";
import { measurementUnitCases } from "../evals/measurement-units.mjs";

const bundle = await build({
  stdin: {
    contents: `
      export {parseProductConfigurationResult} from './shared/product-configuration.ts';
      export {parseMeasurementCall, parseMeasurementToolResult, parseApplyMeasurementsResult} from './shared/measurements.ts';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(module, module.exports);
const { parseProductConfigurationResult, parseMeasurementCall, parseMeasurementToolResult, parseApplyMeasurementsResult } = module.exports;

const mixed = measurementUnitCases.find(({ name }) => name === "mixed-measurement-units");

async function applyPair(sample) {
  const fixture = createConfigurationFixture(sample);
  const productPath = fixture.productPath;
  const config = await fixture.execute("read", "get_product_configuration", { productPath });
  parseProductConfigurationResult("get_product_configuration", config);
  const input = { productPath, ...sample.expected, kind: "order", mount: "recess" };
  parseMeasurementCall("set_measurements", input);
  const saved = await fixture.execute("save", "set_measurements", input);
  parseMeasurementToolResult(saved);
  const applied = await fixture.execute("apply", "apply_measurements", { productPath });
  parseApplyMeasurementsResult(applied);
  const final = await fixture.execute("reread", "get_product_configuration", { productPath });
  parseProductConfigurationResult("get_product_configuration", final);
  return { fixture, saved, applied, final };
}

function completedReply(sample) {
  return {
    text: `${sample.conversion ? "Your 1800mm drop is 180cm. " : ""}I entered 120cm × 180cm, with Recess fitting. The configured blind is £93.60.`,
    questionPresentation: {
      question: "What would you like to do next?",
      answers: ["Add product to cart", "Explore options", "Change measurements"],
    },
  };
}

test("measurement cases share the existing bounded configuration runner in both channels", () => {
  const { samples, maxRequests } = parseEvaluationOptions([
    `--case=${measurementUnitCases.map(({ name }) => name).join(",")}`,
  ]);
  assert.equal(samples.length, 10);
  assert.equal(maxRequests, 60);
  assert.deepEqual(new Set(samples.map(({ mode }) => mode)), new Set(["text", "voice"]));
  assert.ok(samples.every(({ measurementUnits }) => measurementUnits));
});

test("mixed explicit units and unlabeled continuation save and apply the exact inherited cm pair", async () => {
  for (const sample of measurementUnitCases.filter(({ expected }) => expected)) {
    for (const mode of ["text", "voice"]) {
      const { fixture, saved, final } = await applyPair(sample);
      assert.deepEqual(saved.draft, {
        productPath: fixture.productPath,
        ...sample.expected,
        kind: "order",
        mount: "recess",
        updatedAt: "2026-10-02T09:01:00.000Z",
      });
      assert.equal(final.measurements.width, 120);
      assert.equal(final.measurements.height, 180);
      assert.equal(final.measurements.unit, "cm");
      assert.equal(final.configuredPrice, "GBP 93.60");
      assert.deepEqual(gradeConfigurationReply({ ...sample, mode }, fixture, completedReply(sample)), []);
      assert.deepEqual(fixture.operations.map(({ name }) => name), ["get_product_configuration", "set_measurements", "apply_measurements", "get_product_configuration"]);
    }
  }
});

test("completed-pair grading rejects conversion homework, repeated confirmation, missing application and missing quote", async () => {
  const { fixture } = await applyPair(mixed);
  const valid = completedReply(mixed);
  for (const [change, failure] of [
    [{ questionPresentation: { question: "Can you convert the drop to centimetres?", answers: ["Yes", "Help me"] } }, /unit or confirmation/],
    [{ questionPresentation: { question: "Are 120cm wide and 180cm drop correct?", answers: ["Yes", "No"] } }, /unit or confirmation/],
    [{ text: "Please convert your drop. Your 1800mm is 180cm, so the blind is 120cm × 180cm at £93.60." }, /customer was asked/],
    [{ text: "I entered 120cm × 180cm at £93.60." }, /exact drop conversion/],
    [{ text: "Your 1800mm drop is 180cm. I entered 120cm × 180cm." }, /configured price/],
  ]) {
    assert.ok(gradeConfigurationReply(mixed, fixture, { ...valid, ...change }).some(reason => failure.test(reason)));
  }
  const incomplete = { ...fixture, operations: fixture.operations.filter(({ name }) => name !== "apply_measurements") };
  assert.ok(gradeConfigurationReply(mixed, incomplete, valid).some(reason => /not applied/.test(reason)));
  const stale = { ...fixture, operations: fixture.operations.slice(0, -1) };
  assert.ok(gradeConfigurationReply(mixed, stale, valid).some(reason => /settled quote/.test(reason)));
});

test("the fresh configuration supplied in history can validate entry but cannot substitute for the settled reread", async () => {
  const fixture = createConfigurationFixture(mixed);
  const productPath = fixture.productPath;
  const input = { productPath, ...mixed.expected, kind: "order", mount: "recess" };
  parseMeasurementToolResult(await fixture.execute("save", "set_measurements", input));
  parseApplyMeasurementsResult(await fixture.execute("apply", "apply_measurements", { productPath }));
  const reply = completedReply(mixed);
  assert.ok(gradeConfigurationReply(mixed, fixture, reply).some(reason => /settled quote/.test(reason)));
  const final = await fixture.execute("reread", "get_product_configuration", { productPath });
  parseProductConfigurationResult("get_product_configuration", final);
  assert.deepEqual(gradeConfigurationReply(mixed, fixture, reply), []);
  assert.deepEqual(fixture.operations.map(({ name }) => name), ["set_measurements", "apply_measurements", "get_product_configuration"]);
});

test("measurement fixtures reject altered values, replayed application and unrequested cart actions", async () => {
  for (const changes of [
    { width: 120, height: 1800, unit: "cm" },
    { width: 1200, height: 1800, unit: "mm" },
    { width: 120, height: 179.9, unit: "cm" },
  ]) {
    const fixture = createConfigurationFixture(mixed);
    await assert.rejects(fixture.execute("bad-save", "set_measurements", {
      productPath: fixture.productPath, kind: "order", mount: "recess", ...changes,
    }), /preserve both customer readings exactly/);
  }
  const { fixture } = await applyPair(mixed);
  await assert.rejects(fixture.execute("replay", "apply_measurements", { productPath: fixture.productPath }), /Apply once/);
  await assert.rejects(fixture.execute("cart", "add_to_cart", { productPath: fixture.productPath }), /forbids/);
});

test("genuinely ambiguous units, native precision and limits retain an actionable clarification instead of rounded writes", async () => {
  const replies = {
    ambiguity: {
      text: "Check the scale on your tape before entering that drop.",
      questionPresentation: { question: "Which scale was the 1800 read from?", answers: ["Millimetres (mm)", "Centimetres (cm)", "I'll check"] },
    },
    precision: {
      text: "47.25in is 1200.15mm, but this form accepts whole 1mm increments. I haven't rounded or entered it.",
      questionPresentation: { question: "Would you like to recheck the width using a metric tape?", answers: ["Recheck width", "Explore another blind"] },
    },
    range: {
      text: "3000mm is 300cm; this blind's maximum drop is 250cm. I haven't changed your reading or entered it.",
      questionPresentation: { question: "Would you like to recheck the drop or choose another blind?", answers: ["Recheck drop", "Explore another blind"] },
    },
  };
  for (const sample of measurementUnitCases.filter(({ issue }) => issue)) {
    const fixture = createConfigurationFixture(sample);
    const config = await fixture.execute("read", "get_product_configuration", { productPath: fixture.productPath });
    parseProductConfigurationResult("get_product_configuration", config);
    assert.deepEqual(config.measurements.availableUnits, ["cm", "mm"]);
    assert.equal(config.measurements.constraints[0].height.max, 250);
    assert.equal(config.measurements.constraints[1].width.step, 1);
    const reply = replies[sample.issue];
    assert.deepEqual(gradeConfigurationReply(sample, fixture, reply), []);
    const wrong = { ...reply, text: "Everything is entered.", questionPresentation: { question: "What next?", answers: ["Add to cart"] } };
    assert.ok(gradeConfigurationReply(sample, fixture, wrong).length > 0);
    await assert.rejects(fixture.execute("invalid-save", "set_measurements", {
      productPath: fixture.productPath, width: 120, height: 180, unit: "cm", kind: "order", mount: "recess",
    }), /Unresolved units or native limits/);
    assert.ok(gradeConfigurationReply(sample, fixture, reply).some(reason => /silently saved or applied/.test(reason)));
  }
});

test("conversion uses prior guide authority and cannot trigger fresh synthetic PDF input", () => {
  const fixture = createConfigurationFixture(mixed);
  assert.equal(fixture.guideReuse.cached.productPath, fixture.productPath);
  assert.equal(fixture.guideReuse.cached.sourceCallId, fixture.sourceCallId);
  assert.doesNotThrow(() => fixture.onGuideReading(undefined));
  assert.throws(() => fixture.onGuideReading(["measuring"]), /unnecessarily reread/);
  assert.throws(() => fixture.guideReuse.read(), /replaced prior guide evidence/);
  assert.throws(() => fixture.guideReuse.clear(), /invalidated its guide/);
});
