// Bounded live advisor evaluation with synthetic configuration only: no storefront access.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  measurementUnitCases,
  createMeasurementUnitFixture,
  gradeMeasurementUnitReply,
} from "./measurement-units.mjs";

const origin = "https://synthetic.example";
const productPath = "/products/synthetic-ivory-roman";
const MAX_SAMPLE_REQUESTS = 6;
const SAMPLE_DEADLINE_MS = 60_000;
const remoteTopic = /remote|handset|controller/i;
const completionTopic = /cart|basket|lining|measurements|keep configuring/i;
const benignTopic = /end.cap|cable.clip|trim.finish/i;
const baseHistory = [
  {
    role: "user",
    text: "I have chosen the Synthetic Ivory Roman blind for my living-room window. My order size is 800 mm wide by 1200 mm drop, Exact fitting. Please enter that size and keep standard lining. I declined the measurement guarantee for this window.",
  },
  {
    role: "user",
    text: `Storefront action: ${JSON.stringify({
      name: "apply_measurements",
      arguments: { productPath },
      outcome: {
        status: "applied",
        productPath,
        draftUpdatedAt: "2026-09-29T09:00:00.000Z",
        message:
          "The saved order dimensions, width 800 mm and drop 1200 mm, were applied and verified in the native form.",
      },
      occurredAt: "2026-09-29T09:00:01.000Z",
    })}`,
  },
  {
    role: "assistant",
    text: "I entered 800 mm width and 1200 mm drop, then verified those values, Exact fitting and standard lining in the product configuration. The measurement work is complete; there are no remaining readings or dimension changes to enter. Nothing has been added to the cart.",
  },
];
const electricOffer = {
  role: "assistant",
  text: "The configured blind is GBP 120.00. Electric Smartview is an available control option at an additional GBP 45.00. Would you like electric controls?",
};
const guaranteeTerms =
  "One same-blind replacement is covered if this blind does not fit. Larger replacement dimensions can cost extra.";
const acceptedGuaranteeHistory = [
  {
    role: "user",
    text: "I have chosen the Synthetic Ivory Roman blind for my living-room window. My order size is 800 mm wide by 1200 mm drop, Exact fitting. Please enter that size and keep standard lining.",
  },
  ...baseHistory.slice(1),
  {
    role: "assistant",
    text: `The configured blind is GBP 120.00. The separate measurement guarantee costs GBP 9.00. ${guaranteeTerms} Would you like that guarantee?`,
  },
  {
    role: "user",
    text: "Yes, select the measurement guarantee for the separate GBP 9.00 fee on those terms.",
  },
  {
    role: "user",
    text: `Storefront action: ${JSON.stringify({
      name: "configure_product",
      arguments: {
        productPath,
        configurationId: "00000000-0000-4000-8000-000000000040",
        controlId: "c4",
        optionId: "o1",
      },
      outcome: {
        status: "applied",
        productPath,
        message:
          "The requested measurement guarantee choice is selected and recorded.",
      },
      occurredAt: "2026-09-29T09:01:00.000Z",
    })}`,
  },
  {
    role: "assistant",
    text: "The measurement guarantee is selected and verified at the separate GBP 9.00 fee. The blind's configured price remains GBP 120.00, excluding that guarantee.",
  },
];

