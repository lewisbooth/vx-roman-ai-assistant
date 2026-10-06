// Synthetic customer turns for the configuration evaluator; no storefront or database.
import { randomUUID } from "node:crypto";

const origin = "https://synthetic.example";
const productPath = "/products/synthetic-click2shade-blackout";
const title = "Synthetic Click2Shade Complete Blackout Blind";
const sourceCallId = "previous-verified-click2shade-measuring-read";
const mm = { min: 300, max: 2500, step: 1, stepBase: 0, kind: "number" };
const cm = { min: 30, max: 250, step: 0.1, stepBase: 0, kind: "number" };

export const measurementUnitCases = [
  {
    name: "mixed-measurement-units",
    measurementUnits: true,
    width: "120cm",
    drop: "1800mm",
    expected: { width: 120, height: 180, unit: "cm" },
    conversion: { from: "1800mm", to: "180cm" },
  },
  {
    name: "unlabeled-measurement-unit",
    measurementUnits: true,
    width: "120cm",
    drop: "180",
    expected: { width: 120, height: 180, unit: "cm" },
  },
  {
    name: "ambiguous-measurement-unit",
    measurementUnits: true,
    width: "120cm",
    drop: "1800, but I am not sure whether I read the mm or cm scale.",
    issue: "ambiguity",
  },
  {
    name: "measurement-native-precision",
    measurementUnits: true,
    width: "47.25in",
    drop: "1800mm",
    issue: "precision",
  },
  {
    name: "measurement-native-limit",
    measurementUnits: true,
    width: "120cm",
    drop: "3000mm",
    issue: "range",
  },
];

