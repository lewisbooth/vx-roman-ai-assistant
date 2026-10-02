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
const optionCases = configurationCases.filter(
  ({ expectedChange }) => !!expectedChange,
);

async function applyRequestedChange(sample) {
  const fixture = createConfigurationFixture(sample);
  const first = await fixture.execute("read", "get_product_configuration", {
    productPath,
  });
  parseProductConfigurationResult("get_product_configuration", first);
  const result = await fixture.execute("change", "configure_product", {
    productPath,
    configurationId: first.configurationId,
    controlId: sample.expectedChange === "electric" ? "c0" : "c1",
    optionId: sample.expectedChange === "no_remote" ? "o0" : "o1",
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
        text: "Electric Smartview is selected. The configured price is GBP 165.00. A compatible remote costs an additional GBP 18.00.",
        questionPresentation: {
          question: "Do you need a compatible remote for these controls?",
          answers: [
            "Add 14 Channel Remote Control",
            "I already own a compatible remote",
          ],
        },
      }
    : {
        text:
          sample.expectedChange === "no_remote"
            ? "No Remote remains selected. The configured price is GBP 165.00."
            : "Your requested option is selected, with the verified dimensions and updated quote.",
        questionPresentation: {
          question: "What would you like to do next?",
          answers: ["Add product to cart", "Change measurements"],
        },
      };
}

test("evaluation selects both channels by default and rejects invalid or unbounded requests", () => {
  const defaults = parseEvaluationOptions([]);
  assert.equal(defaults.samples.length, configurationCases.length * 2);
  assert.equal(defaults.maxRequests, defaults.samples.length * 6);
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
    [`--max-requests=${defaults.maxRequests + 1}`],
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
  for (const sample of optionCases) {
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
  for (const sample of optionCases) {
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

test("concise-update histories establish paid guarantee consent and separate unchanged pricing", async () => {
  for (const sample of configurationCases.filter(
    ({ conciseUpdate }) => conciseUpdate,
  )) {
    const { fixture, first, final } = await applyRequestedChange(sample);
    const guarantee = first.controls.find(
      ({ purpose }) => purpose === "measurement_guarantee",
    );
    assert.equal(
      guarantee.options.find(({ selected }) => selected).priceLabel,
      "+ GBP 9.00",
    );
    assert.deepEqual(
      final.controls.find(({ id }) => id === guarantee.id),
      guarantee,
    );
    assert.equal(final.configuredPrice, "GBP 165.00");
    const disclosureIndex = sample.history.findIndex(
      ({ role, text }) =>
        role === "assistant" && text.includes(guarantee.description),
    );
    assert.ok(disclosureIndex >= 0);
    assert.match(
      sample.history[disclosureIndex].text,
      /separate measurement guarantee costs GBP 9\.00/,
    );
    assert.equal(sample.history[disclosureIndex + 1].role, "user");
    assert.match(
      sample.history[disclosureIndex + 1].text,
      /Yes, select.*separate GBP 9\.00/,
    );
    const action = JSON.parse(
      sample.history[disclosureIndex + 2].text.slice(
        "Storefront action: ".length,
      ),
    );
    assert.equal(action.name, "configure_product");
    assert.equal(action.arguments.controlId, guarantee.id);
    assert.equal(
      action.arguments.optionId,
      guarantee.options.find(({ selected }) => selected).id,
    );
    assert.equal(
      parseProductConfigurationResult("configure_product", action.outcome)
        .status,
      "applied",
    );
    assert.equal(sample.history[disclosureIndex + 3].role, "assistant");
    assert.match(
      sample.history[disclosureIndex + 3].text,
      /selected and verified/,
    );
    assert.deepEqual(
      gradeConfigurationReply(sample, fixture, replyFor(sample)),
      [],
    );
  }
});

test("an explicit matching No Remote answer permits either a fresh-read no-op or a verified reassignment", async () => {
  const sample = configurationCases.find(
    ({ name }) => name === "accepted-guarantee-no-remote-update",
  );
  const unchanged = createConfigurationFixture(sample);
  await unchanged.execute("verify", "get_product_configuration", {
    productPath,
  });
  assert.deepEqual(
    gradeConfigurationReply(sample, unchanged, replyFor(sample)),
    [],
  );
  assert.equal(unchanged.operations.length, 1);
  const { fixture: reassigned } = await applyRequestedChange(sample);
  assert.deepEqual(
    gradeConfigurationReply(sample, reassigned, replyFor(sample)),
    [],
  );
  assert.equal(reassigned.operations.length, 3);
  for (const text of [
    "I removed the remote. The configured price is GBP 165.00 without another remote.",
    "No Remote remains selected. The price decreased to GBP 165.00.",
  ]) {
    assert.ok(
      gradeConfigurationReply(sample, unchanged, {
        ...replyFor(sample),
        text,
      }).some((failure) =>
        /claims a configuration or price change/.test(failure),
      ),
    );
  }
  unchanged.operations.pop();
  assert.ok(
    gradeConfigurationReply(sample, unchanged, replyFor(sample)).some(
      (failure) => /fresh configuration/.test(failure),
    ),
  );
});

test("delta grading rejects repeated settled details and preserves useful fresh option information", async () => {
  const sample = configurationCases.find(
    ({ name }) => name === "accepted-guarantee-motor-update",
  );
  const { fixture, final } = await applyRequestedChange(sample);
  const valid = replyFor(sample);
  for (const [addition, expectedFailure] of [
    [
      "Your measurement guarantee remains selected for a separate GBP 9.00.",
      /unchanged accepted guarantee/,
    ],
    [
      "The cover includes a same-blind replacement.",
      /unchanged accepted guarantee/,
    ],
    [
      "Your blind measures 800 mm wide by 1,200 mm drop.",
      /unchanged measurements/,
    ],
    ["The combined price is GBP 174.00.", /incorrectly combines/],
  ]) {
    assert.ok(
      gradeConfigurationReply(sample, fixture, {
        ...valid,
        text: `${valid.text} ${addition}`,
      }).some((failure) => expectedFailure.test(failure)),
    );
  }
  for (const [text, expectedFailure] of [
    [
      "Electric Smartview is selected. A compatible remote costs an additional GBP 18.00.",
      /base configured price/,
    ],
    [
      "The configured price is GBP 165.00. A compatible remote costs an additional GBP 18.00.",
      /current option outcome/,
    ],
  ]) {
    assert.ok(
      gradeConfigurationReply(sample, fixture, { ...valid, text }).some(
        (failure) => expectedFailure.test(failure),
      ),
    );
  }
  const reopened = structuredClone(valid);
  reopened.questionPresentation.answers.push("Remove measurement guarantee");
  assert.ok(
    gradeConfigurationReply(sample, fixture, reopened).some((failure) =>
      /unchanged accepted guarantee/.test(failure),
    ),
  );
  const guarantee = final.controls.find(
    ({ purpose }) => purpose === "measurement_guarantee",
  );
  await assert.rejects(
    fixture.execute("unrequested-guarantee", "configure_product", {
      productPath,
      configurationId: final.configurationId,
      controlId: guarantee.id,
      optionId: "o0",
    }),
    /did not authorize/,
  );

  // Suppression applies only when prior disclosure and acceptance are settled.
  // A first disclosure in an ordinary case must not fail merely for mentioning a fee.
  const initial = configurationCases[0];
  const { fixture: initialFixture } = await applyRequestedChange(initial);
  const firstDisclosure = replyFor(initial);
  firstDisclosure.text +=
    " A separate measurement guarantee would cost GBP 9.00; it has not been selected.";
  assert.deepEqual(
    gradeConfigurationReply(initial, initialFixture, firstDisclosure),
    [],
  );
});

test("delta grading catches unchanged dimensions with attached millimetre units", async () => {
  const sample = configurationCases.find(
    ({ name }) => name === "accepted-guarantee-motor-update",
  );
  const { fixture } = await applyRequestedChange(sample);
  const valid = replyFor(sample);
  for (const dimensions of ["800mm × 1200mm", "800mm wide", "1200mm drop"]) {
    assert.ok(
      gradeConfigurationReply(sample, fixture, {
        ...valid,
        text: `${valid.text} Your blind is ${dimensions}.`,
      }).some((failure) => /unchanged measurements/.test(failure)),
      dimensions,
    );
  }
  assert.deepEqual(
    gradeConfigurationReply(sample, fixture, {
      ...valid,
      text: `${valid.text} This check does not match unrelated numbers 1800mm or 12000mm.`,
    }),
    [],
  );
});

test("guide grading accepts the singular no deduction allowance rule", () => {
  const selected = configurationCases.find(
    ({ guideContinuation }) => guideContinuation,
  );
  const instructions =
    "Measure horizontally across the recess at the top, middle and bottom. Use the smallest width and make no deduction.";
  for (const mode of ["text", "voice"]) {
    const sample = { ...selected, mode };
    const fixture = createConfigurationFixture(sample);
    const questionPresentation = {
      question: "What is the smallest recess width?",
      answers: [],
      measurement: { productPath, label: "Width", unit: "mm", instructions },
      sourceCallId: fixture.sourceCallId,
    };
    assert.deepEqual(
      gradeConfigurationReply(sample, fixture, {
        text:
          mode === "voice"
            ? `${instructions} ${questionPresentation.question}`
            : "",
        questionPresentation,
      }),
      [],
    );
  }
});

test("guide continuation retains prior authority and advances without repeating the introduction", async () => {
  const selected = configurationCases.find(
    ({ guideContinuation }) => guideContinuation,
  );
  for (const mode of ["text", "voice"]) {
    const sample = { ...selected, mode };
    const fixture = createConfigurationFixture(sample);
    const snapshot = await fixture.execute(
      "native-refresh",
      "get_product_configuration",
      { productPath },
    );
    assert.equal(
      parseProductConfigurationResult("get_product_configuration", snapshot)
        .measurements.entry,
      "single_pair",
    );
    const questionPresentation = {
      question: "What is the smallest recess width?",
      answers: [],
      measurement: {
        productPath,
        label: "Width",
        unit: "mm",
        instructions: fixture.widthMethod,
      },
      sourceCallId: fixture.sourceCallId,
    };
    const reply = {
      text:
        mode === "voice"
          ? `${fixture.widthMethod} ${questionPresentation.question}`
          : "",
      questionPresentation,
    };
    assert.deepEqual(gradeConfigurationReply(sample, fixture, reply), []);
    assert.ok(fixture.guideReuse.cached.expiresAt > Date.now());
    assert.equal(
      fixture.guideReuse.cached.sourceCallId,
      questionPresentation.sourceCallId,
    );
    assert.ok(
      gradeConfigurationReply(sample, fixture, {
        ...reply,
        text: `Let's walk through measuring. ${reply.text}`,
      }).some((failure) => /another introduction/.test(failure)),
    );
    const ungrounded = structuredClone(reply);
    delete ungrounded.questionPresentation.sourceCallId;
    assert.ok(
      gradeConfigurationReply(sample, fixture, ungrounded).some((failure) =>
        /prior-read source/.test(failure),
      ),
    );
    const transposed = structuredClone(reply);
    transposed.questionPresentation.measurement.instructions =
      "Measure vertically at the left, middle and right; use the smallest without deductions.";
    if (mode === "voice")
      transposed.text = `${transposed.questionPresentation.measurement.instructions} ${questionPresentation.question}`;
    assert.ok(
      gradeConfigurationReply(sample, fixture, transposed).some((failure) =>
        /verified width method/.test(failure),
      ),
    );
    assert.doesNotThrow(() => fixture.onGuideReading(undefined));
    assert.throws(
      () => fixture.onGuideReading(["measuring"]),
      /unnecessarily reread/,
    );
    assert.ok(
      gradeConfigurationReply(sample, fixture, reply).some((failure) =>
        /unnecessarily reread/.test(failure),
      ),
    );
  }
});

test("guide continuation fixture prevents mutations and replacement of prior-read evidence", async () => {
  const sample = configurationCases.find(
    ({ guideContinuation }) => guideContinuation,
  );
  const fixture = createConfigurationFixture(sample);
  await assert.rejects(
    fixture.execute("mutation", "configure_product", { productPath }),
    /only refresh/,
  );
  assert.throws(
    () => fixture.guideReuse.read({}),
    /replaced its prior-read evidence/,
  );
  assert.throws(
    () => fixture.guideReuse.clear(),
    /invalidated its current source/,
  );
  assert.equal(fixture.violations.length, 3);
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
