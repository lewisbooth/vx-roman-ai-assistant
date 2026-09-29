import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import {
  configurationCases,
  createConfigurationFixture,
  createRequestBudget,
  gradeConfigurationReply,
  parseEvaluationOptions,
} from "../evals/configuration.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export {parseProductConfigurationResult} from "./shared/product-configuration.ts"; export {parseApplyMeasurementsResult} from "./shared/measurements.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(
  module,
  module.exports,
);
const { parseProductConfigurationResult, parseApplyMeasurementsResult } =
  module.exports;
const productPath = "/products/synthetic-ivory-roman";

async function applyRequestedChange(sample) {
  const fixture = createConfigurationFixture(sample);
  const first = await fixture.execute("read", "get_product_configuration", {
    productPath,
  });
  parseProductConfigurationResult("get_product_configuration", first);
  const result = await fixture.execute("change", "configure_product", {
    productPath,
    configurationId: first.configurationId,
    controlId: sample.expectedChange === "remote" ? "c1" : "c0",
    optionId: "o1",
  });
  parseProductConfigurationResult("configure_product", result);
  const final = await fixture.execute("reread", "get_product_configuration", {
    productPath,
  });
  parseProductConfigurationResult("get_product_configuration", final);
  return { fixture, first, final };
}

function replyFor(sample) {
  return sample.remoteDecision === "unresolved"
    ? {
        text: "Electric Smartview is selected. A compatible remote costs an additional GBP 18.00.",
        questionPresentation: {
          question: "Do you need a compatible remote for these controls?",
          answers: [
            "Add 14 Channel Remote Control",
            "I already own a compatible remote",
          ],
        },
      }
    : {
        text: "Your requested option is selected, with the verified dimensions and updated quote.",
        questionPresentation: {
          question: "What would you like to do next?",
          answers: ["Add product to cart", "Change measurements"],
        },
      };
}

test("evaluation selects both channels by default and rejects invalid or unbounded requests", () => {
  const defaults = parseEvaluationOptions([]);
  assert.equal(defaults.samples.length, 8);
  assert.equal(defaults.maxRequests, 48);
  const selected = parseEvaluationOptions([
    "--case=explicit-paid-remote",
    "--mode=voice",
    "--max-requests=4",
  ]);
  assert.equal(selected.samples.length, 1);
  assert.equal(selected.samples[0].mode, "voice");
  assert.equal(selected.maxRequests, 4);
  for (const args of [
    ["--case=unknown"],
    ["--mode=other"],
    ["--max-requests=0"],
    ["--max-requests=49"],
    ["--max-requests=Infinity"],
    ["--effort=low"],
  ])
    assert.throws(() => parseEvaluationOptions(args));
});

test("provider budget stops each sample and the complete run before another request", () => {
  const global = createRequestBudget(2);
  global.sample()();
  const next = global.sample();
  next();
  assert.throws(next, /budget exhausted/);
  assert.equal(global.total, 2);
  const perSample = createRequestBudget(20);
  const reserve = perSample.sample();
  for (let index = 0; index < 6; index++) reserve();
  assert.throws(reserve, /budget exhausted/);
  perSample.sample()();
  assert.equal(perSample.total, 7);
});

test("all synthetic scenarios use valid snapshots and preserve native parent/selection evidence", async () => {
  for (const sample of configurationCases) {
    const { fixture, first, final } = await applyRequestedChange(sample);
    assert.notEqual(first.configurationId, final.configurationId);
    assert.deepEqual(final.controls[1].parent, {
      controlId: "c0",
      optionId: "o1",
    });
    assert.equal(
      final.controls[1].options.every(({ available }) => available),
      true,
    );
    assert.equal(
      final.controls[3].options.some(({ available }) => available),
      false,
    );
    assert.deepEqual(
      gradeConfigurationReply(sample, fixture, replyFor(sample)),
      [],
    );
    const state = JSON.parse(
      fixture.history.at(-1).text.slice("Application state: ".length),
    );
    assert.equal(state.activeBlind.path, productPath);
  }
});

