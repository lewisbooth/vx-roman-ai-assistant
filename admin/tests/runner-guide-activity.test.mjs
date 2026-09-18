import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["admin/conversations/runner.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "guide-activity-boundaries",
      setup(build) {
        build.onResolve(
          {
            filter:
              /repository\.server$|model\.server$|browser-tools\.server$|measurements\/service\.server$|guides\/library\.server$/,
          },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          contents: path.endsWith("model.server")
            ? "export const TEXT_MODEL='synthetic'; export const generateReply=(...args)=>mock.generate(...args);"
            : path.endsWith("library.server")
              ? `export const readLibraryInventory=(...args)=>{mock.libraryReads.push(args);return []};
                 export const readBoundLibrarySource=()=>undefined;
                 export const saveLibraryDiscovery=()=>{throw Error('Unexpected library discovery')};
                 export const readLibraryGuides=()=>{throw Error('Unexpected library read')};
                 export const bindLibrarySource=()=>{throw Error('Unexpected library binding')};
                 export const clearLibrarySession=(id)=>mock.libraryClears.push(id);`
            : path.includes("usage")
              ? "export const recordModelUsage=async()=>{};"
              : path.endsWith("browser-tools.server")
                ? "export const requestBrowserTool=()=>{throw Error('Unexpected browser action');};"
                : path.includes("measurements")
                  ? "export const executeMeasurementTool=()=>{throw Error('Unexpected measurement action');};"
                  : `export const beginTurn=(...args)=>mock.begin(...args);
                   export const finishTurn=(...args)=>mock.finish(...args);
                   export const getSnapshot=(...args)=>mock.snapshot(...args);
                   export const getReadRevision=(id)=>mock.rows.get(id).revision;
                   export const failPending=async()=>{};
                   export const endConversation=(...args)=>mock.end(...args);`,
        }));
      },
    },
  ],
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const rows = new Map();
  const generations = [];
  const logs = [];
  let next = 0;
  const mock = {
    rows,
    libraryReads: [],
    libraryClears: [],
    snapshot: async (id) => {
      const row = rows.get(id);
      return plain({
        ...row,
        busy: row.messages.some((item) => item.status === "pending"),
        messages: row.messages.filter(
          (item) => item.role !== "context" || item.status === "failed",
        ),
      });
    },
    begin: async (id, input, voiceId) => {
      const row = rows.get(id) ?? {
        id,
        status: "active",
        revision: 0,
        tools: [],
        messages: [],
      };
      const assistantId = `reply-${++next}`;
      row.messages.push({
        id: assistantId,
        role: voiceId ? "context" : "assistant",
        status: "pending",
        parts: [],
      });
      row.revision++;
      rows.set(id, row);
      return {
        assistantId,
        snapshot: await mock.snapshot(id),
        history: [],
        origin: "https://store.example",
      };
    },
    finish: async (id, assistantId, result) => {
      await mock.beforeFinish?.();
      const row = rows.get(id);
      const message = row.messages.find((item) => item.id === assistantId);
      if (!message || message.status !== "pending") return false;
      message.status =
        result.status === "cancelled" ? "complete" : result.status;
      row.revision++;
      return true;
    },
    end: async (id) => {
      const row = rows.get(id);
      row.status = "ended";
      row.messages.forEach((item) => {
        item.status = "complete";
      });
      row.revision++;
      return mock.snapshot(id);
    },
    generate: (...args) => {
      const result = deferred();
      generations.push({
        text: args[1],
        signal: args[2],
        reading: args[8],
        library: args[10],
        result,
      });
      return result.promise;
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    AbortController,
    AbortSignal,
    URL,
    console: { error: (...args) => logs.push(args) },
  });
  const api = module.exports;
  const start = async (voice = false, id = "chat") => {
    const requestId = `request-${next + 1}`;
    const done = voice
      ? api.runVoiceDelegation(
          id,
          "voice-1",
          requestId,
          new AbortController().signal,
        )
      : api.startTurn(id, { requestId, text: "A synthetic request" });
    await flush();
    return { generation: generations.at(-1), done };
  };
  return { api, mock, rows, logs, start };
}