/** The form accepts a single cm/mm pair without rounding or hidden conversion. */
export function createMeasurementUnitFixture(sample) {
  const operations = [], violations = [];
  let draft, applied, lastConfiguration;
  const reject = (reason) => {
    violations.push(reason);
    throw new Error(reason);
  };
  const read = () => ({
    status: "available",
    productPath,
    configurationId: randomUUID(),
    controls: [{
      id: "c0", label: "Fitting", kind: "radio",
      options: [{ id: "o0", label: "Recess", selected: true, available: true }],
    }],
    measurements: {
      unit: applied?.unit ?? "cm",
      width: applied?.width ?? null,
      height: applied?.height ?? null,
      availableUnits: ["cm", "mm"],
      entry: "single_pair",
      constraints: [
        { unit: "cm", width: cm, height: cm },
        { unit: "mm", width: mm, height: mm },
      ],
    },
    configuredPrice: applied ? "GBP 93.60" : null,
    actions: { sampleAvailable: true },
    message: "The current product form accepts one width/drop pair, in cm or mm. Native limits apply to both dimensions.",
  });
  const priorConfiguration = read();
  // This fixture supplies a fresh native read in the current product history.
  // Reusing its limits avoids an artificial extra read before entering sizes.
  lastConfiguration = priorConfiguration;
  const widthQuestion = {
    question: "What is the smallest recess width?",
    answers: [],
    measurement: {
      productPath, label: "Recess width", unit: null,
      instructions: "Measure horizontally across the recess at the top, middle and bottom. Give the smallest width without deductions.",
    },
    sourceCallId,
  };
  const dropQuestion = {
    question: "What is the smallest recess drop?",
    answers: [],
    measurement: {
      productPath, label: "Recess drop", unit: sample.width.endsWith("cm") ? "cm" : "in",
      instructions: "Measure vertically at the left, middle and right. Give the smallest drop without deductions.",
    },
    sourceCallId,
  };
  return {
    operations,
    violations,
    productPath,
    sourceCallId,
    history: [
      { role: "user", text: `I chose ${title}. Help me measure and enter the dimensions for one standard rectangular recess. The product's recess fit and no-drill system suit this opening. I have checked the required clear depth and obstructions. I do not want measurement insurance. Do not add anything to the cart yet.` },
      { role: "user", text: `Storefront action: ${JSON.stringify({ name: "get_product_configuration", arguments: { productPath }, outcome: priorConfiguration, occurredAt: "2026-10-02T09:00:00.000Z" })}` },
      { role: "assistant", text: "Let's walk through the measuring guide. This product's original guide supports the checked rectangular recess and says to use the smallest of three horizontal width readings and three vertical drop readings, without deductions. The fit checks are complete. We will enter your own readings, not round them or change allowances." },
      { role: "user", source: "roman_question", text: `Roman question: ${JSON.stringify(widthQuestion)}` },
      { role: "user", text: `Recess width: ${sample.width}` },
      { role: "user", source: "roman_question", text: `Roman question: ${JSON.stringify(dropQuestion)}` },
      { role: "user", text: `Recess drop: ${sample.drop}` },
      { role: "user", source: "application_state", text: `Application state: ${JSON.stringify({ activeBlind: { path: productPath, title }, backgroundPage: { path: productPath, title }, pendingQuestion: null })}` },
    ],
    guideReuse: {
      cached: {
        origin, productPath,
        pageId: "22222222-2222-4222-8222-222222222222",
        sourceAssistantId: "33333333-3333-4333-8333-333333333333",
        sourceCallId,
        expiresAt: Date.now() + 60_000,
        kinds: ["measuring"],
        sources: [{ kind: "measuring", url: `${origin}/cdn/shop/files/synthetic-click2shade-measuring.pdf` }],
        // Never sent to the provider: the guard rejects a redundant reread first.
        files: [{ type: "input_file", detail: "high", filename: "measuring-guide.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjcKc3ludGhldGljLWd1aWRlCiUlRU9G" }],
      },
      read() { reject("Measurement continuation unexpectedly replaced prior guide evidence."); },
      clear() { reject("Measurement continuation unexpectedly invalidated its guide."); },
    },
    onGuideReading(kinds) {
      if (kinds?.length) reject("A unit conversion unnecessarily reread an original guide.");
    },
    async execute(_callId, name, input) {
      const operation = { name, arguments: structuredClone(input) };
      operations.push(operation);
      if (input.productPath !== productPath) reject("Measurement work must stay on the selected product.");
      if (operations.length > 7) reject("Measurement continuation repeated unnecessary operations.");
      if (name === "get_product_configuration") {
        lastConfiguration = read();
        operation.result = structuredClone(lastConfiguration);
      } else if (name === "get_measurements") {
        operation.result = draft ? { status: "found", draft: structuredClone(draft) } : { status: "not_found", productPath };
      } else if (name === "set_measurements") {
        if (!sample.expected) reject("Unresolved units or native limits must not become an order draft.");
        if (draft) reject("The same completed pair should not be saved repeatedly.");
        if (input.width !== sample.expected.width || input.height !== sample.expected.height || input.unit !== sample.expected.unit || input.kind !== "order" || input.mount !== "recess")
          reject("The saved pair must preserve both customer readings exactly in the established cm unit.");
        draft = { ...input, updatedAt: "2026-10-02T09:01:00.000Z" };
        operation.result = { status: "saved", draft: structuredClone(draft) };
      } else if (name === "apply_measurements") {
        if (!draft || !lastConfiguration || applied) reject("Apply once, after saving a complete pair and reading current native limits.");
        const constraint = lastConfiguration.measurements.constraints.find(({ unit }) => unit === draft.unit);
        if (!constraint || ["width", "height"].some(key => {
          const limits = constraint[key], value = draft[key];
          const steps = (value - limits.stepBase) / limits.step;
          return value < limits.min || value > limits.max || Math.abs(steps - Math.round(steps)) > 1e-7;
        })) reject("Native range and precision constraints prohibit this unmodified pair.");
        applied = structuredClone(draft);
        lastConfiguration = read();
        operation.result = { status: "applied", productPath, draftUpdatedAt: draft.updatedAt, configuration: structuredClone(lastConfiguration), message: "The saved dimensions were entered unchanged. The returned fresh native configuration verifies the pair and settled quote." };
      } else reject(`Measurement continuation forbids ${name}.`);
      return operation.result;
    },
  };
}

