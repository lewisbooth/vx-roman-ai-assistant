import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const [viewBundle, routeBundle] = await Promise.all([
  build({
    stdin: {
      contents: `
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import * as views from './admin/insights/ConversationViews';
        import * as pricingViews from './admin/pricing/PricingViews';
        export * from './admin/insights/format';
        export function mount(container) {
          const root = createRoot(container);
          return {
            render(name, props) {
              const View = views[name] ?? pricingViews[name];
              flushSync(() => root.render(<View {...props} />));
            },
            dispose() { root.unmount(); },
          };
        }
      `,
      resolveDir: cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RomanInsightsTest",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    stdin: {
      contents: `
        export { loader as overviewLoader } from './admin/routes/app._index.tsx';
        export { loader as inspectionLoader } from './admin/routes/app.conversations.$id.tsx';
      `,
      resolveDir: cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "inspection-route-boundaries",
        setup(build) {
          build.onResolve(
            { filter: /(?:shopify|repository)\.server$/ },
            (args) => ({ path: args.path, namespace: "mock" }),
          );
          build.onResolve(
            {
              filter:
                /^(?:react-router|@shopify\/shopify-app-react-router\/server)$/,
            },
            (args) => ({ path: args.path, namespace: "mock" }),
          );
          build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents: args.path.endsWith("shopify.server")
              ? "export const authenticate = { admin: (request) => mock.authenticate(request) };"
              : args.path.endsWith("repository.server")
                ? "export const getConversationOverview = (...args) => mock.overview(...args); export const getConversationInspection = (...args) => mock.inspection(...args);"
                : args.path === "react-router"
                  ? "export const data = (value, init) => ({data:value, init}); export const useLoaderData=()=>{}; export const useRevalidator=()=>{};"
                  : "export const boundary={headers:()=>({})};",
          }));
        },
      },
    ],
  }),
]);

const ORIGIN = "https://hd-dev-single.myshopify.com";
const NOW = "2026-09-15T10:00:00.000Z";
const ID = "78b1ba71-5a92-40ef-a9db-768a0c96a2e0";
const EMPTY_USAGE = {
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  modelCalls: 2,
  reportedModelCalls: 0,
  voiceSeconds: null,
  voiceSessions: 1,
  reportedVoiceSessions: 0,
};

function setupView(t) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://roman.example/app",
    runScripts: "outside-only",
  });
  dom.window.eval(
    `${viewBundle.outputFiles[0].text}\nwindow.api = RomanInsightsTest;`,
  );
  const container = dom.window.document.querySelector("#root");
  const view = dom.window.api.mount(container);
  t.after(() => {
    view.dispose();
    dom.window.close();
  });
  return { ...view, container, api: dom.window.api };
}

function setupRoutes() {
  const calls = [];
  const mock = {
    authenticate: async (request) => {
      calls.push(["authenticate", request]);
      return { session: { shop: "hd-dev-single.myshopify.com" } };
    },
    overview: async (...args) => {
      calls.push(["overview", ...args]);
      return { page: args[1] };
    },
    inspection: async (...args) => {
      calls.push(["inspection", ...args]);
      return { conversation: { id: args[1] } };
    },
  };
  const module = { exports: {} };
  runInNewContext(routeBundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    mock,
    Response,
    URL,
    process: { env: { SHOPIFY_API_KEY: "public-app-key" } },
  });
  return { ...module.exports, calls, mock };
}