for (const voice of [false, true]) {
  test(`${voice ? "voice" : "text"} guide activity advances poll versions, clears and never exposes voice briefing text`, async () => {
    const ctx = setup();
    const { generation, done } = await ctx.start(voice);
    assert.deepEqual(plain(generation.library.inventory), []);
    assert.deepEqual(plain(ctx.mock.libraryReads), [["chat", "https://store.example"]]);
    const before = await ctx.api.readConversation("chat");
    assert.equal(before.streamRevision, 0);
    if (voice) generation.text("PRIVATE_UNSPOKEN_BRIEFING");
    assert.equal(
      (await ctx.api.readConversation("chat", before)).unchanged,
      true,
    );
    const kinds = ["measuring"];
    generation.reading(kinds);
    kinds.push("fitting"); // Callback input ownership cannot mutate public state.
    const reading = await ctx.api.readConversation("chat", before);
    assert.deepEqual(plain(reading.readingGuides), ["measuring"]);
    assert.equal(reading.streamRevision, 1);
    assert.doesNotMatch(JSON.stringify(reading), /PRIVATE_UNSPOKEN_BRIEFING/);
    generation.reading(["measuring"]);
    assert.equal(
      (await ctx.api.readConversation("chat", reading)).unchanged,
      true,
    );
    generation.reading(["measuring", "fitting"]);
    const both = await ctx.api.readConversation("chat", reading);
    assert.equal(both.streamRevision, 2);
    generation.reading(undefined);
    const cleared = await ctx.api.readConversation("chat", both);
    assert.equal(cleared.readingGuides, undefined);
    assert.equal(cleared.streamRevision, 3);
    generation.reading(["fitting"]);
    generation.result.resolve({ text: "Done", model: "synthetic" });
    await done;
    await flush();
    const final = await ctx.api.readConversation("chat");
    assert.equal(final.busy, false);
    assert.equal(final.readingGuides, undefined);
    assert.equal(final.streamRevision, 0);
    assert.deepEqual(ctx.mock.libraryClears, []);
    assert.ok(
      ctx.rows
        .get("chat")
        .messages.every((message) => !Object.hasOwn(message, "readingGuides")),
    );
  });
}

test("provider failure clears reading activity and preserves the failed outcome", async () => {
  const ctx = setup();
  const { generation, done } = await ctx.start(true);
  generation.reading(["fitting"]);
  generation.result.reject(new Error("PRIVATE_PROVIDER_FAILURE"));
  await done;
  const final = await ctx.api.readConversation("chat");
  assert.equal(final.readingGuides, undefined);
  assert.equal(final.busy, false);
  assert.equal(final.messages[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(ctx.logs), /PRIVATE_PROVIDER_FAILURE/);
  assert.deepEqual(ctx.mock.libraryClears, ["chat"]);
});

test("cancel clears activity before persistence, and obsolete callbacks cannot affect a replacement", async () => {
  const ctx = setup();
  const first = await ctx.start(true);
  first.generation.reading(["measuring"]);
  const reading = await ctx.api.readConversation("chat");
  const finish = deferred();
  ctx.mock.beforeFinish = () => finish.promise;
  const cancelled = ctx.api.cancelVoiceDelegation("chat", "voice-1");
  const clearing = await ctx.api.readConversation("chat", reading);
  assert.equal(clearing.readingGuides, undefined);
  assert.equal(clearing.streamRevision, reading.streamRevision + 1);
  finish.resolve();
  await cancelled;
  assert.deepEqual(ctx.mock.libraryClears, ["chat"]);
  ctx.mock.beforeFinish = undefined;
  const second = await ctx.start(true);
  const cleanupAtReplacement = ctx.mock.libraryClears.length;
  second.generation.reading(["fitting"]);
  first.generation.reading(["measuring"]);
  first.generation.result.resolve({ text: "Stale", model: "synthetic" });
  await first.done;
  assert.equal(ctx.mock.libraryClears.length, cleanupAtReplacement, "Obsolete generation cleanup cannot erase a replacement's library evidence");
  const replacement = await ctx.api.readConversation("chat");
  assert.deepEqual(plain(replacement.readingGuides), ["fitting"]);
  assert.equal(replacement.busy, true);
  second.generation.result.resolve({ text: "Current", model: "synthetic" });
  await second.done;
});
