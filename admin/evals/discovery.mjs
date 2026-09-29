// Live, bounded advisor evaluation. Synthetic history/catalog only; no browser or cart actions.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

if (!process.argv.includes("--live")) {
  console.log("Run node admin/evals/discovery.mjs --live to make bounded billable OpenAI requests with synthetic data.");
  process.exit(0);
}
process.loadEnvFile();
assert.ok(process.env.OPENAI_API_KEY, "Set the private root OPENAI_API_KEY.");
await mkdir(".agents", { recursive: true });
const file = resolve(".agents/discovery-eval-model.mjs");
await build({
  stdin: { contents: 'export {generateReply} from "./admin/conversations/model.server.ts"; export {TurnMetrics} from "./admin/conversations/turn-metrics.server.ts";', resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", packages: "external", outfile: file,
  plugins: [{ name: "isolated-model-availability", setup(builder) {
    builder.onResolve({ filter: /availability\.server$/ }, () => ({ path: "availability", namespace: "eval" }));
    builder.onLoad({ filter: /.*/, namespace: "eval" }, () => ({ contents: `
      export const PRIMARY_TEXT_MODEL="gpt-6-luna", FALLBACK_TEXT_MODEL="gpt-5.6-luna";
      export const textModelForRequest=async()=>PRIMARY_TEXT_MODEL;
      export const assertServiceAvailable=async()=>{}, isServiceSuspended=()=>false;
      export const reportPrimaryUnavailable=async()=>{throw new Error("Primary model unavailable during evaluation")};
      export const reportFallbackUnavailable=async()=>{};
    ` }));
  } }],
});
const { generateReply, TurnMetrics } = await import(pathToFileURL(file).href);
const origin = "https://synthetic.example";
const history = [
  { role: "user", text: "I'd like living-room blinds for light control and privacy. Standard rectangular windows, no special mount requirements." },
  { role: "assistant", text: "Would you like fabric rollers, adjustable slats, softer Roman blinds, or a mix?" },
  { role: "user", text: "Show me everything. I want a varied selection of styles, not different colours of the same blind." },
];
const report = [];
for (const effort of ["medium", "low"]) for (const mode of ["text", "voice"]) {
  const metrics = new TurnMetrics();
  const operations = [];
  const products = new Map();
  let attempts = 0;
  try {
    const reply = await generateReply(history, () => {}, AbortSignal.timeout(60_000), async (_callId, name, input) => {
      operations.push({ name, ...(name === "search_products" ? { queries: input.queries } : {}) });
      if (name !== "search_products") throw new Error("Synthetic discovery permits only search_products.");
      await delay(100);
      const queries = input.queries.map((query, group) => {
        const family = /roman/i.test(query) ? "Roman" : /venetian|wood|slats/i.test(query) ? "Venetian" : /pleat|cellular|honeycomb/i.test(query) ? "Cellular" : "Roller";
        const productIds = Array.from({length:10}, (_, i) => {
          const id = `gid://shopify/Product/${1000 + group * 100 + i}`;
          const description = family === "Venetian" ? "Adjustable slats let customers balance privacy and daylight." : family === "Cellular" ? "Cellular light-filtering fabric softens daylight and provides daytime privacy." : family === "Roman" ? "Soft fabric folds with optional light-filtering or blackout lining for privacy and light control." : "Smooth roller fabric with optional light-filtering or blackout lining for privacy and light control.";
          products.set(id, { id, title: `Synthetic ${family} Style ${i + 1}`, description, url: `${origin}/products/${family.toLowerCase()}-${i}`, priceLabel: `From GBP ${20+i}.00` });
          return id;
        });
        return {query,status:"succeeded",productIds};
      });
      return {products:[...products.values()],messages:[],queries};
    }, mode, async usage => {
      if (usage.status === "pending" && ++attempts > 4) throw new Error("Evaluation completion budget exceeded.");
      metrics.usage(usage);
    }, origin, undefined, undefined, undefined, undefined,
    (name, active) => metrics.activity(name, active), effort);
    metrics.ready(!!reply.presentation, mode === "voice");
    const selected = reply.presentation?.productIds ?? [];
    const families = [...new Set(selected.map(id => products.get(id)?.title.split(" ")[1]))];
    const passed = attempts === 2 && operations.length === 1 && operations[0].name === "search_products" &&
      operations[0].queries.length >= 2 && selected.length > 0 && selected.length <= 10 && families.length >= 2 && !!reply.questionPresentation;
    report.push({effort,mode,passed,operations,cards:selected.length,families,metrics:metrics.snapshot()});
  } catch (error) {
    report.push({effort,mode,passed:false,operations,error:error.name,metrics:metrics.snapshot()});
  }
  console.log(JSON.stringify(report.at(-1)));
}
await writeFile(".agents/discovery-evaluation.json", JSON.stringify({fixture:"synthetic catalog, 100ms operation; ready times exclude network polling, image loading and Live audio",samples:report},null,2));
if (report.some(sample => !sample.passed)) process.exitCode=1;
