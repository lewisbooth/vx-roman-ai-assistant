import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const bundled = await build({
  stdin: {
    contents: "export * from './admin/api-errors/repository.server';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["@prisma/client"],
});
const viewBundle = await build({
  stdin: {
    contents: "export { ApiErrorsView } from './admin/api-errors/ApiErrorViews';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["react", "react/jsx-runtime"],
});
const previousGlobal = global.prismaGlobal;
let directory;
let database;
let repository;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roman-api-errors-"));
  database = new PrismaClient({
    datasourceUrl: `file:${path.join(directory, "test.sqlite").replaceAll("\\", "/")}`,
  });
  global.prismaGlobal = database;
  const migrations = (await readdir("prisma/migrations", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8");
    for (const statement of sql.split(";").map((value) => value.trim()).filter(Boolean))
      await database.$executeRawUnsafe(statement);
  }
  const module = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  repository = module.exports;
});

beforeEach(async () => {
  await database.apiIncident.deleteMany();
});

after(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  global.prismaGlobal = previousGlobal;
});

test("availability transitions create one durable open interval and close it on recovery", async () => {
  assert.equal(await repository.getApiAvailability(), "healthy");
  await repository.setApiAvailability("fallback");
  await repository.setApiAvailability("fallback");
  assert.equal(await database.apiIncident.count(), 1);
  assert.equal(await repository.getApiAvailability(), "fallback");
  await repository.setApiAvailability("outage");
  assert.equal(await repository.getApiAvailability(), "outage");
  await repository.setApiAvailability("outage");
  let rows = await database.apiIncident.findMany({ orderBy: { startedAt: "asc" } });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.kind).sort(), ["fallback", "outage"]);
  assert.equal(rows.filter((row) => row.endedAt === null).length, 1);
  await assert.rejects(
    database.apiIncident.create({
      data: {
        id: randomUUID(),
        kind: "fallback",
        startedAt: new Date(),
        startedDayUtc: new Date().toISOString().slice(0, 10),
      },
    }),
    /Unique constraint failed/,
  );
  await repository.setApiAvailability("healthy");
  await repository.setApiAvailability("healthy");
  assert.equal(await repository.getApiAvailability(), "healthy");
  rows = await database.apiIncident.findMany();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.endedAt instanceof Date));
});

test("report groups global fallback and outage starts and exposes only categorical data", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await repository.setApiAvailability("fallback");
  await repository.setApiAvailability("outage");
  const report = await repository.getApiErrorReport({ from: day, to: day });
  assert.deepEqual(report.totals, { fallback: 1, outage: 1 });
  assert.deepEqual(report.days, [{ day, fallback: 1, outage: 1 }]);
  assert.equal(report.current.state, "outage");
  assert.equal(report.incidents.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /shop|conversation|prompt|token|secret/i);
  const earlier = repository.readApiErrorRange(
    new URLSearchParams(),
    new Date("2026-09-23T14:00:00.000Z"),
  );
  assert.deepEqual(earlier, { from: "2026-08-25", to: "2026-09-23" });
});

test("dashboard presents an accessible outage chart and the selected UTC date range", async () => {
  const day = new Date().toISOString().slice(0, 10);
  await repository.setApiAvailability("fallback");
  await repository.setApiAvailability("outage");
  const report = await repository.getApiErrorReport({ from: day, to: day });
  const module = { exports: {} };
  new Function("require", "module", "exports", viewBundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  const html = renderToStaticMarkup(
    createElement(module.exports.ApiErrorsView, { report }),
  );
  assert.match(html, /Roman is currently unavailable/);
  assert.match(html, /role="img"/);
  assert.match(html, /1 fallback periods and 1 complete outages/);
  assert.match(html, /name="from"[^>]*value="\d{4}-\d{2}-\d{2}"/);
  assert.match(html, /name="to"[^>]*value="\d{4}-\d{2}-\d{2}"/);
  assert.match(html, /Complete outage/);
});

test("date filters reject malformed, duplicate and oversized ranges", () => {
  for (const query of [
    "from=2026-02-30&to=2026-03-01",
    "from=2026-09-24&to=2026-09-23",
    "from=2025-01-01&to=2026-09-23",
    "from=2026-09-01&from=2026-09-02&to=2026-09-23",
    "from=&to=2026-09-23",
  ])
    assert.throws(
      () => repository.readApiErrorRange(new URLSearchParams(query)),
      RangeError,
      query,
    );
});

test("API Errors loader authenticates the request and never caches the report", async () => {
  const route = await build({
    stdin: {
      contents: "export { loader } from './admin/routes/app.api-errors.tsx';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [{
      name: "api-errors-route-boundary",
      setup(build) {
        build.onResolve(
          { filter: /(?:shopify\.server|api-errors\/repository\.server|api-errors\/ApiErrorViews|^react-router$|^@shopify\/shopify-app-react-router\/server$)/ },
          (args) => ({ path: args.path, namespace: "mock" }),
        );
        build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: args.path.endsWith("shopify.server")
            ? "export const authenticate={admin:(request)=>global.routeMock.authenticate(request)};"
            : args.path.endsWith("repository.server")
              ? "export const readApiErrorRange=(params)=>({from:params.get('from'),to:params.get('to')}); export const getApiErrorReport=(range)=>global.routeMock.report(range);"
              : args.path === "react-router"
                ? "export const data=(value,init)=>({value,init}); export const useLoaderData=()=>{}; export const useRevalidator=()=>{};"
                : args.path.endsWith("ApiErrorViews")
                  ? "export const ApiErrorsView=()=>null;"
                  : "export const boundary={headers:()=>({})};",
        }));
      },
    }],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", route.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  const calls = [];
  global.routeMock = {
    authenticate: async (request) => calls.push(["authenticate", request.url]),
    report: async (range) => {
      calls.push(["report", range]);
      return { range };
    },
  };
  try {
    const request = new Request("https://roman.example/app/api-errors?from=2026-09-01&to=2026-09-23");
    const result = await module.exports.loader({ request });
    assert.deepEqual(calls.map(([name]) => name), ["authenticate", "report"]);
    assert.deepEqual(result.value, { range: { from: "2026-09-01", to: "2026-09-23" } });
    assert.equal(result.init.headers["Cache-Control"], "no-store");
  } finally {
    delete global.routeMock;
  }
});
