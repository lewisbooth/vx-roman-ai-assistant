import assert from "node:assert/strict";
import process from "node:process";
import {test} from "node:test";
import {build} from "esbuild";
import {visualizationCases, visualizationWindow, visualizationProduct, createVisualizationFixture, gradeVisualizationReply} from "../evals/visualization.mjs";

const bundle = await build({
  entryPoints: ["shared/assistant-view.ts"], absWorkingDir: process.cwd(),
  bundle: true, write: false, platform: "node", format: "cjs",
});
const module = {exports: {}};
new Function("module", "exports", bundle.outputFiles[0].text)(module, module.exports);
const {parseViewCall, parseViewResult} = module.exports;

test("explicit saved-window viewing permits one optional canonical Gallery action while paid preview remains paused", async () => {
  for (const sample of visualizationCases.filter(({requestedViews}) => requestedViews?.includes("gallery"))) {
    assert.ok(sample.history.some(({text}) => text.startsWith("Show my saved windows")),
      "only actual customer viewing requests grant the fixture's Gallery action");
    for (const mode of ["text", "voice"]) {
      const fixture = createVisualizationFixture(sample);
      const result = await fixture.execute("gallery", "show_view", parseViewCall({view: "gallery"}));
      assert.deepEqual(parseViewResult(result), {status: "shown", view: "gallery"});
      assert.deepEqual(gradeVisualizationReply({...sample, mode}, fixture, {text: "Your saved windows are in Gallery."}), []);
      await fixture.execute("again", "show_view", {view: "gallery"});
      assert.match(gradeVisualizationReply(sample, fixture, {}).join(" "), /opened repeatedly/);
    }
  }
});

test("Gallery permission does not authorize other views, native work or a new preview, and selection alone does not request Gallery", async () => {
  const viewing = visualizationCases.find(({name}) => name === "paused-preview-named-photo-answer");
  for (const [name, args] of [["show_view", {view: "cart"}], ["navigate", {path: visualizationProduct.path}], ["configure_product", {}]]) {
    const fixture = createVisualizationFixture(viewing);
    await fixture.execute("unrequested", name, args);
    // Native navigation is accepted only by product-entry fixtures; the
    // neutral photo case must remain independent of product preparation.
    assert.ok(gradeVisualizationReply(viewing, fixture, {}).length > 0, name);
  }
  const selection = visualizationCases.find(({name}) => name === "paused-preview-photo-card");
  const fixture = createVisualizationFixture(selection);
  await fixture.execute("unrequested-gallery", "show_view", {view: "gallery"});
  assert.match(gradeVisualizationReply(selection, fixture, {}).join(" "), /Unexpected show_view/);
  const pausedFixture = createVisualizationFixture(viewing);
  await pausedFixture.execute("gallery", "show_view", {view: "gallery"});
  await pausedFixture.execute("paid", "create_visualization", {windowId: visualizationWindow.id, productPath: visualizationProduct.path});
  assert.match(gradeVisualizationReply(viewing, pausedFixture, {}).join(" "), /does not authorize/);
});

test("paused named-answer and card fixtures keep newer customer intent above model-authored preview purpose", async () => {
  const cases = visualizationCases.filter((sample) => sample.expected === "neutral");
  assert.ok(cases.length >= 4);
  const named = cases.find((sample) => sample.name.endsWith("named-photo-answer"));
  assert.equal(named.history.at(-1).text, visualizationWindow.title);
  assert.ok(named.history.some((part) => part.text.includes("no new preview")));
  assert.ok(named.history.some((part) => part.text.includes('"purpose":"preview"')));
  for (const sample of cases) {
    const fixture = createVisualizationFixture(sample);
    assert.deepEqual(gradeVisualizationReply(sample, fixture, {text: "The photo is selected. Let's continue fitting."}), []);
    await fixture.execute("paid", "create_visualization", {windowId: visualizationWindow.id, productPath: visualizationProduct.path});
    assert.match(gradeVisualizationReply(sample, fixture, {})[0], /does not authorize/);
  }
});

