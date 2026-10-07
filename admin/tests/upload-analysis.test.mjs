import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { cwd } from "node:process";
import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: "export * from './admin/conversations/upload-analysis.server'", resolveDir: cwd() },
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "upload-analysis-boundaries", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/db\.server$|^\.\.\/visualizations\/analysis\.server$|^\.\/repository\.server$/ }, (args) => ({path: args.path, namespace: "boundary"}));
    builder.onLoad({filter: /.*/, namespace: "boundary"}, ({path}) => ({contents: path.includes("db.server")
      ? "export default globalThis.testDependencies.prisma"
      : path.includes("analysis.server")
        ? "export const waitForWindowAnalysis = (...args) => globalThis.testDependencies.wait(...args)"
        : "export const getCurrentContext = (...args) => globalThis.testDependencies.context(...args)"}));
  } }],
});
const plain = (value) => JSON.parse(JSON.stringify(value));
function setup(options = {}) {
  let now = 12_000;
  const requests = [], waits = [], contextReads = [];
  const current = {galleryFacts: {selectedWindow: {id: "photo", title: "Kitchen", revision: 1}, selectedWindowAnalysis: {
    status: "completed", completedAt: new Date(13_000).toISOString(), observations: {summary: "Warm wood and green decor."},
  }}, ...options.context};
  const dependencies = {
    prisma: {
      conversation: {async findFirst(args) { requests.push(["conversation", plain(args)]); return options.conversation === null ? null : {galleryOwnerId: "owner", selectedWindowPhotoId: "photo", ...options.conversation}; }},
      windowPhoto: {async findFirst(args) { requests.push(["photo", plain(args)]); return options.photo === null ? null : {id: "photo", analysisQueuedAt: new Date(10_000), ...options.photo}; }},
      conversationMessage: {async findFirst(args) {
        requests.push(["message", plain(args)]);
        if (args.where.id === "photo") return options.upload === null ? null : {sequence: 20, ...options.upload};
        if (args.where.id === "reply") return options.reply === null ? null : {sequence: 22, ...options.reply};
        return options.answered ?? null;
      }},
    },
    async wait(ownerId, photoId, timeout, signal) {
      waits.push({ownerId, photoId, timeout, signal});
      await options.wait?.({ownerId, photoId, timeout, signal, current, setNow: (value) => { now = value; }});
    },
    async context(id) { contextReads.push(id); return current; },
  };
  const module = {exports: {}};
  runInNewContext(bundle.outputFiles[0].text, {module, exports: module.exports, testDependencies: dependencies, Error, Date: class extends Date {static now() { return now; }}});
  return {api: module.exports, current, requests, waits, contextReads, setNow(value) { now = value; }};
}

test("first reply joins the exact owned upload, refreshes facts and includes a fast cached summary", async () => {
  const ctx = setup();
  const signal = new AbortController().signal;
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", signal);
  assert.deepEqual(plain(gallery.uploadSummary), {windowId: "photo", suggestName: false, includeSummary: true});
  assert.equal(gallery.selectedWindowAnalysis.observations.summary, "Warm wood and green decor.");
  assert.deepEqual(ctx.waits, [{ownerId: "owner", photoId: "photo", timeout: 8000, signal}]);
  assert.deepEqual(ctx.contextReads, ["conversation"]);
  assert.deepEqual(ctx.requests.find(([table]) => table === "photo")[1].where, {
    id: "photo", ownerId: "owner", conversationId: "conversation", uploadStatus: "ready", deletedAt: null,
  });
  assert.deepEqual(ctx.requests.find(([table]) => table === "conversation")[1].where, {
    id: "conversation", status: "active", galleryOwner: {revokedAt: null},
  });
});

test("only a fresh default title permits an inferred name and a customer rename during analysis wins", async () => {
  for (const [title, revision, suggestName] of [["Uploaded image", 1, true], ["Kitchen", 1, false], ["Uploaded image", 2, false]]) {
    const ctx = setup();
    Object.assign(ctx.current.galleryFacts.selectedWindow, {title, revision});
    const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
    assert.equal(gallery.uploadSummary.suggestName, suggestName);
  }
  const ctx = setup({wait: ({current}) => { Object.assign(current.galleryFacts.selectedWindow, {title: "My study", revision: 2}); }});
  Object.assign(ctx.current.galleryFacts.selectedWindow, {title: "Uploaded image", revision: 1});
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
  assert.equal(gallery.uploadSummary.suggestName, false);
  assert.equal(gallery.selectedWindow.title, "My study");
});

test("upload waiting budget is measured from queuedAt rather than restarted for the advisor", async () => {
  for (const [now, remaining] of [[14_900, 5100], [19_900, 100], [20_000, 0], [25_000, 0]]) {
    const ctx = setup(); ctx.setNow(now);
    await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
    assert.equal(ctx.waits[0].timeout, remaining);
  }
});

test("analysis completing after five seconds but within ten seconds includes the upload summary", async () => {
  const ctx = setup({wait: ({current, setNow}) => {
    setNow(17_000);
    current.galleryFacts.selectedWindowAnalysis.completedAt = new Date(17_000).toISOString();
  }});
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
  assert.equal(gallery.uploadSummary.includeSummary, true);
  assert.equal(gallery.selectedWindowAnalysis.observations.summary, "Warm wood and green decor.");
  assert.equal(ctx.waits.length, 1);
});