export const configurationCases = [
  {
    name: "motorization-reveals-remote",
    history: [
      ...baseHistory,
      electricOffer,
      {
        role: "user",
        text: "Yes, choose Electric Smartview for the extra GBP 45.00.",
      },
    ],
    expectedChange: "electric",
    remoteDecision: "unresolved",
  },
  {
    name: "existing-compatible-remote",
    history: [
      ...baseHistory,
      {
        role: "user",
        text: "I already own a compatible 14 Channel Remote Control for this exact Electric Smartview system. Do not add another remote; keep No Remote.",
      },
      electricOffer,
      {
        role: "user",
        text: "Yes, choose Electric Smartview for the extra GBP 45.00.",
      },
    ],
    expectedChange: "electric",
    remoteDecision: "resolved",
  },
  {
    name: "benign-nested-default",
    history: [
      ...baseHistory,
      electricOffer,
      {
        role: "user",
        text: "Yes, choose Electric Smartview for the extra GBP 45.00.",
      },
    ],
    expectedChange: "electric",
    remoteDecision: "absent",
  },
  {
    name: "explicit-paid-remote",
    history: [
      ...baseHistory,
      {
        role: "assistant",
        text: "Electric Smartview is selected. The configured blind is GBP 165.00. The compatible 14 Channel Remote Control is available for an additional GBP 18.00; No Remote is currently selected. Would you like the remote?",
      },
      {
        role: "user",
        text: "Yes, select the 14 Channel Remote Control for the extra GBP 18.00. Do not add the blind to the cart yet.",
      },
    ],
    expectedChange: "remote",
    remoteDecision: "resolved",
    initialElectric: true,
  },
  {
    name: "accepted-guarantee-motor-update",
    history: [
      ...acceptedGuaranteeHistory,
      electricOffer,
      {
        role: "user",
        text: "Yes, choose Electric Smartview for the extra GBP 45.00.",
      },
    ],
    expectedChange: "electric",
    remoteDecision: "unresolved",
    acceptedGuarantee: true,
    conciseUpdate: true,
  },
  {
    name: "accepted-guarantee-no-remote-update",
    history: [
      ...acceptedGuaranteeHistory,
      electricOffer,
      {
        role: "user",
        text: "Yes, choose Electric Smartview for the extra GBP 45.00.",
      },
      {
        role: "user",
        text: `Storefront action: ${JSON.stringify({
          name: "configure_product",
          arguments: {
            productPath,
            configurationId: "00000000-0000-4000-8000-000000000041",
            controlId: "c0",
            optionId: "o1",
          },
          outcome: {
            status: "applied",
            productPath,
            message:
              "Electric Smartview is selected and the theme has finished updating.",
          },
          occurredAt: "2026-09-29T09:02:00.000Z",
        })}`,
      },
      {
        role: "assistant",
        text: "Electric Smartview is selected and verified at a configured price of GBP 165.00. No Remote is currently selected; a compatible 14 Channel Remote Control costs an additional GBP 18.00. Do you need a remote?",
      },
      {
        role: "user",
        text: "No Remote, please. I already own a compatible 14 Channel Remote Control for this system.",
      },
    ],
    expectedChange: "no_remote",
    remoteDecision: "resolved",
    initialElectric: true,
    acceptedGuarantee: true,
    conciseUpdate: true,
  },
  {
    name: "guide-continuation-after-mount",
    guideContinuation: true,
  },
  {
    name: "clearance-threshold-once",
    guideContinuation: true,
    clearanceCheck: true,
  },
  {
    name: "explain-prerequisite-options-during-reading",
    guideContinuation: true,
    informationalInterruption: true,
  },
  {
    name: "memo-declined-guarantee-after-dimension-change",
    measurementUnits: true,
    declinedGuarantee: true,
    width: "120cm",
    drop: "180cm",
    expected: { width: 120, height: 180, unit: "cm" },
  },
  {
    name: "changed-guarantee-fee-needs-new-decision",
    measurementUnits: true,
    declinedGuarantee: true,
    changedGuaranteeFee: true,
    width: "120cm",
    drop: "180cm",
    expected: { width: 120, height: 180, unit: "cm" },
  },
  ...measurementUnitCases,
];

function applicationState() {
  return {
    role: "user",
    source: "application_state",
    text: `Application state: ${JSON.stringify({
      activeBlind: { path: productPath, title: "Synthetic Ivory Roman blind" },
      backgroundPage: {
        path: productPath,
        title: "Synthetic Ivory Roman blind",
      },
      pendingQuestion: null,
    })}`,
  };
}

