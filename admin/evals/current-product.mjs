// Importable synthetic fixture/grader; the discovery runner owns provider access and bounds.
export const currentProductOrigin = "https://synthetic.example";
export const currentProductPath = "/products/synthetic-woven-ivory-roman";
export const currentProduct = {
  id: "gid://shopify/Product/8200",
  title: "Synthetic Woven Ivory Roman Blind",
  description:
    "An ivory woven Roman blind with standard or blackout lining. A free sample is available.",
  url: currentProductOrigin + currentProductPath,
  priceLabel: "From GBP 35.00",
};
const similarProduct = {
  ...currentProduct,
  id: "gid://shopify/Product/8201",
  title: "Synthetic Woven Ivory Roller Blind",
  description: "A different roller blind with a similar ivory fabric name.",
  url: currentProductOrigin + "/products/synthetic-woven-ivory-roller",
};
const entryQuestion = {
  question:
    "Do you want to start with the blind you're currently looking at, or something else?",
  answers: ["This blind", "Something else"],
};
const beginning = [
  { role: "assistant", text: "Hi! I'm Roman." },
  { role: "user", text: "Help me find blinds that suit my room and style." },
];
const offered = [
  ...beginning,
  {
    role: "user",
    text: `Storefront history: ${JSON.stringify([
      {
        type: "products",
        version: 1,
        invocationId: "7d37b889-06b4-4c78-8b7c-378e210c24b1",
        productIds: [currentProduct.id],
        productRefs: [{ id: currentProduct.id, title: currentProduct.title }],
      },
    ])}`,
  },
  {
    role: "user",
    source: "roman_question",
    text: `Roman question: ${JSON.stringify(entryQuestion)}`,
  },
];

const selectedHistory = [
  { role: "user", text: "I want living-room blinds for daytime privacy, one blind across a standard rectangular window recess. Regular fitting is fine. I'd like light neutral colours." },
  { role: "assistant", text: `You selected ${currentProduct.title}.` },
  { role: "user", source: "roman_question", text: `Roman question: ${JSON.stringify({
    question: "Would you like help measuring, an explanation of this blind's options, or to explore more blinds?",
    answers: ["Help me measure", "Explain blind options", "Explore more blinds"],
  })}` },
];
const alternativeProducts = [
  {
    ...currentProduct,
    id: "gid://shopify/Product/8300",
    title: "Synthetic Cream Privacy Roller Blind",
    url: currentProductOrigin + "/products/synthetic-cream-privacy-roller",
    description: "A light neutral cream roller blind for living-room daytime privacy. Regular screw-fixed brackets fit one blind across a standard rectangular window recess.",
  },
  {
    ...currentProduct,
    id: "gid://shopify/Product/8301",
    title: "Synthetic Ivory Privacy Venetian Blind",
    url: currentProductOrigin + "/products/synthetic-ivory-privacy-venetian",
    description: "Light neutral ivory Venetian slats offer adjustable daytime privacy in a living room. Regular screw-fixed brackets fit one blind across a standard rectangular window recess.",
  },
];
export const currentProductConfiguration = {
  status: "available",
  productPath: currentProductPath,
  configurationId: "10000000-0000-4000-8000-000000000001",
  controls: [
    { id: "c0", label: "Lining", kind: "radio", options: [
      { id: "o0", label: "Light filtering", selected: true, available: true },
      { id: "o1", label: "Blackout lining", priceLabel: "+£12.00", selected: false, available: true },
    ] },
    { id: "c1", label: "Control side", kind: "radio", options: [
      { id: "o0", label: "Left", selected: true, available: true },
      { id: "o1", label: "Right", selected: false, available: true },
    ] },
  ],
  measurements: { width: null, height: null, unit: "mm", availableUnits: ["mm"] },
  configuredPrice: null,
  actions: { sampleAvailable: true },
  message: "Current native choices; dimensions have not been entered.",
};

