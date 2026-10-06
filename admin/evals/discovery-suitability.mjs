// Importable synthetic fixtures and grader; discovery.mjs owns provider access and bounds.
const origin = "https://synthetic.example";
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
const noDrill = /no[- ]drill|without drill|drill[- ]free/i;
const pleatedFamily = /pleat|cellular|honeycomb|duette/i;
export const suitabilityCases = [
  {
    name: "pleated-category-refinement",
    history: pleatedHistory,
    fixtureProducts: suitabilityCatalog,
    eligibleIds: ["gid://shopify/Product/7100", "gid://shopify/Product/7101"],
    queryFamily: pleatedFamily,
    wrongOpening: /bifold|bi-fold|roof|skylight/i,
  },
  {
    name: "pleated-no-eligible",
    history: pleatedHistory,
    fixtureProducts: suitabilityCatalog.filter((product) =>
      [7102, 7103, 7104, 7106].some((id) => product.id.endsWith("/" + id)),
    ),
    eligibleIds: [],
    queryFamily: pleatedFamily,
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
    queryFamily: pleatedFamily,
    wrongOpening: /recess|roof|skylight/i,
  },
];

// Neither eligible cellular title nor description contains the literal word "pleated".
// The construction and fitting evidence, rather than title matching, establish suitability.
const nurseryCatalog = [
  catalogProduct(
    7200,
    "Synthetic Sand Tension Roller Blind",
    "Blackout roller fabric for a nursery, fitted across a standard rectangular window recess using included no-drill tension fittings. It mounts between the recess walls, independently of window-frame material, with no glazing clips. Available in neutral and colourful plain fabrics.",
  ),
  catalogProduct(
    7201,
    "Synthetic Cloud Cellular Blind",
    "A blackout cellular blind with folded honeycomb fabric for a nursery. Included no-drill tension fittings mount across a standard rectangular window recess between its walls, independently of window-frame material. No glazing beads or clips are needed. Available in cream, grey and blue.",
  ),
  catalogProduct(
    7202,
    "Synthetic Meadow Honeycomb Blind",
    "Blackout honeycomb fabric with folded cellular construction, suitable for a nursery. A no-drill tension rail fits between the walls of a standard rectangular window recess independently of the window-frame material, without glazing clips. Available in green and warm neutral shades.",
  ),
  catalogProduct(
    7203,
    "Synthetic Screw-Fit Blackout Pleated Blind",
    "Blackout pleated fabric for a standard rectangular nursery window recess. Installation requires drilling and screw-fixed brackets; no no-drill option exists.",
  ),
  catalogProduct(
    7204,
    "Synthetic Roof Blackout Honeycomb Blind",
    "Blackout honeycomb fabric with no-drill fittings exclusively for matching roof-window model codes. Cannot fit standard rectangular window recesses or glazed door panels.",
  ),
  catalogProduct(
    7205,
    "Synthetic Glass-Fit Blackout Cellular Blind",
    "Blackout cellular blind that clips directly to the glass of a standard uPVC window using rubber glazing beads, with no drilling. Requires a uPVC frame with compatible rubber beading. Not suitable for wooden frames, wall-to-wall recess tension fitting or bifold doors.",
  ),
  catalogProduct(
    7206,
    "Synthetic Daylight Tension Honeycomb Blind",
    "Light-filtering honeycomb fabric with no-drill tension fittings across standard rectangular window recesses, independently of frame material. Not blackout; no blackout fabric or lining option is available.",
  ),
  catalogProduct(
    7207,
    "Synthetic Unspecified-Fit Blackout Cellular Blind",
    "Blackout cellular fabric for standard rectangular nursery windows. The catalog does not specify the mounting method or whether a no-drill fitting is available.",
  ),
  catalogProduct(
    7208,
    "Synthetic BiFold Blackout Pleated Blind",
    "No-drill blackout pleated blind for individual uPVC bifold glazed door panels with rubber beading only. Not compatible with ordinary windows, wooden frames or recess tension mounting.",
  ),
];
const nurseryHistory = [
  {
    role: "user",
    text: "I need blinds for a nursery, for blackout. It is a standard rectangular recessed window and I want one blind across the recess without drilling. I'm open to colours, patterns and different types of blind.",
  },
];
const recessCases = {
  fixtureProducts: nurseryCatalog,
  eligibleIds: [7200, 7201, 7202].map((id) => "gid://shopify/Product/" + id),
  productFamilies: {
    "gid://shopify/Product/7200": "roller",
    "gid://shopify/Product/7201": "cellular",
    "gid://shopify/Product/7202": "cellular",
  },
  wrongOpening: /bifold|bi-fold|roof|skylight/i,
  minQueries: 2,
  maxQueries: 3,
  minFamilies: 2,
  categoryQuestion: true,
  irrelevantFrameQuestion: true,
};
suitabilityCases.push(
  {
    ...recessCases,
    name: "nursery-ready-for-cards",
    history: nurseryHistory,
  },
  {
    ...recessCases,
    name: "pleated-cellular-refinement",
    history: [
      ...nurseryHistory,
      {
        role: "assistant",
        text: "Here are no-drill blackout roller and cellular blinds for your nursery recess. Which blind style would you like to explore?",
      },
      { role: "user", text: "Pleated blind" },
    ],
    eligibleIds: ["gid://shopify/Product/7201", "gid://shopify/Product/7202"],
    queryFamily: pleatedFamily,
    minQueries: 1,
    maxQueries: 1,
    minFamilies: 1,
    minCards: 2,
    categoryQuestion: false,
    verifiedFamilySynonyms: true,
  },
  {
    ...recessCases,
    name: "wood-frame-recess",
    history: [
      ...nurseryHistory,
      {
        role: "user",
        text: "The window frame is wood, but the blind should tension-fit between the walls of the recess, not clip to the frame or glass. I haven't chosen a blind family.",
      },
    ],
  },
  {
    name: "wood-frame-glass-fit",
    history: [
      {
        role: "user",
        text: "I want a blackout pleated blind for my nursery's standard rectangular wooden-framed window. It must clip directly to the glazed panel without drilling, not span the wall recess on a tension rail. The frame is wood, not uPVC. I'm open to any colour. Please show matching options.",
      },
    ],
    fixtureProducts: nurseryCatalog,
    eligibleIds: [],
    queryFamily: pleatedFamily,
    wrongOpening: /bifold|bi-fold|roof|skylight|recess|tension/i,
  },
  {
    ...recessCases,
    name: "no-drill-family-choice",
    history: [
      {
        role: "user",
        text: "Help me find no-drill blinds for my kitchen. Standard rectangular recessed window, light neutrals; no-drill fitting is the main requirement. I haven't decided what type of blind.",
      },
      {
        role: "assistant",
        text: "Would you prefer plain fabrics or patterns?",
      },
      { role: "user", text: "Plain fabrics, please." },
    ],
    eligibleIds: [...recessCases.eligibleIds, "gid://shopify/Product/7206"],
    productFamilies: {
      ...recessCases.productFamilies,
      "gid://shopify/Product/7206": "cellular",
    },
  },
);

