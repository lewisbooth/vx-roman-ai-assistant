// Live, bounded advisor evaluation. Synthetic history/catalog/navigation only; no storefront actions.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import {
  currentProductCases,
  createCurrentProductFixture,
  gradeCurrentProductReply,
} from "./current-product.mjs";

import {
  suitabilityCases,
  gradeSuitabilityReply,
} from "./discovery-suitability.mjs";

if (!process.argv.includes("--live")) {
  console.log(
    "Run node admin/evals/discovery.mjs --live to make bounded billable OpenAI requests with synthetic data.",
  );
  process.exit(0);
}
process.loadEnvFile();
assert.ok(process.env.OPENAI_API_KEY, "Set the private root OPENAI_API_KEY.");
// Test the configured advisor without service probes or customer database writes.
const availability = await readFile("admin/conversations/availability.server.ts", "utf8");
const declarations = ["PRIMARY_TEXT_MODEL", "FALLBACK_TEXT_MODEL", "TEXT_SERVICE_TIER"].map((name) => {
  const match = availability.match(new RegExp(`export const ${name}(?:\\s*:\\s*string \\| null)? = ("[^"\\r\\n]+"|null);`));
  assert.ok(match, `Cannot read current ${name}; evaluation must not choose a substitute.`);
  return `export const ${name}=${match[1]};`;
}).join("\n");
await mkdir(".agents", { recursive: true });
const file = resolve(".agents/discovery-eval-model.mjs");
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
      export const reportFallbackUnavailable=async()=>{};
    `,
        }));
      },
    },
  ],
});
const { generateReply, TurnMetrics } = await import(pathToFileURL(file).href);
const origin = "https://synthetic.example";
const history = [
  {
    role: "user",
    text: "I'd like living-room blinds for light control and privacy. Standard rectangular windows, no special mount requirements. I'm open to any colours or patterns.",
  },
  {
    role: "assistant",
    text: "Would you like fabric rollers, adjustable slats, softer Roman blinds, or a mix?",
  },
  {
    role: "user",
    text: "Show me everything. I want a varied selection of styles, not different colours of the same blind.",
  },
];
const flow = process.argv.includes("--flow");
const kitchenHistory = [
  { role: "user", text: "I need some blinds for my kitchen." },
  {
    role: "assistant",
    text: "Do you want to start with the blind you're currently looking at, or something else?",
  },
  { role: "user", text: "Something else" },
  {
    role: "assistant",
    text: "Would you like roller blinds, Roman blinds, or all styles?",
  },
  { role: "user", text: "Show me everything" },
  { role: "assistant", text: "What matters most for the kitchen?" },
  { role: "user", text: "Privacy" },
];
const flowCases = [
  ...currentProductCases,
  ...suitabilityCases,
  {
    name: "room-only",
    history: [
      {
        role: "user",
        text: "Help me find blinds that suit my room and style. I want something different from the blind on this page.",
      },
    ],
    intake: /room|space/i,
    notQuestion: /what matters|priorit|window|opening|colou?r|pattern/i,
  },
  {
    name: "concern-only",
    history: [
      {
        role: "user",
        text: "I'd like blinds for a bedroom. It's a standard rectangular recessed window, with one blind across the opening.",
      },
    ],
    intake: /matter|priorit|important|want|need|concern/i,
    notQuestion: /colou?r|pattern|which room|what room/i,
  },
  {
    name: "door-type-only",
    history: [
      { role: "user", text: "Bedroom blinds for light control." },
      { role: "assistant", text: "What kind of opening are you covering?" },
      { role: "user", text: "A patio door" },
    ],
    intake: /sliding|bifold|door/i,
    notQuestion: /whole opening|each pane|individual panes|colou?r/i,
  },
  {
    name: "missing-opening",
    history: kitchenHistory,
    intake: /window|opening|door|pane/i,
  },
  {
    name: "missing-aesthetic",
    history: [
      ...kitchenHistory,
      { role: "assistant", text: "What kind of opening is it?" },
      {
        role: "user",
        text: "A bifold patio door. I want one blind covering the whole opening, not separate ones on each pane.",
      },
    ],
    intake: /colou?r|pattern|texture|neutral|look|style/i,
  },
  {
    name: "all-facts-supplied",
    history: [
      {
        role: "user",
        text: "I want blinds for a kitchen, for daytime privacy. Standard recessed rectangular window, no special mount. Soft natural textures; show a mix of colours. Please show me everything across different blind families.",
      },
    ],
    minQueries: 2,
  },
  {
    name: "no-drill-broad-discovery",
    history: [
      {
        role: "user",
        text: "Help me find no-drill blinds for my kitchen. Standard rectangular window, light neutrals; no-drill fitting is the main requirement. I'm open to different blind types.",
      },
      {
        role: "assistant",
        text: "Which blind type would you like to explore?",
      },
      { role: "user", text: "Show me everything." },
    ],
    minQueries: 3,
    noDrill: true,
    query: /no[- ]drill|without drill/i,
  },
  {
    name: "category-is-not-a-product-choice",
    history: [
      {
        role: "user",
        text: "Kitchen bifold patio doors, one covering for the whole opening. I want privacy while letting daylight in, in soft light neutral colours. I'm open to different blind families.",
      },
      {
        role: "assistant",
        text: "Here are a vertical blind, a privacy sheer and a panel blind. The privacy sheer is Synthetic Ivory Privacy Sheer, gid://shopify/Product/9100, /products/ivory-privacy-sheer, described for patio bifold doors. Which style would you like to explore?",
      },
      { role: "user", text: "Let's look at privacy sheers." },
    ],
    minQueries: 1,
    query: /sheer/i,
  },
];
const chosenEffort = process.argv
  .find((arg) => arg.startsWith("--effort="))
  ?.slice(9);
assert.ok(
  !chosenEffort || ["low", "medium"].includes(chosenEffort),
  "Effort must be low or medium.",
);
const cases = flow
  ? flowCases.flatMap((sample) =>
      ["text", "voice"].map((mode) => ({
        ...sample,
        mode,
        effort: chosenEffort ?? "medium",
      })),
    )
  : (chosenEffort ? [chosenEffort] : ["medium", "low"]).flatMap((effort) =>
      ["text", "voice"].map((mode) => ({
        name: "balanced-discovery",
        history,
        minQueries: 2,
        mode,
        effort,
      })),
    );
const selectedCases = process.argv
  .find((arg) => arg.startsWith("--case="))
  ?.slice(7)
  .split(",");
assert.ok(
  !selectedCases ||
    selectedCases.every((name) => cases.some((sample) => sample.name === name)),
  "Unknown evaluation case.",
);
const samples = cases.filter(
  (sample) => !selectedCases || selectedCases.includes(sample.name),
);
const maxRequests = Number(
  process.argv.find((arg) => arg.startsWith("--max-requests="))?.slice(15) ??
    samples.length * 4,
);
assert.ok(
  Number.isSafeInteger(maxRequests) &&
    maxRequests > 0 &&
    maxRequests <= samples.length * 4,
  "Request cap must be a positive integer no higher than four attempts per sample.",
);
let providerRequests = 0;
const report = [];
for (const sample of samples) {
  const { effort, mode } = sample;
  const metrics = new TurnMetrics();
  const currentProductFixture = sample.currentProductFlow
    ? createCurrentProductFixture(sample)
    : undefined;
  const operations = currentProductFixture?.operations ?? [];
  const products = currentProductFixture?.products ?? new Map();
  let attempts = 0;
  try {
    const reply = await generateReply(
      currentProductFixture?.history ?? sample.history,
      () => {},
      AbortSignal.timeout(60_000),
      async (_callId, name, input) => {
        if (currentProductFixture) {
          await delay(100);
          return currentProductFixture.execute(_callId, name, input);
        }
        operations.push({
          name,
          ...(name === "search_products" ? { queries: input.queries } : {}),
        });
        if (name !== "search_products")
          throw new Error("Synthetic discovery permits only search_products.");
        await delay(100);
        if (sample.fixtureProducts) {
          for (const product of sample.fixtureProducts)
            products.set(product.id, product);
          return {
            products: [...products.values()],
            messages: [],
            queries: input.queries.map((query) => ({
              query,
              status: "succeeded",
              productIds: [...products.keys()],
            })),
          };
        }
        const queries = input.queries.map((query, group) => {
          const family = /sheer/i.test(query)
            ? "Sheer"
            : /roman/i.test(query)
              ? "Roman"
              : /venetian|wood|slats/i.test(query)
                ? "Venetian"
                : /pleat|cellular|honeycomb/i.test(query)
                  ? "Cellular"
                  : /shutter/i.test(query)
                    ? "Shutter"
                    : "Roller";
          const productIds = Array.from({ length: 10 }, (_, i) => {
            const id = `gid://shopify/Product/${1000 + group * 100 + i}`;
            const description =
              family === "Sheer"
                ? "Light neutral sheer fabric slats designed for patio bifold doors, covering the whole opening with adjustable privacy and daylight."
                : family === "Venetian"
                  ? "Adjustable slats let customers balance privacy and daylight."
                  : family === "Cellular"
                    ? "Cellular light-filtering fabric softens daylight and provides daytime privacy."
                    : family === "Roman"
                      ? "Soft fabric folds with optional light-filtering or blackout lining for privacy and light control."
                      : family === "Shutter"
                        ? "Adjustable shutter louvres provide privacy and daylight control, with a solid frame and hinged panels."
                        : "Smooth roller fabric with optional light-filtering or blackout lining for privacy and light control.";
            const fitting = sample.noDrill
              ? " A no-drill fitting option is available. Plain cream, white and light oatmeal finishes suit a light neutral kitchen. Frame or recess compatibility must be checked before fitting."
              : "";
            products.set(id, {
              id,
              title: `Synthetic ${family} Style ${i + 1}`,
              description: `${description} Available in soft natural textures and a mix of colours.${fitting}`,
              url: `${origin}/products/${family.toLowerCase()}-${i}`,
              priceLabel: `From GBP ${20 + i}.00`,
            });
            return id;
          });
          return { query, status: "succeeded", productIds };
        });
        return { products: [...products.values()], messages: [], queries };
      },
      mode,
      async (usage) => {
        if (usage.status === "pending") {
          if (attempts >= 4 || providerRequests >= maxRequests)
            throw new Error("Evaluation provider request budget exhausted.");
          attempts++;
          providerRequests++;
        }
        metrics.usage(usage);
      },
      origin,
      undefined,
      undefined,
      undefined,
      undefined,
      (name, active) => metrics.activity(name, active),
      effort,
      { memo: {}, throughSequence: 0, checkpoints: [] },
      undefined,
      undefined,
      (event) => metrics.diagnostic(event),
    );
    metrics.ready(!!reply.presentation, mode === "voice");
    const selected = reply.presentation?.productIds ?? [];
    const families = [
      ...new Set(
        selected.map(
          (id) =>
            sample.productFamilies?.[id] ??
            products.get(id)?.title.split(" ")[1],
        ),
      ),
    ];
    const question = reply.questionPresentation;
    // Voice text already includes the question once, assembled by the model owner.
    const message =
      mode === "voice" && question && reply.text.endsWith(question.question)
        ? reply.text.slice(0, -question.question.length).trim()
        : reply.text;
    const failures = [];
    const check = (passed, reason) => {
      if (!passed) failures.push(reason);
    };
    check(!!question, "Missing follow-up question");
    check(
      !question?.answers.some((answer) => /\s[\u2014\u2013-]\s/.test(answer)),
      "Answers contain explanatory clauses",
    );
    if (currentProductFixture) {
      failures.push(
        ...gradeCurrentProductReply(sample, currentProductFixture, reply, mode),
      );
    } else if (sample.fixtureProducts) {
      failures.push(
        ...gradeSuitabilityReply(sample, { attempts, operations }, reply, mode),
      );
    } else {
      check(
        !sample.notQuestion ||
          !sample.notQuestion.test(question?.question ?? ""),
        "Intake asked an unrelated or combined question",
      );
      check(
        sample.intake
          ? attempts === 1 &&
              operations.length === 0 &&
              selected.length === 0 &&
              sample.intake.test(
                [question?.question, ...(question?.answers ?? [])].join(" "),
              )
          : attempts === 2 &&
              operations.length === 1 &&
              operations[0].name === "search_products" &&
              operations[0].queries.length >= sample.minQueries &&
              selected.length > 0 &&
              selected.length <= 10 &&
              families.length >= sample.minQueries &&
              (!sample.query ||
                operations[0].queries.every((query) =>
                  sample.query.test(query),
                )),
        "Intake/discovery operation or category-coverage contract failed",
      );
    }
    report.push({
      case: sample.name,
      effort,
      mode,
      passed: failures.length === 0,
      failures,
      operations,
      cards: selected.length,
      families,
      selectedProducts: selected.map((id) => ({
        id,
        title: products.get(id)?.title,
      })),
      ...(flow
        ? { message, question: question?.question, answers: question?.answers }
        : {}),
      metrics: metrics.snapshot(),
    });
  } catch (error) {
    report.push({
      case: sample.name,
      effort,
      mode,
      passed: false,
      operations,
      error: error.name,
      reason: error.message,
      metrics: metrics.snapshot(),
    });
  }
  console.log(JSON.stringify(report.at(-1)));
}
await writeFile(
  `.agents/discovery-${flow ? "flow-" : ""}evaluation.json`,
  JSON.stringify(
    {
      fixture:
        "synthetic catalog/navigation, 100ms operation; ready times exclude network polling, image loading and Live audio",
      providerRequests,
      maxRequests,
      samples: report,
    },
    null,
    2,
  ),
);
if (report.some((sample) => !sample.passed)) process.exitCode = 1;