test("a late completed analysis remains available as facts while its upload summary is skipped", async () => {
  const ctx = setup({wait: async ({current, setNow}) => {
    setNow(20_001);
    current.galleryFacts.selectedWindowAnalysis.completedAt = new Date(20_001).toISOString();
  }});
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
  assert.equal(gallery.uploadSummary.includeSummary, false);
  assert.ok(gallery.selectedWindowAnalysis.observations, "A late result should remain usable for subsequent relevant advice");
  assert.equal(ctx.waits.length, 1);
});

test("a still-running or failed analysis falls through without a summary", async () => {
  for (const status of ["analyzing", "failed"]) {
    const ctx = setup({context: {galleryFacts: {selectedWindow: {id: "photo"}, selectedWindowAnalysis: {status, completedAt: null}}}});
    const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
    assert.equal(gallery.uploadSummary.includeSummary, false);
  }
});

test("an already answered upload does not wait, refresh or repeat its summary for text or voice", async () => {
  const ctx = setup({answered: {id: "prior-advisor"}});
  assert.equal(await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal), undefined);
  assert.deepEqual(ctx.waits, []);
  assert.deepEqual(ctx.contextReads, []);
  const answeredQuery = ctx.requests.filter(([table]) => table === "message").at(-1)[1].where;
  assert.deepEqual(answeredQuery.sequence, {gt: 20, lt: 22});
  assert.deepEqual(answeredQuery.role, {in: ["assistant", "context"]});
  assert.equal(answeredQuery.status, "complete");
  assert.deepEqual(answeredQuery.model, {not: null});
});

test("missing ownership, old unconsented photos and replies before upload never join analysis", async () => {
  for (const options of [{conversation: null}, {conversation: {galleryOwnerId: null}}, {conversation: {selectedWindowPhotoId: null}}, {photo: null}, {photo: {analysisQueuedAt: null}}, {upload: null}, {reply: null}, {reply: {sequence: 19}}]) {
    const ctx = setup(options);
    assert.equal(await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal), undefined);
    assert.deepEqual(ctx.waits, []);
    assert.deepEqual(ctx.contextReads, []);
  }
});

test("changing the selected photo while waiting cannot attach the former photo's summary", async () => {
  const ctx = setup({wait: ({current}) => { current.galleryFacts = {selectedWindow: {id: "other-photo"}, selectedWindowAnalysis: {status: "queued"}}; }});
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
  assert.equal(gallery.selectedWindow.id, "other-photo");
  assert.equal(gallery.uploadSummary, undefined);
});

test("deletion during analysis refreshes the missing photo quietly but unexpected storage failures surface", async () => {
  const ctx = setup({wait: ({current}) => {
    current.galleryFacts = {selectedWindow: null};
    throw Object.assign(new Error("Photo removed"), {status: 404});
  }});
  const gallery = await ctx.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal);
  assert.equal(gallery.selectedWindow, null);
  assert.equal(gallery.uploadSummary, undefined);
  const broken = setup({wait: () => { throw new Error("Storage unavailable"); }});
  await assert.rejects(broken.api.prepareUploadAnalysis("conversation", "reply", new AbortController().signal), /Storage unavailable/);
  assert.deepEqual(broken.contextReads, []);
});

test("cancelling the advisor aborts its analysis wait and does not publish refreshed facts", async () => {
  const controller = new AbortController();
  const ctx = setup({wait: ({signal}) => {
    assert.equal(signal, controller.signal);
    controller.abort(new Error("Customer changed direction"));
    signal.throwIfAborted();
  }});
  await assert.rejects(ctx.api.prepareUploadAnalysis("conversation", "reply", controller.signal), /Customer changed direction/);
  assert.equal(ctx.waits.length, 1);
  assert.deepEqual(ctx.contextReads, []);
});

test("gallery refresh changes only application facts, preserving working notes, history and other current state", () => {
  const ctx = setup();
  const state = {activeProduct: {path: "/products/linen"}, pendingQuestion: {question: "Width?"}, gallery: {selectedWindow: {id: "old"}}, measurements: {width: 100, height: 200}};
  const history = [
    {role: "assistant", source: "memory", text: "Kitchen first, then bedroom."},
    {role: "user", source: "text", text: "Please keep the current measurements."},
    {role: "assistant", source: "application_state", text: `Application state: ${JSON.stringify(state)}`, sequence: 8},
    {role: "assistant", source: "tool", text: "Historical product receipt."},
  ];
  const gallery = {selectedWindow: {id: "photo"}, uploadSummary: {windowId: "photo", includeSummary: true}};
  const updated = ctx.api.withUploadAnalysis(history, gallery);
  assert.notEqual(updated, history);
  assert.equal(updated[0], history[0]); assert.equal(updated[1], history[1]); assert.equal(updated[3], history[3]);
  const nextState = JSON.parse(updated[2].text.slice("Application state: ".length));
  assert.deepEqual(nextState, {...state, gallery});
  assert.equal(updated[2].sequence, history[2].sequence);
  assert.deepEqual(JSON.parse(history[2].text.slice("Application state: ".length)), state, "Primary and fallback histories must not mutate one another");
});