function dimensionMention(text, value, unit) {
  return new RegExp(`\\b${value}(?:\\.0+)?\\s*${unit}\\b`, "i").test(text);
}

/** Grade exact tool outcomes and decision topics, not a particular wording. */
export function gradeMeasurementUnitReply(sample, fixture, reply) {
  const failures = [...fixture.violations];
  const check = (condition, reason) => { if (!condition) failures.push(reason); };
  const question = reply.questionPresentation;
  const questionText = [question?.question, ...(question?.answers ?? [])].join(" ");
  const text = [reply.text, questionText].join(" ");
  const saves = fixture.operations.filter(operation => operation.name === "set_measurements");
  const applications = fixture.operations.filter(operation => operation.name === "apply_measurements");
  check(!reply.presentation?.productIds.length, "Measurement continuation introduced unrelated product cards.");
  if (sample.expected) {
    const expected = sample.expected;
    check(saves.length === 1 && saves[0].result?.status === "saved" &&
      saves[0].arguments.width === expected.width && saves[0].arguments.height === expected.height && saves[0].arguments.unit === expected.unit,
    "The exact normalized order pair was not saved once in this turn.");
    check(applications.length === 1 && applications[0].result?.status === "applied", "The completed pair was not applied once in this turn.");
    const final = fixture.operations.at(-1);
    const configuration = final?.result?.configuration ?? (final?.name === "get_product_configuration" ? final.result : undefined);
    check(configuration?.configuredPrice === "GBP 93.60" && configuration.measurements.width === expected.width && configuration.measurements.height === expected.height,
      "The entered pair and settled quote lack fresh native evidence.");
    const pair = new RegExp(`\\b${expected.width}(?:\\.0+)?(?:\\s*cm)?\\s*(?:×|x|by|wide.{0,20})\\s*${expected.height}(?:\\.0+)?\\s*cm\\b`, "i");
    check(pair.test(reply.text) || (dimensionMention(reply.text, expected.width, "cm") && dimensionMention(reply.text, expected.height, "cm")), "The final recap lost an entered dimension or its unit.");
    check(/(?:£|GBP)\s*93\.60\b/.test(reply.text), "The verified configured price was not recapped.");
    check(!!question && !question.measurement && (question.answers?.length ?? 0) > 0, "The completed measurement flow lacks useful quick answers.");
    check(!/\b(?:correct|confirm|convert|conversion|re-?measure|units?|centimet(?:er|re)s?|millimet(?:er|re)s?)\b/i.test(question?.question ?? ""), "The completed pair triggered an unnecessary unit or confirmation question.");
    check(!/\b(?:please|can you|could you|would you)\b.{0,55}\bconvert\b/i.test(text), "The customer was asked to perform an exact conversion.");
    if (sample.conversion)
      check(text.replaceAll(/\s/g, "").includes(sample.conversion.from) && dimensionMention(text, 180, "cm"), "The mixed-unit recap did not explain the exact drop conversion.");
    check(reply.text.trim().split(/\s+/).length <= 100, "The completed-pair recap is unnecessarily long.");
  } else {
    check(saves.length === 0 && applications.length === 0, "Unresolved or unrepresentable dimensions were silently saved or applied.");
    check(!!question && ((question.answers?.length ?? 0) > 0 || !!question.measurement), "The unresolved dimension lacks an actionable follow-up.");
    if (sample.issue === "ambiguity") check(/unit|scale|\bmm\b|\bcm\b|millimet|centimet/i.test(questionText), "A genuine uncertainty about the scale did not prompt clarification.");
    if (sample.issue === "precision") check(/precis|increment|round|decimal|0\.1\s*cm|1\s*mm|whole.*millimet/i.test(text), "Native precision was ignored rather than explained without rounding.");
    if (sample.issue === "range") check(/maximum|max\b|limit|too (?:tall|long|large)|250\s*cm|2500\s*mm|2[.,]5\s*m\b/i.test(text), "The native maximum was ignored rather than explained.");
  }
  return failures;
}