const paneCatalog = [
  catalogProduct(
    7300,
    "Synthetic Glass Rail Privacy Roller Blind",
    "A light-filtering roller blind for office privacy, designed as a separate blind on each window glass pane. Included adhesive rails mount directly to the glass without drilling. The fitting does not depend on frame material or glazing beads; it does not span the whole window recess.",
  ),
  catalogProduct(
    7301,
    "Synthetic Pane Privacy Cellular Blind",
    "A cellular honeycomb blind for office privacy and filtered daylight. Each blind mounts directly to an individual window glass pane with included adhesive rails, without drilling or frame/bead compatibility requirements. It is not a whole-opening recess blind.",
  ),
  catalogProduct(
    7302,
    "Synthetic Cotton White Privacy Roller Blind",
    "A light-filtering roller blind for office privacy, mounted across the whole window opening with standard screw-fixed recess brackets. No individual-pane, glass or frame fitting is offered.",
  ),
  catalogProduct(
    7303,
    "Synthetic Grey Privacy Venetian Blind",
    "An adjustable aluminium Venetian blind for office privacy, installed with standard screw-fixed wall or recess brackets across the whole opening. Not designed to attach separately to window panes or their frames.",
  ),
  catalogProduct(
    7304,
    "Synthetic Soft Privacy Roller Blind",
    "A roller blind with soft filtered light and office privacy. The catalog does not identify its mounting method or support for separate blinds on individual panes.",
  ),
  catalogProduct(
    7305,
    "Synthetic Clip Privacy Cellular Blind",
    "A privacy cellular blind for individual window panes with no-drill clips. Requires uPVC frames with compatible rubber glazing beads; it cannot use glass adhesive rails or recess brackets.",
  ),
];
const paneHistory = [
  { role: "user", text: "Help me find blinds that suit my room and style." },
  { role: "assistant", text: "Which room are they for?" },
  { role: "user", text: "Office" },
  { role: "assistant", text: "What kind of opening are you covering?" },
  { role: "user", text: "Several panes" },
  { role: "assistant", text: "How would you like the panes covered?" },
  { role: "user", text: "Separate blinds on each pane" },
  { role: "assistant", text: "What matters most for this room?" },
  { role: "user", text: "Privacy" },
  { role: "assistant", text: "Does avoiding drilling matter to you?" },
  { role: "user", text: "Not sure" },
  { role: "assistant", text: "What colours or patterns appeal to you?" },
  { role: "user", text: "Open to ideas" },
];
const paneCase = {
  history: paneHistory,
  fixtureProducts: paneCatalog,
  eligibleIds: [7300, 7301].map((id) => "gid://shopify/Product/" + id),
  wrongOpening: /(?:whole|full)[ -]opening|recess/i,
  minQueries: 1,
  maxQueries: 3,
  answeredFittingPreference: true,
};
suitabilityCases.push(
  { ...paneCase, name: "individual-panes-uncertain-drilling" },
  {
    ...paneCase,
    name: "individual-panes-roller-refinement",
    history: [
      ...paneHistory,
      { role: "assistant", text: "Here are roller and cellular blinds with fittings for individual glass panes. Which style would you like to explore?" },
      { role: "user", text: "Roller blinds" },
    ],
    eligibleIds: ["gid://shopify/Product/7300"],
    queryFamily: /roller/i,
    maxQueries: 1,
  },
  {
    ...paneCase,
    name: "individual-panes-unknown-frame-compatibility",
    fixtureProducts: paneCatalog.filter(({ id }) => !paneCase.eligibleIds.includes(id)),
    eligibleIds: [],
    compatibilityUnresolved: true,
  },
  {
    ...paneCase,
    name: "individual-panes-frame-answer-retains-uncertainty",
    history: [
      ...paneHistory,
      { role: "assistant", text: "For clip-mounted pane blinds, are the frames uPVC with compatible rubber glazing beads?" },
      { role: "user", text: "Yes, uPVC with rubber glazing beads." },
    ],
    eligibleIds: [...paneCase.eligibleIds, "gid://shopify/Product/7305"],
  },
  {
    name: "blackout-brand-does-not-prove-no-drill-hardware",
    history: [{ role: "user", text: "Show me pleated no-drill blackout blinds for one standard recess. Any colour is fine." }],
    fixtureProducts: [
      catalogProduct(7400, "Synthetic Click2Shade Cloud Cellular Blind", "Cellular pleated blackout fabric. Included no-drill tension rails mount between the sides of a standard rectangular recess."),
      catalogProduct(7401, "Synthetic TotalShade Complete Blackout Pistachio Blind", "Blackout pleated fabric with complete light blocking. Installation uses screw-fixed recess brackets; no no-drill option is offered."),
      catalogProduct(7402, "Synthetic TotalShade Pearl Pleated Blind", "Pleated blackout fabric for a standard rectangular window. The listing does not identify its fitting mechanism."),
    ],
    eligibleIds: ["gid://shopify/Product/7400"],
    queryFamily: pleatedFamily,
    wrongOpening: /bifold|bi-fold|roof|skylight/i,
    minQueries: 1,
    maxQueries: 1,
  },
);