/** Mutable fixture state models only the two explicit option writes under test. */
export function createConfigurationFixture(sample) {
  if (sample.measurementUnits) return sample.declinedGuarantee
    ? createDeclinedGuaranteeFixture(sample)
    : createMeasurementUnitFixture(sample);
  if (sample.guideContinuation) return createGuideContinuationFixture(sample);
  let electric = !!sample.initialElectric;
  let remote = false;
  let snapshot;
  const operations = [];
  const violations = [];
  const reject = (message) => {
    violations.push(message);
    throw new Error(message);
  };
  const read = () => {
    const controls = [
      {
        id: "c0",
        label: "Control Options",
        kind: "radio",
        options: [
          {
            id: "o0",
            label: "Sidewinder",
            selected: !electric,
            available: true,
          },
          {
            id: "o1",
            label: "Electric Smartview",
            selected: electric,
            available: true,
            priceLabel: "+ GBP 45.00",
          },
        ],
      },
      sample.remoteDecision === "absent"
        ? {
            id: "c1",
            label: "Motor cable clip",
            kind: "radio",
            parent: { controlId: "c0", optionId: "o1" },
            options: [
              {
                id: "o0",
                label: "Matching white cable clip (supplied)",
                selected: true,
                available: electric,
              },
            ],
          }
        : {
            id: "c1",
            label: "14 Channel Remote Control",
            kind: "radio",
            parent: { controlId: "c0", optionId: "o1" },
            options: [
              {
                id: "o0",
                label: "No Remote",
                selected: !remote,
                available: electric,
              },
              {
                id: "o1",
                label: "14 Channel Remote Control",
                selected: remote,
                available: electric,
                priceLabel: "+ GBP 18.00",
              },
            ],
          },
      {
        id: "c2",
        label: "Lining",
        kind: "radio",
        options: [
          {
            id: "o0",
            label: "Standard lining",
            selected: true,
            available: true,
          },
          {
            id: "o1",
            label: "Blackout lining",
            selected: false,
            available: true,
            priceLabel: "+ GBP 12.00",
          },
        ],
      },
      {
        id: "c3",
        label: "Manual-control trim finish",
        kind: "radio",
        parent: { controlId: "c0", optionId: "o0" },
        options: [
          { id: "o0", label: "White", selected: true, available: !electric },
          { id: "o1", label: "Chrome", selected: false, available: !electric },
        ],
      },
    ];
    if (sample.acceptedGuarantee)
      controls.push({
        id: "c4",
        label: "Measurement guarantee",
        kind: "radio",
        purpose: "measurement_guarantee",
        description: guaranteeTerms,
        options: [
          { id: "o0", label: "No guarantee", selected: false, available: true },
          {
            id: "o1",
            label: "Add measurement guarantee",
            selected: true,
            available: true,
            priceLabel: "+ GBP 9.00",
          },
        ],
      });
    return {
      status: "available",
      productPath,
      configurationId: randomUUID(),
      controls,
      measurements: {
        unit: "mm",
        width: 800,
        height: 1200,
        availableUnits: ["mm"],
        entry: "single_pair",
      },
      configuredPrice: remote
        ? "GBP 183.00"
        : electric
          ? "GBP 165.00"
          : "GBP 120.00",
      actions: { sampleAvailable: false },
      message:
        "Supported native product choices. Unavailable choices need the theme's required steps. Measurements and purchases are separate actions.",
    };
  };
  return {
    operations,
    violations,
    history: [...sample.history, applicationState()],
    async execute(_callId, name, input) {
      const operation = { name, arguments: structuredClone(input) };
      operations.push(operation);
      if (input.productPath !== productPath)
        reject("Synthetic operation must stay on the selected product.");
      if (name === "get_product_configuration") {
        snapshot = read();
        operation.result = structuredClone(snapshot);
        return snapshot;
      }
      if (name !== "configure_product")
        reject(`Synthetic configuration forbids ${name}.`);
      const current = snapshot;
      snapshot = undefined;
      if (!current || input.configurationId !== current.configurationId)
        reject(
          "Synthetic changes require the latest unconsumed configuration.",
        );
      const control = current.controls.find(({ id }) => id === input.controlId);
      const option = control?.options.find(({ id }) => id === input.optionId);
      if (!option?.available) reject("Synthetic option is unavailable.");
      operation.selection = {
        control: control.label,
        option: option.label,
        parent: control.parent,
      };
      // Customer history authorizes these choices; defaults are observations.
      if (
        sample.expectedChange === "electric" &&
        input.controlId === "c0" &&
        input.optionId === "o1" &&
        !electric
      )
        electric = true;
      else if (
        sample.expectedChange === "remote" &&
        input.controlId === "c1" &&
        input.optionId === "o1" &&
        electric &&
        !remote
      )
        remote = true;
      else if (
        (sample.name === "existing-compatible-remote" ||
          sample.expectedChange === "no_remote") &&
        input.controlId === "c1" &&
        input.optionId === "o0" &&
        electric &&
        !remote
      ) {
        // Explicitly reaffirming the customer's existing No Remote decision is
        // acceptable, though retaining that matching default needs fewer calls.
      } else
        reject("The customer did not authorize this additional option change.");
      snapshot = read();
      operation.result = {
        status: "applied",
        productPath,
        configuration: structuredClone(snapshot),
        message:
          "The requested product option is selected. The returned fresh configuration verifies the settled options and quote; nothing was added to the cart.",
      };
      return operation.result;
    },
  };
}

