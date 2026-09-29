// Bounded live advisor evaluation with synthetic configuration only: no storefront access.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

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
        sample.name === "existing-compatible-remote" &&
        input.controlId === "c1" &&
        input.optionId === "o0" &&
        electric &&
        !remote
      ) {
        // Explicitly reaffirming the customer's existing No Remote decision is
        // acceptable, though retaining that matching default needs fewer calls.
      } else
        reject("The customer did not authorize this additional option change.");
      operation.result = {
        status: "applied",
        productPath,
        message:
          "The requested product option is selected and the theme has finished updating. Read its current configuration before changing another choice. Nothing was added to the cart.",
      };
      return operation.result;
    },
  };
}

/** Topic/choice checks use fixture meaning, never an exact generated sentence. */
export function gradeConfigurationReply(sample, fixture, reply) {
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
    sample.expectedChange === "remote"
      ? "14 Channel Remote Control"
      : "Control Options";
  const expectedOption =
    sample.expectedChange === "remote"
      ? "14 Channel Remote Control"
      : "Electric Smartview";
  check(
    changes.filter(
      (change) =>
        change.selection?.control === expectedControl &&
        change.selection?.option === expectedOption &&
        change.result?.status === "applied",
    ).length === 1,
    "The authorized option was not applied exactly once.",
  );
  check(
    reads.length >= 2 &&
      fixture.operations.at(-1)?.name === "get_product_configuration",
    "Missing fresh configuration read after the option change.",
  );
  check(
    !!question && !question.measurement,
    "Missing a normal decision/completion question.",
  );
  check(
    !reply.presentation?.productIds.length,
    "Configuration introduced unrelated product cards.",
  );
  const final = reads.at(-1)?.result;
  const dependent = final?.controls.find(({ id }) => id === "c1");
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
  const declarations = ["PRIMARY_TEXT_MODEL", "FALLBACK_TEXT_MODEL"]
    .map((name) => {
      const match = availability.match(
        new RegExp(`export const ${name} = ("[^"\\r\\n]+");`),
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
        undefined,
        undefined,
        undefined,
        (name, active) => metrics.activity(name, active),
        "medium",
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