export const currentProductCases = [
  {
    name: "current-product-offer",
    currentProductFlow: "offer",
    history: [
      beginning[0],
      { role: "user", text: "Help me measure my windows for blinds." },
    ],
  },
  {
    name: "current-product-accept-answer",
    currentProductFlow: "accept",
    history: [...offered, { role: "user", text: "This blind" }],
  },
  {
    name: "current-product-accept-card",
    currentProductFlow: "accept",
    history: [
      ...offered,
      { role: "user", text: `I'd like the ${currentProduct.title}.` },
      {
        role: "user",
        text: `Carousel choice: ${JSON.stringify({ productId: currentProduct.id, title: currentProduct.title, productPath: currentProductPath })}`,
      },
    ],
  },
  {
    name: "current-product-accept-name",
    currentProductFlow: "accept",
    history: [
      ...offered,
      { role: "user", text: `I'd like the ${currentProduct.title}.` },
    ],
  },
  {
    name: "current-product-decline",
    currentProductFlow: "decline",
    history: [...offered, { role: "user", text: "Something else" }],
  },
  ...[
    [
      "current-product-style-start",
      "Help me find blinds that suit my room and style.",
    ],
    [
      "current-product-find-start",
      "Help me find new blinds for my bedroom.",
      true,
    ],
    ["current-product-explore-start", "Explore products"],
    [
      "current-product-no-drill-start",
      "Help me find no-drill blinds for my home.",
    ],
  ].map(([name, text, knownRoom]) => ({
    name,
    currentProductFlow: "discovery",
    knownRoom,
    history: [beginning[0], { role: "user", text }],
  })),
  ...[
    ["selected-product-explore-more", "explore-more", "Explore more blinds"],
    ["selected-product-explain-options", "explain-options", "Explain blind options"],
    ["selected-product-natural-options", "explain-options", "Explore its options"],
  ].map(([name, currentProductFlow, text]) => ({
    name, currentProductFlow, activeProduct: true,
    history: [...selectedHistory, { role: "user", text }],
  })),
];

export function createCurrentProductFixture(sample) {
  const operations = [];
  const violations = [];
  const products = new Map();
  let navigated = false;
  const reject = (reason) => {
    violations.push(reason);
    throw new Error(reason);
  };
  const catalogue = (items) => {
    for (const item of items) products.set(item.id, item);
    return { products: items, messages: [] };
  };
  return {
    operations,
    violations,
    products,
    // The answered question is historical; the current state must not re-open it.
    history: [
      ...sample.history,
      {
        role: "user",
        source: "application_state",
        text: `Application state: ${JSON.stringify({
          activeBlind: sample.activeProduct ? { path: currentProductPath, title: currentProduct.title } : null,
          backgroundPage: {
            path: currentProductPath,
            title: currentProduct.title,
          },
          pendingQuestion: null,
        })}`,
      },
    ],
    async execute(_callId, name, input) {
      const operation = { name, input };
      operations.push(operation);
      if (sample.currentProductFlow === "explore-more" && name === "search_products") {
        operation.result = {
          ...catalogue(alternativeProducts),
          queries: input.queries.map((query) => ({ query, status: "succeeded", productIds: alternativeProducts.map(({ id }) => id) })),
        };
        return operation.result;
      }
      if (sample.currentProductFlow === "explain-options" && name === "get_product_configuration") {
        if (input.productPath !== currentProductPath)
          reject("Options must belong to the active selected blind.");
        operation.result = currentProductConfiguration;
        return operation.result;
      }
      if (sample.currentProductFlow === "offer" && name === "search_products") {
        if (input.queries?.length !== 1)
          reject(
            "The background product needs one exact catalogue lookup, not family discovery.",
          );
        operation.result = {
          ...catalogue([similarProduct, currentProduct]),
          queries: input.queries.map((query) => ({
            query,
            status: "succeeded",
            productIds: [similarProduct.id, currentProduct.id],
          })),
        };
        return operation.result;
      }
      if (sample.currentProductFlow === "accept") {
        if (name === "navigate") {
          if (input.path !== currentProductPath || navigated)
            reject(
              "Activate the exact offered product once, even when its background page is already loaded.",
            );
          navigated = true;
          operation.result = {
            status: "navigated",
            path: currentProductPath,
            title: currentProduct.title,
            actions: { sampleAvailable: true },
          };
          return operation.result;
        }
        if (name === "get_product" || name === "lookup_catalog") {
          const ids = name === "get_product" ? [input.id] : input.ids;
          if (ids?.length !== 1 || ids[0] !== currentProduct.id)
            reject(
              "A selected-product refresh may only read its known exact ID.",
            );
          operation.result = catalogue([currentProduct]);
          return operation.result;
        }
      }
      reject(
        `Synthetic ${sample.currentProductFlow} forbids ${name}; no alternative search, guides, configuration or cart work is authorized.`,
      );
    },
  };
}

