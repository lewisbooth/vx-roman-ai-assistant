// Live, bounded advisor evaluation. Synthetic history/catalog only; no browser or cart actions.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

if (!process.argv.includes("--live")) {
  console.log(
    "Run node admin/evals/discovery.mjs --live to make bounded billable OpenAI requests with synthetic data.",
  );
  process.exit(0);
}
process.loadEnvFile();
assert.ok(process.env.OPENAI_API_KEY, "Set the private root OPENAI_API_KEY.");
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
          contents: `
      export const PRIMARY_TEXT_MODEL="gpt-6-luna", FALLBACK_TEXT_MODEL="gpt-5.6-luna";
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
function catalogProduct(id, title, description) {
  return {
    id: "gid://shopify/Product/" + id,
    title,
    description,
    url: origin + "/products/synthetic-" + id,
    priceLabel: "From GBP 30.00",
  };
}
const suitabilityCatalog = [
  catalogProduct(
    7100,
    "Synthetic Woven Linen Pleated Blind",
    "A no-drill tension-fit pleated blind for standard rectangular recessed windows. Woven natural texture gives living rooms daytime privacy while filtering light. Not designed for bifold doors or roof windows.",
  ),
  catalogProduct(
    7101,
    "Synthetic Chevron Pleated Blind",
    "A subtly patterned pleated blind for standard rectangular recessed windows, with included no-drill tension fittings. Provides daytime privacy and filtered light in a living room. Not suitable for bifold doors or skylights.",
  ),
  catalogProduct(
    7102,
    "Synthetic BiFold Pearl Textured Pleated Blind",
    "No-drill pleated blind with woven texture, designed exclusively for individual uPVC bifold glazed door panels with rubber beading. Provides daytime privacy and filtered light. Not compatible with standard recessed windows or roof windows.",
  ),
  catalogProduct(
    7103,
    "Synthetic Roof Window Textured Pleated Blind",
    "A textured no-drill pleated blind for matching roof-window model codes only. Provides filtered light and privacy. Cannot fit ordinary rectangular recessed windows or bifold door panels.",
  ),
  catalogProduct(
    7104,
    "Synthetic Screw-Fit Patterned Pleated Blind",
    "Patterned pleated blind providing living-room daytime privacy for standard rectangular recessed windows. Installation requires drilling and screw-fixed brackets; no no-drill option is offered.",
  ),
  catalogProduct(
    7105,
    "Synthetic Oatmeal Pleated Blind",
    "Textured pleated fabric with daytime privacy and filtered light, for standard rectangular recessed windows. The catalog does not specify how it mounts or whether a no-drill fitting is available.",
  ),
  catalogProduct(
    7106,
    "Synthetic Botanical Roller Blind",
    "A patterned roller blind with verified no-drill tension fittings for standard rectangular recessed windows, giving a living room filtered light and daytime privacy. This is roller fabric, not pleated or cellular fabric.",
  ),
];
const pleatedHistory = [
  {
    role: "user",
    text: "I want no-drill blinds for my living room. It is a standard rectangular recessed window. I want daytime privacy with natural light, and a pattern or texture. I have not chosen a blind category yet.",
  },
  { role: "assistant", text: "Which style would you like to explore?" },
  { role: "user", text: "Pleated blind" },
];
const suitabilityCases = [
  {
    name: "pleated-category-refinement",
    history: pleatedHistory,
    fixtureProducts: suitabilityCatalog,
    eligibleIds: ["gid://shopify/Product/7100", "gid://shopify/Product/7101"],
    opening: /standard|rectangular|recess|window/i,
    wrongOpening: /bifold|bi-fold|roof|skylight/i,
  },
  {
    name: "pleated-no-eligible",
    history: pleatedHistory,
    fixtureProducts: suitabilityCatalog.filter((product) =>
      [7102, 7103, 7104, 7106].some((id) => product.id.endsWith("/" + id)),
    ),
    eligibleIds: [],
    opening: /standard|rectangular|recess|window/i,
    wrongOpening: /bifold|bi-fold|roof|skylight/i,
  },
  {
    name: "explicit-bifold-switch",
    history: [
      ...pleatedHistory,
      {
        role: "assistant",
        text: "I will look for patterned or textured pleated blinds for your standard window.",
      },
      {
        role: "user",
        text: "Actually, these are for bifold glazed door panels instead of the standard window. Each panel is uPVC with rubber beading; I want a separate blind on each panel. Keep the no-drill fitting, daytime privacy and patterned or textured look. Please show me pleated blinds for these bifold panels.",
      },
    ],
    fixtureProducts: suitabilityCatalog,
    eligibleIds: ["gid://shopify/Product/7102"],
    opening: /bifold|bi-fold/i,
  },
];
const flowCases = [
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
    name: "no-drill-family-choice",
    history: [
      {
        role: "user",
        text: "Help me find no-drill blinds for my kitchen. Standard rectangular window, light neutrals; no-drill fitting is the main requirement. I haven't decided what type of blind.",
      },
      {
        role: "assistant",
        text: "Would you prefer plain fabrics or patterns?",
      },
      { role: "user", text: "Plain fabrics, please." },
    ],
    intake: /style|type|famil|explore|direction/i,
    familyChoice: true,
    quietIntake: true,
    noDrill: true,
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
  const operations = [];
  const products = new Map();
  let attempts = 0;
  try {
    const reply = await generateReply(
      sample.history,
      () => {},
      AbortSignal.timeout(60_000),
      async (_callId, name, input) => {
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
    );
    metrics.ready(!!reply.presentation, mode === "voice");
    const selected = reply.presentation?.productIds ?? [];
    const families = [
      ...new Set(selected.map((id) => products.get(id)?.title.split(" ")[1])),
    ];
    const question = reply.questionPresentation;
    // Voice text already includes the question once, assembled by the model owner.
    const message =
      mode === "voice" && question && reply.text.endsWith(question.question)
        ? reply.text.slice(0, -question.question.length).trim()
        : reply.text;
    // Topic checks are deliberately broad; saved synthetic output also needs human review.
    const familyAnswers =
      question?.answers.filter((answer) =>
        /roller|roman|pleat|cellular|venetian|wood|shutter/i.test(answer),
      ) ?? [];
    const failures = [];
    const check = (passed, reason) => {
      if (!passed) failures.push(reason);
    };
    check(!!question, "Missing follow-up question");
    check(
      !question?.answers.some((answer) => /\s[\u2014\u2013-]\s/.test(answer)),
      "Answers contain explanatory clauses",
    );
    if (sample.fixtureProducts) {
      check(attempts === 2, "Discovery must use two completions");
      check(
        operations.length === 1 && operations[0].name === "search_products",
        "Discovery must use one catalogue operation without guides or navigation",
      );
      const queries = operations
        .filter((operation) => operation.name === "search_products")
        .flatMap((operation) => operation.queries);
      check(queries.length === 1, "A chosen family needs one targeted query");
      check(
        queries.every((query) => /pleat|cellular|honeycomb/i.test(query)),
        "Query lost the chosen pleated family",
      );
      check(
        queries.every((query) =>
          /no[- ]drill|without drill|drill[- ]free/i.test(query),
        ),
        "Query lost the no-drill requirement",
      );
      check(
        queries.every((query) => /pattern|textur|woven/i.test(query)),
        "Query lost the pattern/texture preference",
      );
      check(
        queries.every(
          (query) =>
            sample.opening.test(query) && !sample.wrongOpening?.test(query),
        ),
        "Query lost or contradicted the current opening",
      );
      check(
        selected.every((id) => sample.eligibleIds.includes(id)),
        "Cards included an ineligible or unverified product",
      );
      check(
        sample.eligibleIds.length
          ? selected.length > 0 && selected.length <= 10
          : selected.length === 0,
        "Incorrect card presence for eligible results",
      );
      if (!sample.eligibleIds.length) {
        check(
          /no |not |cannot|can.t|couldn.t|haven.t found|none|unable/i.test(message ?? ""),
          "Missing clear explanation that no result meets the request",
        );
        check(
          question?.answers.length >= 2 &&
            /other|different|no[- ]drill|style|pattern|texture|fit|broaden|roller|pleat/i.test(
              question.answers.join(" "),
            ),
          "No useful alternatives after unsuitable results",
        );
      }
    } else {
      check(
        !sample.quietIntake || !message?.trim(),
        "Intake included redundant message text",
      );
      check(
        !sample.familyChoice ||
          (familyAnswers.length >= 2 &&
            question?.answers.some((answer) => /everything|all/i.test(answer))),
        "Missing family choices and broad-discovery answer",
      );
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
        "synthetic catalog, 100ms operation; ready times exclude network polling, image loading and Live audio",
      providerRequests,
      maxRequests,
      samples: report,
    },
    null,
    2,
  ),
);
if (report.some((sample) => !sample.passed)) process.exitCode = 1;