test("inspection shows the same verified guide selection using safe PDF links", t => {
  const { render, container } = setupView(t);
  const part = { type: "guides", version: 1, invocationId: ID, productPath: "/products/shade", guides: [
    { kind: "fitting", url: `${ORIGIN}/cdn/shop/files/fitting.pdf?v=2` },
    { kind: "measuring", url: `${ORIGIN}/cdn/shop/files/measuring.pdf?v=1` },
  ] };
  const message = { id: "guides", role: "assistant", status: "complete", createdAt: NOW, parts: [part] };
  render("ConversationTimeline", { origin: ORIGIN, messages: [message] });
  const links = [...container.querySelectorAll("a")];
  assert.deepEqual(links.map(link => link.textContent), ["Fitting guide", "Measuring guide"]);
  assert.deepEqual(links.map(link => link.href), part.guides.map(guide => guide.url));
  for (const link of links) {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
  render("ConversationTimeline", { origin: ORIGIN, messages: [{ ...message, parts: [{ ...part, guides: [{ kind: "fitting", url: "https://other-shop.myshopify.com/cdn/shop/files/fitting.pdf" }] }] }] });
  assert.equal(container.querySelectorAll("a").length, 0);
  assert.match(container.textContent, /guides are unavailable/);
});

test("inspection retains saved timeline order and safely renders text, voice, visits and widget references", (t) => {
  const { render, container } = setupView(t);
  render("ConversationTimeline", {
    origin: ORIGIN,
    messages: [
      {
        id: "1",
        role: "user",
        status: "complete",
        createdAt: NOW,
        parts: [{ type: "text", text: "<img src=x onerror=alert(1)>" }],
      },
      {
        id: "2",
        role: "assistant",
        status: "complete",
        createdAt: NOW,
        parts: [
          {
            type: "text",
            text: "**Blackout** [blind](/products/example)\n\n[unsafe](javascript:alert(1))\n<script>alert(1)</script>",
          },
        ],
      },
      {
        id: "3",
        role: "context",
        status: "complete",
        createdAt: NOW,
        parts: [
          {
            type: "page_view",
            version: 1,
            title: "Kitchen blind",
            path: "/products/example",
            occurredAt: NOW,
          },
        ],
      },
      {
        id: "4",
        role: "assistant",
        status: "complete",
        createdAt: NOW,
        parts: [
          {
            type: "voice",
            version: 1,
            voiceId: "voice1",
            text: "Voice **stays plain**",
            startMs: 1.5,
            endMs: 200.1,
          },
        ],
      },
      {
        id: "5",
        role: "assistant",
        status: "complete",
        createdAt: NOW,
        parts: [
          {
            type: "products",
            version: 1,
            invocationId: "tool1",
            productIds: ["gid://shopify/Product/23"],
          },
        ],
      },
    ],
  });
  const rows = [...container.querySelectorAll("ol[aria-label] > li")];
  assert.equal(rows.length, 5);
  assert.match(rows[0].textContent, /<img src=x/);
  assert.equal(rows[1].querySelector("p strong").textContent, "Blackout");
  assert.match(rows[2].textContent, /Viewed Kitchen blind/);
  assert.match(rows[3].textContent, /Voice \*\*stays plain\*\*/);
  assert.match(
    rows[4].textContent,
    /Product carousel.*gid:\/\/shopify\/Product\/23/s,
  );
  assert.equal(container.querySelectorAll("img, script, iframe").length, 0);
  assert.equal(container.querySelectorAll("a").length, 2);
  for (const link of container.querySelectorAll("a")) {
    assert.equal(link.href, `${ORIGIN}/products/example`);
    assert.equal(link.target, "_blank");
    assert.match(link.rel, /noopener/);
  }
});

test("transcript links reject other origins, credentials and private routes", (t) => {
  const { api } = setupView(t);
  assert.equal(
    api.storefrontHref("/products/shade", ORIGIN),
    `${ORIGIN}/products/shade`,
  );
  for (const href of [
    "https://elsewhere.example/",
    "javascript:alert(1)",
    "//elsewhere.example/",
    "https://user:pass@hd-dev-single.myshopify.com/products/a",
    "/account",
    "/checkout",
    "/%61ccount",
    "/products/a?token=private",
    "/products/a#fragment",
  ]) {
    assert.equal(api.storefrontHref(href, ORIGIN), null, href);
  }
});

test("usage distinguishes missing reporting from measured zero and states coverage", (t) => {
  const { render, container } = setupView(t);
  render("RecordedUsage", { usage: EMPTY_USAGE });
  assert.equal(container.querySelectorAll("dd").length, 7);
  assert.ok(
    [...container.querySelectorAll("dd")].every(
      (node) => node.textContent === "Not recorded",
    ),
  );
  assert.match(
    container.textContent,
    /0 of 2 Luna calls and 0 of 1 GPT-Live sessions/,
  );
  render("RecordedUsage", {
    usage: {
      ...EMPTY_USAGE,
      inputTokens: 0,
      totalTokens: 1_234,
      voiceSeconds: 2.5,
      reportedModelCalls: 1,
      reportedVoiceSessions: 1,
    },
  });
  const values = [...container.querySelectorAll("dd")].map(
    (node) => node.textContent,
  );
  assert.equal(values[0], "0");
  assert.equal(values[5], "1,234");
  assert.equal(values[6], "2.5");
});

test("tool and voice failures display stored status and error rather than inferred success", (t) => {
  const { render, container } = setupView(t);
  render("ToolActivity", {
    tools: [
      {
        id: "a",
        name: "navigate",
        status: "failed",
        createdAt: NOW,
        completedAt: NOW,
        error: "Full navigation interrupted confirmation.",
      },
      {
        id: "b",
        name: "search_products",
        status: "running",
        createdAt: NOW,
        completedAt: null,
        error: null,
      },
    ],
  });
  assert.match(
    container.textContent,
    /navigatefailed.*Full navigation interrupted confirmation/s,
  );
  assert.match(container.textContent, /search_productsrunning/);
  assert.equal(container.querySelectorAll("button, s-button").length, 0);
  render("VoiceActivity", {
    sessions: [
      {
        id: "v",
        model: null,
        status: "failed",
        createdAt: NOW,
        closedAt: NOW,
        usageSeconds: null,
        error: "Connection closed.",
        cost: { usd: null, rateId: null, reason: "missing_usage" },
      },
    ],
  });
  assert.match(container.textContent, /Not recordedfailed/);
  assert.match(container.textContent, /Connection closed/);
});

test("conversation list uses bounded paging links and handles empty pages", (t) => {
  const { render, container } = setupView(t);
  const overview = {
    page: 2,
    hasNextPage: true,
    conversations: [
      {
        id: ID,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        turnCount: 2,
        voiceSessions: 1,
      },
    ],
  };
  render("ConversationList", { overview });
  assert.equal(
    container.querySelector("s-link").getAttribute("href"),
    `/app/conversations/${ID}`,
  );
  assert.deepEqual(
    [...container.querySelectorAll("s-button")].map((node) =>
      node.getAttribute("href"),
    ),
    ["/app?page=1", "/app?page=3"],
  );
  render("ConversationList", {
    overview: { ...overview, page: 1, hasNextPage: false, conversations: [] },
  });
  assert.match(container.textContent, /No conversations yet/);
  assert.equal(container.querySelectorAll("s-button").length, 0);
});

test("overview authenticates independently and scopes data to the authenticated shop", async () => {
  const { overviewLoader, calls } = setupRoutes();
  const request = new Request(
    "https://roman.example/app?page=2&shop=other.myshopify.com",
  );
  const result = await overviewLoader({ request, params: {} });
  assert.equal(calls[0][0], "authenticate");
  assert.equal(calls[0][1], request);
  assert.deepEqual(calls[1], ["overview", "hd-dev-single.myshopify.com", 2]);
  assert.equal(result.data.overview.page, 2);
  assert.equal(result.init.headers["Cache-Control"], "no-store");
  assert.match(
    result.data.themeEditorUrl,
    /^https:\/\/hd-dev-single\.myshopify\.com\/admin\/themes\/current\/editor\?/,
  );
});

test("invalid pagination is rejected after authentication and before data access", async () => {
  for (const query of [
    "page=",
    "page=0",
    "page=-1",
    "page=1.5",
    "page=1e2",
    "page=10001",
    "page=1&page=2",
  ]) {
    const { overviewLoader, calls } = setupRoutes();
    await assert.rejects(
      overviewLoader({
        request: new Request(`https://roman.example/app?${query}`),
        params: {},
      }),
      (error) =>
        error instanceof Response &&
        error.status === 400 &&
        error.headers.get("Cache-Control") === "no-store",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "authenticate");
  }
});

test("detail authenticates independently and sends only the authenticated shop to the inspection query", async () => {
  const { inspectionLoader, calls } = setupRoutes();
  const request = new Request(
    `https://roman.example/app/conversations/${ID}?shop=other.myshopify.com`,
  );
  const result = await inspectionLoader({ request, params: { id: ID } });
  assert.equal(calls[0][0], "authenticate");
  assert.deepEqual(calls[1], ["inspection", "hd-dev-single.myshopify.com", ID]);
  assert.equal(result.init.headers["Cache-Control"], "no-store");
});

test("missing or unavailable conversation returns the same no-store 404", async () => {
  const { inspectionLoader, mock } = setupRoutes();
  mock.inspection = async () => null;
  for (const params of [{}, { id: ID }]) {
    await assert.rejects(
      inspectionLoader({
        request: new Request("https://roman.example/app/conversations/missing"),
        params,
      }),
      (error) =>
        error instanceof Response &&
        error.status === 404 &&
        error.headers.get("Cache-Control") === "no-store",
    );
  }
});

test("authentication failure stops both page loaders before querying conversations", async () => {
  const { overviewLoader, inspectionLoader, mock, calls } = setupRoutes();
  const failure = new Response(null, {
    status: 302,
    headers: { Location: "/auth/login" },
  });
  mock.authenticate = async () => {
    throw failure;
  };
  for (const loader of [overviewLoader, inspectionLoader]) {
    await assert.rejects(
      loader({
        request: new Request("https://roman.example/app"),
        params: { id: ID },
      }),
      (error) => error === failure,
    );
  }
  assert.equal(calls.length, 0);
});

test("USD formatting preserves missing values, measured zero and tiny positive estimates", (t) => {
  const { api } = setupView(t);
  assert.equal(api.estimatedUsd(null), "Unavailable");
  assert.equal(api.estimatedUsd(0), "USD 0.00");
  assert.equal(api.estimatedUsd(0.0000001), "< USD 0.000001");
  assert.equal(api.estimatedUsd(0.000001), "USD 0.000001");
  assert.equal(api.estimatedUsd(1.23456789), "USD 1.234568");
  assert.equal(api.estimatedUsd(1200.1), "USD 1,200.10");
});

test("estimated totals distinguish partial pricing from a complete measured zero", (t) => {
  const { render, container } = setupView(t);
  const cost = {
    totalUsd: 0.000004,
    modelUsd: 0.000004,
    voiceUsd: null,
    pricedModelCalls: 1,
    unpricedModelCalls: 2,
    pricedVoiceSessions: 0,
    unpricedVoiceSessions: 1,
  };
  render("EstimatedCosts", { cost });
  assert.deepEqual(
    [...container.querySelectorAll("dd")].map((node) => node.textContent),
    ["USD 0.000004", "USD 0.000004", "Unavailable"],
  );
  assert.match(container.textContent, /Partial estimate/);
  assert.match(
    container.textContent,
    /Priced 1 of 3 model calls and 0 of 1 voice sessions/,
  );
  assert.match(container.textContent, /Unpriced activity is excluded/);
  render("EstimatedCosts", {
    cost: {
      ...cost,
      totalUsd: 0,
      modelUsd: 0,
      voiceUsd: 0,
      unpricedModelCalls: 0,
      unpricedVoiceSessions: 0,
      pricedVoiceSessions: 1,
    },
  });
  assert.ok(
    [...container.querySelectorAll("dd")].every(
      (node) => node.textContent === "USD 0.00",
    ),
  );
  assert.doesNotMatch(container.textContent, /Partial estimate|Unavailable/);
});

test("cost cells expose distinct missing-usage, missing-rate and invalid-usage reasons", (t) => {
  const { render, container } = setupView(t);
  for (const [reason, expected] of [
    ["missing_usage", "Required usage not recorded"],
    ["missing_rate", "No rate for this model, tier or date"],
    ["invalid_usage", "Usage is inconsistent; cannot estimate"],
  ]) {
    render("CostValue", { cost: { usd: null, rateId: null, reason } });
    assert.match(container.textContent, /Unavailable/);
    assert.ok(container.textContent.includes(expected));
    assert.doesNotMatch(container.textContent, /USD 0\.00/);
  }
  render("CostValue", {
    cost: { usd: 0, rateId: "luna-period-a", reason: null },
  });
  assert.match(container.textContent, /USD 0\.00.*Rate: luna-period-a/);
});

test("pricing history shows exact UTC boundaries, tier rates, context thresholds and sources", (t) => {
  const { render, container } = setupView(t);
  const base = {
    id: "luna-standard-test",
    kind: "tokens",
    model: "gpt-5.6-luna",
    currency: "USD",
    serviceTier: "default",
    effectiveFrom: "2026-09-15T00:00:00.000Z",
    effectiveTo: "2026-09-16T12:34:56.789Z",
    verifiedAt: "2026-09-15T15:36:00.000Z",
    sourceUrl: "https://developers.openai.com/api/docs/pricing",
    prices: {
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      cacheWriteInputPerMillion: 0.25,
      outputPerMillion: 1.2,
    },
    longContext: {
      aboveInputTokens: 272000,
      prices: {
        inputPerMillion: 0.4,
        cachedInputPerMillion: 0.04,
        cacheWriteInputPerMillion: 0.5,
        outputPerMillion: 1.8,
      },
    },
  };
  render("PricingHistory", {
    prices: [
      base,
      {
        ...base,
        id: "luna-fast-test",
        serviceTier: "priority",
        effectiveTo: null,
      },
      {
        ...base,
        id: "live-test",
        model: "gpt-live-1",
        kind: "voice",
        serviceTier: null,
        effectiveTo: null,
        perMinute: 0.05,
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-live-1",
      },
    ],
  });
  const rows = [...container.querySelectorAll("s-table-body s-table-row")];
  assert.equal(rows.length, 3);
  assert.match(
    container.textContent,
    /From \(inclusive\).*Until \(exclusive\)/s,
  );
  assert.match(rows[0].textContent, /2026-09-15 00:00:00\.000 UTC/);
  assert.match(rows[0].textContent, /2026-09-16 12:34:56\.789 UTC/);
  assert.match(rows[0].textContent, /Standard \(default\)/);
  assert.match(
    rows[0].textContent,
    /Short context: up to 272,000 input tokens/,
  );
  assert.match(rows[0].textContent, /Long context: over 272,000 input tokens/);
  assert.match(rows[0].textContent, /Cache-write inputUSD 0\.25/);
  assert.match(rows[0].textContent, /Cache-write inputUSD 0\.50/);
  assert.match(rows[1].textContent, /Fast \(priority\).*Open ended/s);
  assert.match(rows[2].textContent, /USD 0\.05 per minute/);
  assert.match(
    container.textContent,
    /whole request, not just tokens above the threshold/,
  );
  assert.match(
    container.textContent,
    /provider-reported seconds.*divided by 60/s,
  );
  assert.equal(
    rows[0].querySelector('time[datetime="2026-09-15T15:36:00.000Z"]')
      .textContent,
    "2026-09-15 15:36:00.000 UTC",
  );
  assert.equal(
    rows[2].querySelector("s-link").getAttribute("href"),
    "https://developers.openai.com/api/docs/models/gpt-live-1",
  );
  assert.equal(
    rows[2].querySelector("s-link").getAttribute("target"),
    "_blank",
  );
  assert.equal(
    container.querySelectorAll("input, s-text-field, s-button").length,
    0,
  );
});

test("model and voice activity show per-attempt costs with actual tiers and cache-write usage", (t) => {
  const { render, container } = setupView(t);
  render("ModelActivity", {
    usage: [
      {
        id: "call1",
        assistantId: "message1",
        model: "gpt-5.6-luna",
        serviceTier: "priority",
        status: "complete",
        createdAt: NOW,
        completedAt: NOW,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 30,
        outputTokens: 10,
        reasoningTokens: 2,
        totalTokens: 110,
        cost: { usd: 0.000015, rateId: "luna-fast-test", reason: null },
      },
    ],
  });
  assert.match(container.textContent, /Fast \(priority\)/);
  assert.match(container.textContent, /100 \/ 20 \/ 30/);
  assert.match(container.textContent, /USD 0\.000015.*Rate: luna-fast-test/s);
  render("VoiceActivity", {
    sessions: [
      {
        id: "voice1",
        model: "gpt-live-1",
        status: "closed",
        createdAt: NOW,
        closedAt: NOW,
        usageSeconds: 24,
        error: null,
        cost: { usd: 0.02, rateId: "live-test", reason: null },
      },
    ],
  });
  assert.match(container.textContent, /24USD 0\.02.*Rate: live-test/s);
});