/** Topic/choice checks use fixture meaning, never an exact generated sentence. */
export function gradeConfigurationReply(sample, fixture, reply) {
  if (sample.measurementUnits) {
    const failures = gradeMeasurementUnitReply(sample, fixture, reply);
    if (sample.declinedGuarantee) {
      const question = reply.questionPresentation;
      const offer = /guarantee|insurance|insure|replacement.*cover/i.test(
        [question?.question, ...(question?.answers ?? [])].join(" "),
      );
      if (offer !== !!sample.changedGuaranteeFee)
        failures.push(sample.changedGuaranteeFee
          ? "Changed guarantee terms/fee were treated as the old scoped decline."
          : "An unchanged memo-recorded guarantee decline was reopened after dimension entry.");
      if (sample.changedGuaranteeFee && !/130(?:\.00)?/.test(
        [reply.text, question?.question, ...(question?.answers ?? [])].join(" "),
      )) failures.push("The changed guarantee offer lacks its current native fee.");
    }
    return failures;
  }
  if (sample.guideContinuation)
    return gradeGuideContinuationReply(sample, fixture, reply);
  const failures = [...fixture.violations];
  const check = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  const question = reply.questionPresentation;
  const questionText = [question?.question, ...(question?.answers ?? [])].join(
    " ",
  );
  const allText = [reply.text, questionText].join(" ");
  const changes = fixture.operations.filter(
    ({ name }) => name === "configure_product",
  );
  const reads = fixture.operations.filter(
    ({ name }) => name === "get_product_configuration",
  );
  const expectedControl =
    sample.expectedChange === "remote" || sample.expectedChange === "no_remote"
      ? "14 Channel Remote Control"
      : "Control Options";
  const expectedOption =
    sample.expectedChange === "remote"
      ? "14 Channel Remote Control"
      : sample.expectedChange === "no_remote"
        ? "No Remote"
        : "Electric Smartview";
  const matchingChanges = changes.filter(
    (change) =>
      change.selection?.control === expectedControl &&
      change.selection?.option === expectedOption &&
      change.result?.status === "applied",
  );
  const unchangedChoice =
    sample.expectedChange === "no_remote" && changes.length === 0;
  check(
    unchangedChoice || matchingChanges.length === 1,
    "The authorized option was not applied exactly once.",
  );
  const last = fixture.operations.at(-1);
  const final = last?.result?.configuration ??
    (last?.name === "get_product_configuration" ? last.result : undefined);
  check(
    reads.length >= 1 && final?.status === "available" &&
      (unchangedChoice || last?.name === "configure_product" ||
        last?.name === "get_product_configuration"),
    "Missing verified post-change configuration evidence.",
  );
  check(
    !!question && !question.measurement,
    "Missing a normal decision/completion question.",
  );
  check(
    !reply.presentation?.productIds.length,
    "Configuration introduced unrelated product cards.",
  );
  const dependent = final?.controls.find(({ id }) => id === "c1");
  if (sample.conciseUpdate) {
    check(
      /\b165(?:\.00)?\b/.test(reply.text),
      "The current base configured price is missing from the update.",
    );
    check(
      sample.expectedChange === "electric"
        ? /electric|smartview|motori[sz]/i.test(reply.text)
        : /no remote|without (?:a |another )?remote|remote.*(?:omitted|removed|excluded|off)/i.test(
            reply.text,
          ),
      "The reply does not identify the current option outcome.",
    );
    check(
      !/\b(?:800|1[ ,]?200)(?:\s*mm)?\b/i.test(allText),
      "The option update repeats unchanged measurements.",
    );
    check(
      !/guarantee|insurance|replacement|\bcover(?:age)?\b|(?:GBP|£)\s*9(?:\.00)?\b/i.test(
        allText,
      ),
      "The option update repeats or reopens the unchanged accepted guarantee.",
    );
    check(
      !/\b174(?:\.00)?\b/.test(allText),
      "The update incorrectly combines the base price and separate guarantee fee.",
    );
    if (unchangedChoice)
      check(
        !/(?:changed|switched|removed|applied|updated)\b.{0,35}\bremote|\bremote\b.{0,20}\b(?:removed|changed|switched)|\bprice\b.{0,20}\b(?:changed|increased|decreased|reduced)|\b(?:increased|decreased|reduced)\b.{0,20}\bprice/i.test(
          reply.text,
        ),
        "The reply claims a configuration or price change although the matching choice was retained.",
      );
    check(
      final?.controls
        .find(({ purpose }) => purpose === "measurement_guarantee")
        ?.options.find(({ selected }) => selected)?.priceLabel === "+ GBP 9.00",
      "The previously accepted guarantee changed during an unrelated option update.",
    );
  }
  check(
    dependent?.parent?.controlId === "c0" &&
      dependent?.parent?.optionId === "o1" &&
      dependent.options.some(({ available }) => available),
    "The terminal answer lacks fresh active-parent evidence.",
  );
  if (sample.remoteDecision === "unresolved") {
    check(
      remoteTopic.test(questionText),
      "Newly enabled remote hardware was skipped.",
    );
    check(
      !completionTopic.test(questionText),
      "The unresolved remote decision was replaced or mixed with generic completion/lining actions.",
    );
    check(
      (question?.answers.length ?? 0) >= 2,
      "The remote decision needs actionable alternatives.",
    );
    check(
      /\b18(?:\.00)?\b/.test(allText),
      "The known remote surcharge is missing from the decision.",
    );
    check(
      dependent?.options.find(({ selected }) => selected)?.label ===
        "No Remote",
      "An unresolved remote default was changed without consent.",
    );
  } else {
    const remoteDecision =
      (question?.answers ?? []).some(
        (answer) => remoteTopic.test(answer) && !/cart|basket/i.test(answer),
      ) ||
      (remoteTopic.test(question?.question ?? "") &&
        !/cart|basket|next|else|configur|finish|continue|ready/i.test(
          question?.question ?? "",
        ));
    check(
      !remoteDecision,
      "The already resolved remote decision was reopened.",
    );
    check(
      !benignTopic.test(questionText),
      "A benign or inactive nested control forced an unnecessary decision.",
    );
    check(
      /cart|basket|next|else|change|finish|continue|ready/i.test(questionText),
      "Configuration did not continue to a useful completion question.",
    );
    if (sample.remoteDecision === "resolved") {
      const selected = dependent?.options.find(
        ({ selected }) => selected,
      )?.label;
      check(
        selected ===
          (sample.expectedChange === "remote"
            ? "14 Channel Remote Control"
            : "No Remote"),
        "The customer's resolved remote selection was not preserved.",
      );
    }
  }
  return failures;
}