/** Semantic checks complement saved-output review; no exact generated question is required. */
export function gradeCurrentProductReply(
  sample,
  fixture,
  reply,
  mode = "text",
) {
  const failures = [...fixture.violations];
  const check = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  const selected = reply.presentation?.productIds ?? [];
  const question = reply.questionPresentation;
  const answers = question?.answers ?? [];
  // Voice briefings append the displayed question; it is not a separate message.
  const message =
    mode === "voice" && question && reply.text.endsWith(question.question)
      ? reply.text.slice(0, -question.question.length).trim()
      : reply.text;
  const navigations = fixture.operations.filter(
    ({ name }) => name === "navigate",
  );
  check(
    !!question && !question.measurement,
    "Expected one ordinary choice question.",
  );
  if (sample.currentProductFlow === "offer") {
    check(
      selected.length === 1 && selected[0] === currentProduct.id,
      "The entry choice must show exactly the background product, not its similar catalogue neighbour.",
    );
    check(
      JSON.stringify(answers) === JSON.stringify(entryQuestion.answers),
      "The entry choice needs both This blind and Something else.",
    );
    check(
      fixture.operations.length === 1 &&
        fixture.operations[0].name === "search_products",
      "Offer the current product after one lookup without selecting it or starting another workflow.",
    );
  } else if (sample.currentProductFlow === "accept") {
    check(
      navigations.length === 1 &&
        navigations[0].result?.path === currentProductPath,
      "Acceptance did not establish the exact active product through navigation.",
    );
    check(
      fixture.operations.length <= 2 &&
        fixture.operations.every(({ name }) =>
          ["navigate", "get_product", "lookup_catalog"].includes(name),
        ),
      "Selection performed unnecessary or unrelated storefront work.",
    );
    check(
      selected.length === 0,
      "Selection must not redisplay or replace the recommendation carousel.",
    );
    check(
      answers.some((answer) => /measur/i.test(answer)) &&
        answers.some((answer) => /sample|configur|option/i.test(answer)),
      "Selection did not continue with useful actions for the chosen product.",
    );
    check(
      /measur/i.test(question?.question ?? "") &&
        /configur|option/i.test(question?.question ?? ""),
      "The spoken/displayed question must include measuring and options, not only a generic next step.",
    );
    check(
      !/sample/i.test(message ?? ""),
      "Available samples belong with the other next actions, not a separate sample announcement.",
    );
    check(
      !/which room|what room|opening|priorit|colou?r|pattern|type of (?:blind|window)/i.test(
        question?.question ?? "",
      ) &&
        !answers.some((answer) =>
          /^(?:this blind|something else|yes[, ]+change blind|no[, ]+keep this blind)$/i.test(
            answer,
          ),
        ),
      "Acceptance restarted discovery or asked for another product confirmation.",
    );
  } else if (sample.currentProductFlow === "explore-more") {
    const searches = fixture.operations.filter(({ name }) => name === "search_products");
    check(fixture.operations.length === 1 && searches.length === 1,
      "Explore more blinds must research other products without configuring or replacing the selected blind.");
    const queries = searches.flatMap(({ input }) => input.queries ?? []);
    check(queries.length >= 1 && queries.length <= 3 && queries.every((query) =>
      /privacy/i.test(query) && /recess|whole opening|window/i.test(query) && /neutral|cream|ivory|light colou?r/i.test(query)),
    "Wider discovery lost the retained opening, privacy or light neutral appearance requirements.");
    check(selected.length > 0 && selected.every((id) => alternativeProducts.some((product) => product.id === id)),
      "Wider discovery must show verified alternative products.");
    check(!/which room|what room|which opening|what opening/i.test(question?.question ?? ""),
      "Wider discovery restarted settled intake.");
  } else if (sample.currentProductFlow === "explain-options") {
    check(fixture.operations.length === 1 && fixture.operations[0].name === "get_product_configuration" &&
      fixture.operations[0].input.productPath === currentProductPath,
    "Explain blind options must read the selected product's choices without discovery, navigation or mutations.");
    check(selected.length === 0 && !question?.measurement,
      "Explaining options must not show other products or require measurements first.");
    check(/lining|blackout|light.filter|control side|left|right/i.test([message, question?.question, ...answers].join(" ")),
      "The response did not explain or offer a verified configuration choice beyond measurements.");
  } else {
    check(
      fixture.operations.length === 0 && selected.length === 0,
      "Discovery must continue missing context without any background-product lookup, offer or selection.",
    );
    check(
      (sample.currentProductFlow === "discovery"
        ? /room|space|window|opening|door|priorit|matter|light|privacy|blackout|fitting|drill|colou?r|pattern|look/i
        : /room|space/i
      ).test(question?.question ?? "") &&
        (!sample.knownRoom ||
          !/which room|what room|which space|what space/i.test(
            question?.question ?? "",
          )),
      "Discovery must ask a missing relevant fact.",
    );
    check(
      !answers.some((answer) =>
        (sample.currentProductFlow === "discovery"
          ? /^this blind$/i
          : /^(?:this blind|something else)$/i
        ).test(answer),
      ),
      "The background product was offered again instead of continuing discovery.",
    );
    if (sample.currentProductFlow === "discovery") {
      check(
        !/synthetic woven ivory roman|\b(?:this|that|current|background|open)\s+(?:blind|product|page)\b/i.test(
          [message, question?.question, ...answers].join(" "),
        ),
        "A style/find/explore start should ignore the background page in its reply.",
      );
    }
  }
  return failures;
}
