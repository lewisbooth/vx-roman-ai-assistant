// Importable synthetic histories/grader. No provider access, files or image jobs.
export const visualizationProduct = {path: "/products/synthetic-navy-roller", title: "Synthetic Navy Roller Blind"};
export const visualizationWindow = {id: "8c47ba09-17ea-45e0-9a80-21d0d8fed9a2", title: "Study window", revision: 1, cleanup: true, width: 1024, height: 768, createdAt: "2026-10-06T12:00:00Z"};
const text = (role, value) => ({role, text: value});
const originalPreview = [text("user", "Show this blind in my Study window."), text("assistant", "Your preview is ready.")];
const paused = [...originalPreview, text("user", "Just explain fitting now; no new preview."), text("assistant", "I will explain fitting and keep the preview paused.")];
const namedPicker = text("user", `Roman question: ${JSON.stringify({question: "Which saved window?", answers: [visualizationWindow.title]})}`);
const misleadingPicker = text("user", `Storefront history: ${JSON.stringify([{type: "media", version: 1, kind: "windows", windowIds: [visualizationWindow.id], purpose: "preview"}])}`);
const alternateProduct = {path: "/products/synthetic-linen-roller", title: "Synthetic Linen Roller Blind"};
const acceptedJob = (status) => ({id: "e9b59a4b-a760-4189-8c86-79e02b9ce48a", windowId: visualizationWindow.id, windowTitle: visualizationWindow.title, productPath: visualizationProduct.path, productTitle: visualizationProduct.title, status});
const acceptedPreview = (status) => [
  text("user", "Help me choose a blind for Study window, then visualize it."),
  text("user", `Application media outcome: visualization request already accepted (not a new request): ${JSON.stringify({type: "media", version: 1, kind: "visualization", jobId: acceptedJob(status).id, customerIntent: true})}`),
  text("assistant", "Your preview request is accepted and should be ready soon."),
];
export const visualizationCases = [
  {name: "paused-preview-named-photo-answer", expected: "neutral", requestedViews: ["gallery"], history: [...paused, text("user", "Show my saved windows."), misleadingPicker, namedPicker, text("user", visualizationWindow.title)]},
  {name: "paused-preview-photo-card", expected: "neutral", history: [...paused, misleadingPicker, text("user", `Select “${visualizationWindow.title}” as my saved window photo. This selection alone is not a request for a new preview.`)]},
  {name: "neutral-photo-list", expected: "neutral", requestedViews: ["gallery"], history: [...originalPreview, text("user", "Show my saved windows, without making another image.")]},
  {name: "neutral-photo-rename", expected: "rename", history: [...paused, text("user", "Rename Study window to Reading corner.")]},
  {name: "pending-preview-missing-photo-resolved", expected: "preview", history: [text("user", "Show this blind in my room."), text("assistant", "Which saved window should I use?"), namedPicker, text("user", visualizationWindow.title)]},
  {name: "newer-pause-overrides-old-preview-purpose", expected: "neutral", history: [text("user", "Show this blind in my room."), misleadingPicker, text("user", "Pause the preview. Select Study window and explain the lining first.")]},
  {name: "explicit-preview-resumes-after-pause", expected: "preview", history: [...paused, text("user", "Now make a new preview of this blind in Study window.")]},
  ...["generating", "completed"].map((status) => ({name: `accepted-${status}-preview-product-switch`, expected: "select", choiceProduct: alternateProduct, jobs: [acceptedJob(status)], history: [...acceptedPreview(status), text("user", `I'd like the ${alternateProduct.title}.`)]})),
  {name: "accepted-preview-neutral-photo-answer", expected: "neutral", jobs: [acceptedJob("generating")], history: [...acceptedPreview("generating"), text("user", "Show my saved windows."), misleadingPicker, text("user", visualizationWindow.title)]},
  {name: "accepted-preview-explicit-additional-request", expected: "preview", jobs: [acceptedJob("completed")], history: [...acceptedPreview("completed"), text("user", "Create one new preview of this selected blind in Study window.")]},
  {name: "explicit-pdp-preparation-with-old-selected-photo", expected: "prepare", active: false, history: [...originalPreview, text("user", `Please select the ${visualizationProduct.title} I'm currently viewing for photo setup only. Do not create a preview yet; I'll submit the upload form when ready.`)]},
  {name: "visualization-tile-open-product-offer", expected: "offer", active: false, history: [text("user", "I'd like to visualize blinds in my room.")]},
  {name: "visualization-tile-this-blind", expected: "upload", active: false, history: [text("user", "I'd like to visualize blinds in my room."), text("assistant", `Use the ${visualizationProduct.title} you're viewing, or something else?`), text("user", 'Roman question: {"question":"Use this blind or something else?","answers":["This blind","Something else"]}'), text("user", "This blind")]},
  {name: "visualization-tile-something-else", expected: "save-first", active: false, history: [text("user", "I'd like to visualize blinds in my room."), text("assistant", `Use the ${visualizationProduct.title} you're viewing, or something else?`), text("user", "Something else")]},
];