/** Judge behavior and evidence, without requiring any exact generated sentence. */
export function gradeSuitabilityReply(sample, fixture, reply, mode = "text") {
  const failures = [];
  const check = (passed, reason) => {
    if (!passed) failures.push(reason);
  };
  const selected = reply.presentation?.productIds ?? [];
  const question = reply.questionPresentation;
  const message =
    mode === "voice" && question && reply.text.endsWith(question.question)
      ? reply.text.slice(0, -question.question.length).trim()
      : reply.text;
  const queries = fixture.operations
    .filter((operation) => operation.name === "search_products")
    .flatMap((operation) => operation.queries);
  const focusedCompatibility = sample.compatibilityUnresolved &&
    selected.length === 0 && !!question && !question.measurement &&
    /frame|glaz|bead|uPVC/i.test([question.question, ...(question.answers ?? [])].join(" "));
  const compatibilityBeforeSearch = focusedCompatibility && fixture.operations.length === 0;
  check(fixture.attempts === (compatibilityBeforeSearch ? 1 : 2), "Discovery must use two completions, or one for a necessary compatibility question before searching");
  check(
    compatibilityBeforeSearch ||
      (fixture.operations.length === 1 && fixture.operations[0].name === "search_products"),
    "Discovery must use one catalogue operation without guides or navigation",
  );
  check(
    compatibilityBeforeSearch ||
      (queries.length >= (sample.minQueries ?? 1) && queries.length <= (sample.maxQueries ?? 1)),
    "Query count did not match broad discovery or the chosen family",
  );
  // Retrieval terms need not restate every hard requirement. Eligibility below
  // is evaluated against independently reviewed per-product evidence instead.
  check(
    !sample.queryFamily || queries.every((query) => sample.queryFamily.test(query)),
    "Query abandoned the chosen construction family",
  );
  check(
    queries.every(
      (query) => !sample.wrongOpening?.test(query),
    ),
    "Query contradicted the current opening or mounting method",
  );
  check(
    selected.every((id) => sample.eligibleIds.includes(id)),
    "Cards included an ineligible or unverified product",
  );
  check(
    sample.eligibleIds.length
      ? selected.length >= (sample.minCards ?? 1) && selected.length <= 10
      : selected.length === 0,
    "Incorrect card presence for eligible results",
  );
  check(
    !!question && !question.measurement,
    "Missing ordinary follow-up question",
  );
  if (sample.answeredFittingPreference) {
    const wording = question?.question ?? "";
    const answers = question?.answers ?? [];
    const repeatsPreference =
      /drill|make holes|regular fitting/i.test(wording) &&
      /prefer|avoid|matter|important|mind|comfortable|happy|okay|\bok\b|want/i.test(wording);
    const repeatsAlternatives =
      answers.some((answer) => noDrill.test(answer)) &&
      answers.some((answer) => /regular|drill(?:ing)? (?:is )?(?:fine|okay|ok)|don.t mind/i.test(answer));
    check(
      !repeatsPreference && !repeatsAlternatives,
      "An answered uncertain fitting preference was asked again",
    );
  }
  if (sample.minFamilies) {
    const families = new Set(
      selected.map((id) => sample.productFamilies[id]).filter(Boolean),
    );
    check(
      families.size >= sample.minFamilies,
      "Cards did not cover the eligible construction families",
    );
    if (sample.minFamilies > 1) {
      check(
        queries.filter((query) => pleatedFamily.test(query)).length <= 1,
        "Broad discovery spent separate queries on overlapping pleated/cellular/honeycomb family labels",
      );
    }
  }
  if (sample.categoryQuestion) {
    check(
      /style|type|famil|explore|direction|prefer|appeal|like/i.test(
        question?.question ?? "",
      ) &&
        question?.answers.some((answer) => /roller/i.test(answer)) &&
        question?.answers.some((answer) => pleatedFamily.test(answer)),
      "Varied cards need a category exploration question in the same response",
    );
  }
  if (sample.irrelevantFrameQuestion) {
    check(
      !/frame|uPVC|PVC|glaz|bead|glass|timber|wood/i.test(
        [question?.question, ...(question?.answers ?? [])].join(" "),
      ),
      "Recess tension fitting triggered an irrelevant frame or glazing question",
    );
  }
  if (sample.categoryQuestion || sample.verifiedFamilySynonyms) {
    const familyOnlyAnswers = (question?.answers ?? []).filter((answer) =>
      /^(?:(?:explore|see|try|show me)\s+)?(?:pleated|cellular|honeycomb|duette)(?:\s+(?:blinds?|shades?|styles?|options?))?$/i.test(
        answer.trim(),
      ),
    );
    check(
      familyOnlyAnswers.length <= 1,
      "The question split overlapping pleated/cellular/honeycomb labels into separate category choices",
    );
  }
  if (sample.eligibleIds.length) {
    check(
      !/screw[- ]?(?:fit|fix|mount)|drilled|(?:accept|allow|consider|try|explore|switch to|use)\s+(?:\w+\s+){0,3}drill(?:ing)?\b/i.test(
        [question?.question, ...(question?.answers ?? [])].join(" "),
      ),
      "Matching no-drill products prompted an unnecessary relaxation of the fitting requirement",
    );
  }
  if (sample.verifiedFamilySynonyms) {
    const response = [
      message,
      question?.question,
      ...(question?.answers ?? []),
    ].join(" ");
    // Approximation words alone do not imply a changed goal; require an explicit
    // denial of the chosen family or a proposed category switch despite matches.
    const deniedFamily =
      /\bno\s+(?:matching\s+)?pleated\s+(?:blinds?|options?|products?)\b|\b(?:could(?:n['’]t| not)|can(?:not|['’]t)|haven['’]t|have not|did(?:n['’]t| not))\s+(?:find|found|offer)\b[^.!?;]{0,80}\bpleated\b/i.test(
        response,
      );
    const categorySwitch =
      /\b(?:switch|change|swap|move)\s+(?:\w+\s+){0,4}(?:cellular|honeycomb|duette)\b|\b(?:try|explore|choose|accept)\s+(?:\w+\s+){0,3}(?:cellular|honeycomb|duette)\s+(?:blinds?\s+)?instead\b/i.test(
        response,
      );
    check(
      !deniedFamily && !categorySwitch,
      "Verified family synonyms were denied as matches or required an unnecessary category switch",
    );
  }
  if (sample.compatibilityUnresolved) {
    check(focusedCompatibility, "Unknown pane-fit compatibility needs a focused physical-fit question without unverified cards");
  } else if (!sample.eligibleIds.length) {
    check(
      /no |not |cannot|can.t|couldn.t|haven.t found|none|unable/i.test(
        message ?? "",
      ),
      "Missing clear explanation that no result meets the request",
    );
    check(
      question?.answers.length >= 2 &&
        /other|different|no[- ]drill|style|pattern|texture|fit|broaden|roller|pleat|recess|tension/i.test(
          question.answers.join(" "),
        ),
      "No useful alternatives after unsuitable results",
    );
  }
  return failures;
}