function createDeclinedGuaranteeFixture(sample) {
  const fixture = createMeasurementUnitFixture(sample);
  const priceLabel = sample.changedGuaranteeFee ? "+ GBP 130.00" : "+ GBP 120.00";
  const guarantee = {
    id: "c1", label: "Guarantee a Perfect Fit", kind: "radio",
    purpose: "measurement_guarantee", feeBasis: "per_item",
    description: guaranteeTerms,
    options: [
      { id: "o0", label: "Don't insure measurements", selected: true, available: true },
      { id: "o1", label: "Insure measurements", selected: false, available: true, priceLabel },
    ],
  };
  const includeGuarantee = (configuration) => {
    if (configuration?.status === "available") configuration.controls.push(structuredClone(guarantee));
  };
  // The decline is intentionally absent from visible recent history. It survived
  // in a flexible private note after an earlier product/window decision.
  fixture.history[0].text = fixture.history[0].text.replace("I do not want measurement insurance. ", "");
  for (const message of fixture.history) {
    if (!message.text.startsWith("Storefront action: ")) continue;
    const action = JSON.parse(message.text.slice("Storefront action: ".length));
    includeGuarantee(action.outcome);
    message.text = "Storefront action: " + JSON.stringify(action);
  }
  fixture.memo = {
    "Maple blind guarantee": `For the Maple window's ${fixture.productPath}, customer explicitly declined measurement cover at the disclosed separate GBP 120.00 per blind fee and these terms: ${guaranteeTerms} The native Don't insure measurements choice was applied and verified. Later dimensions may change; the window and selected blind are unchanged.`,
  };
  const execute = fixture.execute;
  fixture.execute = async (...args) => {
    const result = await execute(...args);
    includeGuarantee(result.configuration ?? result);
    fixture.operations.at(-1).result = structuredClone(result);
    return result;
  };
  return fixture;
}

