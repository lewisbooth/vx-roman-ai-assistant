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
        export * from './admin/insights/format';
        export function mount(container) {
          const root = createRoot(container);
          return {
            render(name, props) {
              const View = views[name];
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
  assert.equal(container.querySelectorAll("dd").length, 6);
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
  assert.equal(values[4], "1,234");
  assert.equal(values[5], "2.5");
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