export function createVisualizationFixture(sample) {
  const calls = [], violations = [];
  const knownPhoto = !["offer", "upload", "save-first"].includes(sample.expected);
  let activeProduct = visualizationProduct;
  return {
    calls, violations,
    history: [...sample.history, text("user", `Application state: ${JSON.stringify({activeBlind: sample.active === false ? null : visualizationProduct, backgroundPage: visualizationProduct, gallery: {enabled: true, ...(sample.jobs ? {recentVisualizations: sample.jobs} : {})}, selectedWindow: knownPhoto ? visualizationWindow : null})}`)],
    async execute(callId, name, args) {
      calls.push({callId, name, args});
      if (name === "list_windows") return {windows: [visualizationWindow], total: 1, nextCursor: null};
      if (name === "show_view" && sample.requestedViews?.includes(args.view))
        return {status: "shown", view: args.view};
      if (name === "rename_window") {
        if (args.windowId !== visualizationWindow.id) violations.push("Renaming must use the owned selected window.");
        if (args.revision !== visualizationWindow.revision) violations.push("Renaming must preserve the revision from verified image metadata.");
        return {...visualizationWindow, title: args.title, revision: 2};
      }
      if (name === "create_visualization") {
        if (args.windowId !== visualizationWindow.id || args.productPath !== activeProduct.path) violations.push("Preview identity must match the chosen photo and active product.");
        return {id: "f3012cd6-98b6-456d-8f0a-862deeb36fb7", windowId: visualizationWindow.id, windowTitle: visualizationWindow.title, productPath: activeProduct.path, productTitle: activeProduct.title, status: "awaiting_product", resultAvailable: false};
      }
      if (name === "navigate" && ["prepare", "upload", "select"].includes(sample.expected)) {
        const chosen = sample.choiceProduct ?? visualizationProduct;
        if (args.path !== chosen.path) violations.push("Select the customer's exact requested product.");
        activeProduct = chosen;
        return {status: "navigated", ...chosen, actions: {sampleAvailable: true}};
      }
      violations.push(`Unexpected ${name}; these histories need no guides, dimensions, option changes or cart writes.`);
      return {error: "Unexpected synthetic operation"};
    },
  };
}

/** Grade goals and tool effects, not exact generated wording. Review saved replies too. */
export function gradeVisualizationReply(sample, fixture, reply) {
  const failures = [...fixture.violations];
  const count = (name) => fixture.calls.filter((call) => call.name === name).length;
  if (count("show_view") > 1) failures.push("A requested Gallery view should not be opened repeatedly in the same reply.");
  if (sample.expected === "preview") {
    if (count("create_visualization") !== 1) failures.push("A genuine unpaused preview should dispatch exactly one job without another approval.");
    if (count("list_windows")) failures.push("The authoritative selected window is already known; no list is needed just to reverify its ID.");
  } else if (count("create_visualization")) failures.push("Neutral selection, naming, paused intent or product entry does not authorize a paid job.");
  if (sample.expected === "rename" && count("rename_window") !== 1) failures.push("Apply the explicit rename once.");
  if (sample.expected === "prepare" && count("navigate") !== 1) failures.push("Prepare the requested exact product once, while generation waits for the upload form submission.");
  if (sample.expected === "select" && count("navigate") !== 1) failures.push("A product switch selects the new blind once without repeating the accepted preview request.");
  if (sample.expected === "offer") {
    const answers = reply.questionPresentation?.answers ?? [];
    if (!answers.includes("This blind") || !answers.includes("Something else")) failures.push("Offer the verified open product with both This blind and Something else.");
    if (count("navigate")) failures.push("An offer is not product acceptance.");
  }
  if (["upload", "save-first"].includes(sample.expected)) {
    if (reply.photoPresentation?.kind !== "upload") failures.push("Offer the existing upload/save interface immediately.");
    if (reply.questionPresentation?.answers?.includes("This blind")) failures.push("Do not repeat the accepted/declined background-product choice.");
    if (sample.expected === "upload" && count("navigate") !== 1) failures.push("Activate the accepted exact product once before uploading.");
    if (sample.expected === "save-first" && count("navigate")) failures.push("Declining the background blind must not select it.");
  }
  return failures;
}