export function createGuideContinuationFixture(sample = {}) {
  const title = "Synthetic Ivory Roman blind";
  const operations = [],
    violations = [];
  const sourceCallId = "previous-verified-measuring-read";
  const widthMethod =
    "Measure horizontally across the recess at the top, middle and bottom. Use the smallest width without making deductions.";
  const snapshot = {
    status: "available",
    productPath,
    configurationId: "dd05642c-15ba-4734-b5aa-2677b61c2130",
    controls: [
      {
        id: "c0",
        label: "Fitting",
        kind: "radio",
        options: [
          { id: "o0", label: "Recess", selected: true, available: true },
          { id: "o1", label: "Exact", selected: false, available: true },
        ],
      },
    ],
    measurements: {
      unit: "mm",
      width: null,
      height: null,
      availableUnits: ["mm"],
      entry: "single_pair",
      constraints: [
        {
          unit: "mm",
          width: { kind: "number", min: 300, max: 2000, step: 1, stepBase: 0 },
          height: { kind: "number", min: 300, max: 2500, step: 1, stepBase: 0 },
        },
      ],
    },
    actions: { sampleAvailable: true },
    configuredPrice: null,
    message:
      "Supported native configuration; dimensions have not been entered.",
  };
  const question = {
    question: "Will this blind fit inside the recess or outside it?",
    answers: ["Inside the recess", "Outside the recess"],
  };
  const reject = (reason) => {
    violations.push(reason);
    throw new Error(reason);
  };
  if (sample.informationalInterruption) snapshot.controls.push({
    id: "c1", label: "Lining", kind: "radio",
    description: "Lining choices become selectable after width and drop are entered. Their pricing can appear when these dependent choices become selectable.",
    options: [
      { id: "o0", label: "Light filtering lining", selected: true, available: true },
      { id: "o1", label: "Blackout lining", selected: false, available: false, description: "Blocks light. Enter measurements before selecting." },
      { id: "o2", label: "Thermal interlining", selected: false, available: false, description: "Adds insulation. Enter measurements before selecting." },
    ],
  });
  const fixture = {
    operations,
    violations,
    sourceCallId,
    widthMethod,
    history: [
      {
        role: "user",
        text: `I've chosen ${title}. Help me measure this single rectangular window in mm. It has no handles or other obstructions; I checked the clear recess depth and it is 100mm.`,
      },
      {
        role: "user",
        text: `Storefront action: ${JSON.stringify({
          name: "get_product_configuration",
          arguments: { productPath },
          outcome: snapshot,
          occurredAt: "2026-09-29T09:00:00.000Z",
        })}`,
      },
      {
        role: "assistant",
        text: `Let's walk through the measuring guide. This product's original guide supports this unobstructed rectangular window. For recess fitting it requires at least 75mm clear depth, so your checked 100mm meets that requirement. ${widthMethod} Drop is measured vertically at the left, middle and right; use the smallest without deductions. We have not taken width or drop yet.`,
      },
      {
        role: "user",
        source: "roman_question",
        text: `Roman question: ${JSON.stringify(question)}`,
      },
      { role: "user", text: sample.informationalInterruption
        ? "Pause measuring for a moment. Explain the blackout and thermal lining choices and whether I can pick them before entering measurements. Do not change anything."
        : "Inside the recess" },
      {
        role: "user",
        source: "application_state",
        text: `Application state: ${JSON.stringify({
          activeBlind: { path: productPath, title },
          backgroundPage: { path: productPath, title },
          pendingQuestion: sample.informationalInterruption ? {
            question: "What is the smallest recess width?", answers: [],
            measurement: { productPath, label: "Recess width", unit: "mm", instructions: widthMethod },
            sourceCallId,
          } : null,
        })}`,
      },
    ],
    guideReuse: {
      // Same cached-receipt contract exercised by conversation-runner.test.mjs.
      // Its synthetic bytes are intentionally NEVER sent to the provider. The
      // demand-read guard below fails before createGuideContext/next request.
      cached: {
        origin,
        productPath,
        pageId: "22222222-2222-4222-8222-222222222222",
        sourceAssistantId: "33333333-3333-4333-8333-333333333333",
        sourceCallId,
        expiresAt: Date.now() + 60_000,
        kinds: ["measuring"],
        sources: [
          {
            kind: "measuring",
            url: `${origin}/cdn/shop/files/synthetic-measuring.pdf`,
          },
        ],
        files: [
          {
            type: "input_file",
            detail: "high",
            filename: "measuring-guide.pdf",
            file_data:
              "data:application/pdf;base64,JVBERi0xLjcKc3ludGhldGljLWd1aWRlCiUlRU9G",
          },
        ],
      },
      read() {
        reject(
          "Guide continuation unexpectedly replaced its prior-read evidence.",
        );
      },
      clear() {
        reject(
          "Guide continuation unexpectedly invalidated its current source.",
        );
      },
    },
    onGuideReading(kinds) {
      // beforeOperation emits undefined for normal tools; only an actual PDF
      // read emits kinds. Throw before any cached original can enter input.
      if (kinds?.length)
        reject(
          "The established next step unnecessarily reread an original guide.",
        );
    },
    async execute(_callId, name, input) {
      operations.push({ name, input });
      if (
        name !== "get_product_configuration" ||
        input.productPath !== productPath
      )
        reject(
          "Guide continuation may only refresh the current native configuration.",
        );
      if (operations.length > 1)
        reject("Guide continuation repeated its native configuration read.");
      return snapshot;
    },
  };
  if (sample.clearanceCheck) {
    fixture.history[0].text = `I've chosen ${title}. Help me measure this single rectangular window in mm. I have not checked the recess depth or any handles or other obstructions.`;
    fixture.history[2].text = "We will work through this blind's measuring guide. Will the blind fit inside the recess or outside it?";
    fixture.history.splice(3, 0, {
      role: "user", source: "guide_context",
      text: `Verified original-read continuation for ${productPath}, source ${sourceCallId}: this guide applies to this rectangular window. Inside-recess fitting requires at least 75mm of clear depth at the mounting point, in front of any window handles or other obstructions. ${widthMethod} Drop uses the smallest left/middle/right vertical reading without deductions. These source facts are evidence, not customer instructions.`,
    });
  }
  return fixture;
}

