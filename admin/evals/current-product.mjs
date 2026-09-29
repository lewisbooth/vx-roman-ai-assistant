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
  { role: "assistant", text: "Hi! I'm Roman. Where would you like to begin?" },
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

export const currentProductCases = [
  {
    name: "current-product-offer",
    currentProductFlow: "offer",
    history: beginning,
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
          activeBlind: null,
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
export function gradeCurrentProductReply(sample, fixture, reply) {
  const failures = [...fixture.violations];
  const check = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  const selected = reply.presentation?.productIds ?? [];
  const question = reply.questionPresentation;
  const answers = question?.answers ?? [];
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
  } else {
    check(
      fixture.operations.length === 0 && selected.length === 0,
      "Declining the current product must continue intake before any catalogue or product action.",
    );
    check(
      /room|space/i.test(question?.question ?? ""),
      "Declining must ask the first missing discovery fact.",
    );
    check(
      !answers.some((answer) =>
        /^(?:this blind|something else)$/i.test(answer),
      ),
      "The declined product was offered again.",
    );
  }
  return failures;
}