test("histories establish completed dimension entry without a competing trim preference", async () => {
  for (const sample of configurationCases) {
    const fixture = createConfigurationFixture(sample);
    const actionIndex = fixture.history.findIndex(({ text }) =>
      text.startsWith("Storefront action: "),
    );
    assert.ok(actionIndex > 0);
    const action = JSON.parse(
      fixture.history[actionIndex].text.slice("Storefront action: ".length),
    );
    const outcome = parseApplyMeasurementsResult(action.outcome);
    assert.equal(outcome.status, "applied");
    assert.equal(outcome.productPath, productPath);
    assert.equal(fixture.history[actionIndex + 1].role, "assistant");
    assert.match(
      fixture.history[actionIndex + 1].text,
      /800 mm width and 1200 mm drop/,
    );
    assert.match(
      fixture.history[actionIndex + 1].text,
      /measurement work is complete/,
    );
    assert.equal(
      fixture.history.some(({ text }) => /white|trim|frame/i.test(text)),
      false,
    );
    const snapshot = await fixture.execute(
      "current",
      "get_product_configuration",
      { productPath },
    );
    assert.equal(snapshot.measurements.width, 800);
    assert.equal(snapshot.measurements.height, 1200);
    assert.equal(snapshot.measurements.unit, "mm");
  }
});

test("unrequested tools, stale snapshots and additional paid choices are recorded as failures", async () => {
  const sample = configurationCases[0];
  const fixture = createConfigurationFixture(sample);
  await assert.rejects(
    fixture.execute("cart", "add_to_cart", { productPath }),
    /forbids/,
  );
  const first = await fixture.execute("read", "get_product_configuration", {
    productPath,
  });
  await assert.rejects(
    fixture.execute("stale", "configure_product", {
      productPath,
      configurationId: "stale",
      controlId: "c0",
      optionId: "o1",
    }),
    /latest unconsumed/,
  );
  assert.ok(fixture.violations.length >= 2);
  const { fixture: changed, final } = await applyRequestedChange(sample);
  await assert.rejects(
    changed.execute("unrequested", "configure_product", {
      productPath,
      configurationId: final.configurationId,
      controlId: "c1",
      optionId: "o1",
    }),
    /did not authorize/,
  );
  assert.ok(
    gradeConfigurationReply(sample, changed, replyFor(sample)).some((failure) =>
      /authorize/.test(failure),
    ),
  );
  assert.ok(first.configurationId);
});

test("reaffirming an explicit No Remote choice is acceptable without reopening the question", async () => {
  const sample = configurationCases[1];
  const { fixture, final } = await applyRequestedChange(sample);
  await fixture.execute("retain", "configure_product", {
    productPath,
    configurationId: final.configurationId,
    controlId: "c1",
    optionId: "o0",
  });
  await fixture.execute("reread", "get_product_configuration", { productPath });
  assert.deepEqual(
    gradeConfigurationReply(sample, fixture, replyFor(sample)),
    [],
  );
});

test("grader catches the remote regression, unnecessary decisions and missing rereads", async () => {
  const unresolved = configurationCases[0];
  const { fixture } = await applyRequestedChange(unresolved);
  const generic = replyFor(configurationCases[1]);
  assert.ok(
    gradeConfigurationReply(unresolved, fixture, generic).some((failure) =>
      /skipped/.test(failure),
    ),
  );
  const withLining = replyFor(unresolved);
  withLining.questionPresentation.answers.push("Blackout lining");
  assert.ok(
    gradeConfigurationReply(unresolved, fixture, withLining).some((failure) =>
      /generic completion/.test(failure),
    ),
  );
  const resolved = configurationCases[1];
  const { fixture: resolvedFixture } = await applyRequestedChange(resolved);
  assert.ok(
    gradeConfigurationReply(
      resolved,
      resolvedFixture,
      replyFor(unresolved),
    ).some((failure) => /reopened/.test(failure)),
  );
  const recapped = replyFor(resolved);
  recapped.questionPresentation.question =
    "Ready to add the blind without another remote to your cart?";
  assert.deepEqual(
    gradeConfigurationReply(resolved, resolvedFixture, recapped),
    [],
  );
  resolvedFixture.operations.pop();
  assert.ok(
    gradeConfigurationReply(resolved, resolvedFixture, replyFor(resolved)).some(
      (failure) => /fresh configuration/.test(failure),
    ),
  );
  const benign = configurationCases[2];
  const { fixture: benignFixture } = await applyRequestedChange(benign);
  const unnecessary = replyFor(benign);
  unnecessary.questionPresentation = {
    question: "Which cable clip would you like?",
    answers: ["White", "Help me choose"],
  };
  assert.ok(
    gradeConfigurationReply(benign, benignFixture, unnecessary).some(
      (failure) => /benign/.test(failure),
    ),
  );
});