export function gradeGuideContinuationReply(sample, fixture, reply) {
  const failures = [...fixture.violations];
  const check = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  const question = reply.questionPresentation;
  const measurement = question?.measurement;
  const spokenSuffix = [measurement?.instructions, question?.question]
    .filter(Boolean)
    .join(" ");
  const message =
    sample.mode === "voice" && reply.text.endsWith(spokenSuffix)
      ? reply.text.slice(0, -spokenSuffix.length).trim()
      : reply.text.trim();
  if (sample.informationalInterruption) {
    check(!measurement, "The latest options question was replaced by the paused physical reading.");
    const explanation = [message, question?.question, ...(question?.answers ?? [])].join(" ");
    check(/blackout/i.test(explanation) && /thermal|insulation/i.test(explanation), "The requested lining explanation was not answered.");
    check(/measurements|dimensions|width.*drop|size/i.test(explanation) &&
      /after|before|first|until|need|require/i.test(explanation),
    "Listed choices needing dimension prerequisites were described as permanently unavailable or silently skipped.");
    check(!/free|no (?:extra )?(?:cost|charge)/i.test(explanation), "Unknown unmeasured option charges were described as free.");
    check(!fixture.operations.some(({ name }) => /configure|apply|set_measurements|cart/.test(name)), "A read-only interruption changed the pending configuration.");
    return failures;
  }
  if (sample.clearanceCheck) {
    check(!!question && !measurement && question.answers?.length >= 2,
      "The unresolved clearance check did not get a decision widget.");
    const thresholdMentions = [message, question?.question, ...(question?.answers ?? [])]
      .join(" ").match(/\b75\s*(?:mm|millimet(?:er|re)s?)\b/gi) ?? [];
    check(thresholdMentions.length === 1, "The clearance threshold was missing or repeated across message and question.");
    const clearanceQuestion = question?.question ?? "";
    check(/\b75\s*(?:mm|millimet(?:er|re)s?)\b/i.test(clearanceQuestion),
      "The source clearance threshold was missing from its decision question.");
    check(/clear|unobstructed|free/i.test(clearanceQuestion) &&
      /depth|space|clearance/i.test(clearanceQuestion) &&
      /handle|obstruction|obstacle/i.test(clearanceQuestion),
    "The question did not combine clear fitting depth with handles or obstructions.");
    check((clearanceQuestion.match(/\?/g) ?? []).length <= 1,
      "Clearance was split into separate depth and obstruction questions.");
    check(!/walk.*guide|work.*guide|start.*measur/i.test(message), "The same measuring task was introduced again after its mount answer.");
    return failures;
  }
  check(
    !message,
    "An established measurement step added another introduction, acknowledgement or recap.",
  );
  check(
    !!measurement &&
      measurement.productPath === productPath &&
      /width/i.test(measurement.label),
    "The mount answer did not continue to the first unresolved width reading.",
  );
  check(measurement?.unit === "mm", "The established unit was lost.");
  const method = measurement?.instructions ?? "";
  check(
    /top/i.test(method) &&
      /middle/i.test(method) &&
      /bottom/i.test(method) &&
      /smallest|narrowest|minimum/i.test(method) &&
      /horizont|across|left.*right/i.test(method) &&
      /no deductions?\b|without.*deduct|do not.*deduct|don.t.*deduct/i.test(
        method,
      ),
    "The verified width method lost a required position, direction, result choice or allowance rule.",
  );
  check(
    question?.sourceCallId === fixture.sourceCallId,
    "The next measuring question did not retain its prior-read source.",
  );
  check(
    !reply.presentation?.productIds.length,
    "Guide continuation introduced product cards.",
  );
  return failures;
}

export function parseEvaluationOptions(args) {
  const values = Object.fromEntries(
    args
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => arg.slice(2).split("=")),
  );
  assert.ok(
    args.every(
      (arg) => arg === "--live" || /^--(?:case|mode|max-requests)=/.test(arg),
    ),
    "Use --live, --case=name[,name], --mode=text|voice or --max-requests=N.",
  );
  const names =
    values.case?.split(",") ?? configurationCases.map(({ name }) => name);
  assert.ok(
    names.length &&
      new Set(names).size === names.length &&
      names.every((name) =>
        configurationCases.some((sample) => sample.name === name),
      ),
    "Unknown or repeated configuration case.",
  );
  assert.ok(
    !values.mode || ["text", "voice"].includes(values.mode),
    "Mode must be text or voice.",
  );
  const samples = configurationCases
    .filter(({ name }) => names.includes(name))
    .flatMap((sample) =>
      (values.mode ? [values.mode] : ["text", "voice"]).map((mode) => ({
        ...sample,
        mode,
      })),
    );
  const maxRequests = Number(
    values["max-requests"] ?? samples.length * MAX_SAMPLE_REQUESTS,
  );
  assert.ok(
    Number.isSafeInteger(maxRequests) &&
      maxRequests > 0 &&
      maxRequests <= samples.length * MAX_SAMPLE_REQUESTS,
    "Request cap must be a positive integer no higher than six requests per sample.",
  );
  return { samples, maxRequests };
}

/** Called by onUsage before the real SDK request, including every retry attempt. */
export function createRequestBudget(maxRequests) {
  let total = 0;
  return {
    get total() {
      return total;
    },
    sample() {
      let attempts = 0;
      return () => {
        if (attempts >= MAX_SAMPLE_REQUESTS || total >= maxRequests)
          throw new Error("Evaluation provider request budget exhausted.");
        attempts++;
        total++;
      };
    },
  };
}