test("accepted pending and completed previews do not authorize another job when the customer switches products or photos", async () => {
  for (const sample of visualizationCases.filter((item) => item.name.startsWith("accepted-") && item.expected !== "preview")) {
    for (const mode of ["text", "voice"]) {
      const fixture = createVisualizationFixture(sample);
      assert.ok(fixture.history.some(({text}) => text.includes('"customerIntent":true')));
      assert.ok(fixture.history.at(-1).text.includes("recentVisualizations"));
      if (sample.expected === "select") await fixture.execute("select", "navigate", {path: sample.choiceProduct.path});
      else await fixture.execute("list", "list_windows", {query: null, cursor: null});
      assert.deepEqual(gradeVisualizationReply({...sample, mode}, fixture, {}), []);
      await fixture.execute("unrequested-job", "create_visualization", {windowId: visualizationWindow.id, productPath: sample.choiceProduct?.path ?? visualizationProduct.path});
      assert.match(gradeVisualizationReply(sample, fixture, {}).join(" "), /does not authorize/);
    }
  }
});

test("a genuine pending or newly resumed preview uses the selected window once without another list or confirmation", async () => {
  for (const sample of visualizationCases.filter((item) => item.expected === "preview")) {
    const fixture = createVisualizationFixture(sample);
    await fixture.execute("preview", "create_visualization", {windowId: visualizationWindow.id, productPath: visualizationProduct.path});
    assert.deepEqual(gradeVisualizationReply(sample, fixture, {text: "Your preview is being prepared and should be ready soon."}), []);
    await fixture.execute("duplicate", "create_visualization", {windowId: visualizationWindow.id, productPath: visualizationProduct.path});
    assert.match(gradeVisualizationReply(sample, fixture, {})[0], /exactly one/);
  }
});

test("an explicit additional preview returns a new accepted job rather than the existing completed job", async () => {
  const sample = visualizationCases.find(({name}) => name === "accepted-preview-explicit-additional-request");
  const fixture = createVisualizationFixture(sample);
  const result = await fixture.execute("additional-preview", "create_visualization", {
    windowId: visualizationWindow.id, productPath: visualizationProduct.path,
    targetDescription: visualizationWindow.title,
  });
  assert.ok(sample.jobs.every(({id}) => id !== result.id),
    "reusing the old ID wrongly suggests the requested new job was not accepted");
  assert.equal(result.status, "awaiting_product");
  assert.equal(result.resultAvailable, false);
  assert.equal(result.windowId, visualizationWindow.id);
  assert.equal(result.productPath, visualizationProduct.path);
  assert.deepEqual(gradeVisualizationReply(sample, fixture, {text: "Your new preview is being prepared."}), []);
});

test("tile acceptance/decline remain distinct from neutral photo selection and generation", async () => {
  const offer = visualizationCases.find((sample) => sample.expected === "offer"), offered = createVisualizationFixture(offer);
  assert.deepEqual(gradeVisualizationReply(offer, offered, {questionPresentation: {question: "Use the open blind?", answers: ["This blind", "Something else"]}}), []);
  for (const sample of visualizationCases.filter((item) => ["upload", "save-first"].includes(item.expected))) {
    const fixture = createVisualizationFixture(sample);
    if (sample.expected === "upload") await fixture.execute("select", "navigate", {path: visualizationProduct.path});
    assert.deepEqual(gradeVisualizationReply(sample, fixture, {photoPresentation: {kind: "upload", suggestedTitle: null}}), []);
  }
});

test("explicit PDP photo preparation does not reuse an older selected photo to start a paid preview", async () => {
  const sample = visualizationCases.find((item) => item.expected === "prepare");
  const fixture = createVisualizationFixture(sample);
  assert.ok(fixture.history.at(-1).text.includes(visualizationWindow.id));
  await fixture.execute("prepare", "navigate", {path: visualizationProduct.path});
  assert.deepEqual(gradeVisualizationReply(sample, fixture, {text: "The blind is selected for your photo setup."}), []);
  await fixture.execute("old-photo", "create_visualization", {windowId: visualizationWindow.id, productPath: visualizationProduct.path});
  assert.match(gradeVisualizationReply(sample, fixture, {}).join(" "), /does not authorize/);
});