async function liveEvaluation(args) {
  const { samples, maxRequests } = parseEvaluationOptions(args);
  if (!args.includes("--live")) {
    console.log(
      "No provider calls made. Use node admin/evals/configuration.mjs --live for bounded billable Medium evaluations with synthetic configuration.",
    );
    return;
  }
  if (!process.env.OPENAI_API_KEY) process.loadEnvFile();
  assert.ok(process.env.OPENAI_API_KEY, "Set the private root OPENAI_API_KEY.");
  // Keep the deployed model choice, while excluding service probes/database side effects.
  const availability = await readFile(
    "admin/conversations/availability.server.ts",
    "utf8",
  );
  const declarations = ["PRIMARY_TEXT_MODEL", "FALLBACK_TEXT_MODEL", "TEXT_SERVICE_TIER"]
    .map((name) => {
      const match = availability.match(
        new RegExp(`export const ${name}(?:\\s*:\\s*string \\| null)? = ("[^"\\r\\n]+"|null);`),
      );
      assert.ok(
        match,
        `Cannot read current ${name}; evaluation must not choose a substitute.`,
      );
      return `export const ${name}=${match[1]};`;
    })
    .join("\n");
  await mkdir(".agents", { recursive: true });
  const file = resolve(".agents/configuration-eval-model.mjs");
  await build({
    stdin: {
      contents:
        'export {generateReply} from "./admin/conversations/model.server.ts"; export {TurnMetrics} from "./admin/conversations/turn-metrics.server.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: file,
    plugins: [
      {
        name: "isolated-model-availability",
        setup(builder) {
          builder.onResolve({ filter: /availability\.server$/ }, () => ({
            path: "availability",
            namespace: "eval",
          }));
          builder.onLoad({ filter: /.*/, namespace: "eval" }, () => ({
            contents: `${declarations}
        export const textModelForRequest=async()=>PRIMARY_TEXT_MODEL;
        export const assertServiceAvailable=async()=>{}, isServiceSuspended=()=>false;
        export const reportPrimaryUnavailable=async()=>{throw new Error("Primary model unavailable during evaluation")};
        export const reportFallbackUnavailable=async()=>{};`,
          }));
        },
      },
    ],
  });
  const { generateReply, TurnMetrics } = await import(pathToFileURL(file).href);
  const budget = createRequestBudget(maxRequests);
  const report = [];
  for (const sample of samples) {
    const fixture = createConfigurationFixture(sample);
    const metrics = new TurnMetrics();
    const reserveRequest = budget.sample();
    const record = {
      case: sample.name,
      mode: sample.mode,
      effort: "medium",
      history: fixture.history,
    };
    try {
      const reply = await generateReply(
        fixture.history,
        () => {},
        AbortSignal.timeout(SAMPLE_DEADLINE_MS),
        fixture.execute,
        sample.mode,
        async (usage) => {
          if (usage.status === "pending") reserveRequest();
          metrics.usage(usage);
        },
        origin,
        undefined,
        fixture.onGuideReading,
        fixture.guideReuse,
        undefined,
        (name, active) => metrics.activity(name, active),
        "medium",
        { memo: fixture.memo ?? {}, throughSequence: 0, checkpoints: [] },
        undefined,
        undefined,
        (event) => metrics.diagnostic(event),
      );
      metrics.ready(false, sample.mode === "voice");
      const failures = gradeConfigurationReply(sample, fixture, reply);
      Object.assign(record, { passed: failures.length === 0, failures, reply });
    } catch (error) {
      // Provider bodies/messages can contain sensitive request or account data.
      Object.assign(record, {
        passed: false,
        error: error.name,
        ...(error.message === "Evaluation provider request budget exhausted."
          ? { reason: error.message }
          : {}),
        failures: fixture.violations,
      });
    }
    Object.assign(record, {
      operations: fixture.operations,
      metrics: metrics.snapshot(),
    });
    report.push(record);
    console.log(JSON.stringify(record));
  }
  const output = ".agents/configuration-evaluation.json";
  await writeFile(
    output,
    JSON.stringify(
      {
        fixture:
          "Synthetic native configuration; no browser, storefront, database or Live audio. Topic checks require human review of saved answers.",
        providerRequests: budget.total,
        maxRequests,
        sampleRequestCap: MAX_SAMPLE_REQUESTS,
        sampleDeadlineMs: SAMPLE_DEADLINE_MS,
        samples: report,
      },
      null,
      2,
    ),
  );
  console.log(
    `Saved ${output}; ${budget.total}/${maxRequests} provider requests.`,
  );
  if (report.some(({ passed }) => !passed)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await liveEvaluation(process.argv.slice(2));
