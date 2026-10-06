import type { ConversationMessage, ConversationSnapshot } from "./conversation";
import { MAX_PRODUCT_CARDS } from "./conversation";
import type { ProductChoice } from "./product-choice";
import { parseProductPath, productPathSchema } from "./product-path";

export interface MeasurementQuestion {
  productPath: string;
  label: string;
  /** Display hint established by the customer; null until units are known. */
  unit: "cm" | "mm" | "in" | null;
  instructions: string;
}

export interface QuestionAnswerReference {
  questionId: string;
  voiceId: string;
}

export interface VoiceAnswerInput extends QuestionAnswerReference {
  clientId: string;
  requestId: string;
  answer: string;
}

export interface VoiceInputReference {
  voiceId: string;
}

export interface VoiceTextInput {
  clientId: string;
  requestId: string;
  text: string;
}

export type VoiceSelectionInput =
  | Omit<VoiceAnswerInput, "voiceId">
  | ({ clientId: string; requestId: string } & ProductChoice)
  | VoiceTextInput;

export interface QuestionSelection {
  question: string;
  answers: string[];
  /** Free-text measurement input instead of suggested answers. */
  measurement?: MeasurementQuestion;
  /** Direct UI navigation; it never answers or retires the pending question. */
  navigationActions?: { label: "View Cart"; view: "cart" }[];
}

/** Complete model reply; message is context, never a second question. */
export interface QuestionCall extends QuestionSelection {
  message: string;
  /** Ordered current-turn catalogue selections; empty when no cards are needed. */
  productIds: string[];
}

export interface QuestionPart extends QuestionSelection {
  type: "question";
  version: 1;
  invocationId: string;
  /** Display association only; it does not assert that the shopper heard it. */
  voiceReply?: { voiceId: string; afterSequence: number };
}

const productIdPattern = /^gid:\/\/shopify\/Product\/\d+$/;
const terminalProductsSchema = {
  type: "array",
  items: { type: "string", pattern: productIdPattern.source, maxLength: 100 },
  minItems: 0,
  maxItems: MAX_PRODUCT_CARDS,
  description:
    "Ordered distinct product IDs from successful catalog results in this reply; empty when no carousel is needed.",
} as const;

const navigationActionsSchema = {
  type: "array", minItems: 0, maxItems: 1,
  items: { type: "object", properties: {
    label: { type: "string", enum: ["View Cart"] },
    view: { type: "string", enum: ["cart"] },
  }, required: ["label", "view"], additionalProperties: false },
  description: "Optional View Cart shortcut alongside the real pending decision or measurement. Opens Cart without an answer or advisor turn; empty when not useful.",
} as const;

export const askQuestionToolDefinition = {
  type: "function",
  name: "ask_question",
  description:
    "Finish this reply atomically with a message, zero to ten verified product cards, one question and one to four clickable answers. Complete necessary tool work first, then call this alone; there is no prose response afterward. Put the question only in question. Questions and answers are plain text; message may use Markdown. Product IDs must come from successful catalog results in this reply. Returned choices request customer input and do not execute actions or grant consent. Optional navigationActions opens Cart directly without answering this question.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        maxLength: 2000,
        description:
          "Necessary context or confirmed outcome only; empty for a simple question. Never repeat the question here.",
      },
      productIds: terminalProductsSchema,
      question: { type: "string", minLength: 1, maxLength: 300 },
      answers: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 80 },
        minItems: 1,
        maxItems: 4,
      },
      navigationActions: navigationActionsSchema,
    },
    required: ["message", "productIds", "question", "answers", "navigationActions"],
    additionalProperties: false,
  },
} as const;

export const askMeasurementToolDefinition = {
  type: "function",
  name: "ask_measurement",
  description:
    "Finish this reply with one physical distance reading (width, drop, depth or clearance), a guide-grounded method and a free-text measurement field, plus message and zero to ten verified product cards. Only for an actual measurement: meaningful decisions, yes/no questions and source limitations use ask_question; authorized source research needs no permission question. Complete necessary tool work first, then call this alone; there is no prose response afterward. Put the question only in question and the measuring method in instructions. An applicable verified measuring source for productPath is required. Unit is a display hint established by the customer, or null when unknown. Product IDs must come from successful catalog results in this reply. This requests an answer, not a saved dimension or action approval.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        maxLength: 2000,
        description:
          "Necessary context or confirmed outcome only; empty for a simple question. Never repeat the question here.",
      },
      productIds: terminalProductsSchema,
      question: { type: "string", minLength: 1, maxLength: 300 },
      instructions: { type: "string", maxLength: 600 },
      productPath: productPathSchema,
      label: { type: "string", minLength: 1, maxLength: 40 },
      unit: { type: ["string", "null"], enum: ["cm", "mm", "in", null] },
      navigationActions: navigationActionsSchema,
    },
    required: [
      "message",
      "productIds",
      "question",
      "instructions",
      "productPath",
      "label",
      "unit",
      "navigationActions",
    ],
    additionalProperties: false,
  },
} as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_QUESTION_ANSWER_LENGTH = 240;

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("A question must be an object.");
  return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unexpected question fields.");
}

function plainText(input: unknown, limit: number): string {
  if (
    typeof input !== "string" ||
    input.length > limit ||
    !input.trim() ||
    /\p{Cc}|[<>`]|\*\*|__|\[[^\]]*\]\(|https?:\/\//iu.test(input)
  )
    throw new Error("Questions and answers must be short, plain text.");
  return input.trim();
}

export function parseQuestionSelection(input: unknown): QuestionSelection {
  const value = object(input);
  exact(value, [
    "question",
    "answers",
    ...(value.measurement !== undefined ? ["measurement"] : []),
    ...(value.navigationActions !== undefined ? ["navigationActions"] : []),
  ]);
  const navigationActions = parseQuestionNavigation(value.navigationActions);
  const question = plainText(value.question, 300);
  if (value.measurement !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length !== 0)
      throw new Error(
        "A measurement question uses a text input, not answer choices.",
      );
    const measurement = object(value.measurement);
    exact(measurement, ["productPath", "label", "unit", "instructions"]);
    if (
      measurement.unit !== null &&
      !["cm", "mm", "in"].includes(measurement.unit as string)
    )
      throw new Error("Use cm, mm, in or null for this measurement.");
    return {
      question,
      answers: [],
      ...(navigationActions ? { navigationActions } : {}),
      measurement: {
        productPath: parseProductPath(measurement.productPath),
        label: plainText(measurement.label, 40),
        unit: measurement.unit as MeasurementQuestion["unit"],
        instructions:
          measurement.instructions === ""
            ? ""
            : plainText(measurement.instructions, 600),
      },
    };
  }
  if (
    !Array.isArray(value.answers) ||
    value.answers.length < 1 ||
    value.answers.length > 4
  )
    throw new Error("Select one to four short answers.");
  const answers = value.answers.map((answer) => plainText(answer, 80));
  if (
    new Set(answers.map((answer) => answer.toLowerCase())).size !==
    answers.length
  )
    throw new Error("Question answers must be distinct.");
  return { question, answers, ...(navigationActions ? { navigationActions } : {}) };
}

function parseQuestionNavigation(input: unknown): QuestionSelection["navigationActions"] {
  if (input === undefined) return;
  if (!Array.isArray(input) || input.length > 1 || input.some((item) =>
    !item || typeof item !== "object" || Array.isArray(item) ||
    Object.keys(item).length !== 2 || item.label !== "View Cart" || item.view !== "cart"))
    throw new Error("Only the direct View Cart shortcut is supported.");
  return input.length ? [{ label: "View Cart", view: "cart" }] : [];
}

/** Existing plain View Cart choices are navigation too, never synthetic answers. */
export function questionNavigationView(answer: string): "cart" | undefined {
  return answer.trim().toLowerCase() === "view cart" ? "cart" : undefined;
}

function questionMessage(
  input: unknown,
  question: string,
  field = "message",
): string {
  if (
    typeof input !== "string" ||
    input.length > 2000 ||
    /(?![\n\r\t])\p{Cc}/u.test(input)
  )
    throw new Error(
      "Question message must be a string of at most 2000 characters.",
    );
  const message = input.trim();
  const comparable = (value: string) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
  if (comparable(message).includes(comparable(question)))
    throw new Error(`Keep the question in question, not ${field}.`);
  return message;
}

export function parseQuestionCall(input: unknown): QuestionCall {
  const value = object(input);
  exact(value, ["message", "productIds", "question", "answers", ...(value.navigationActions !== undefined ? ["navigationActions"] : [])]);
  const selection = parseQuestionSelection({
    question: value.question,
    answers: value.answers,
    ...(value.navigationActions !== undefined ? { navigationActions: value.navigationActions } : {}),
  });
  return {
    message: questionMessage(value.message, selection.question),
    productIds: terminalProductIds(value.productIds),
    ...selection,
  };
}

export function parseMeasurementQuestionCall(input: unknown): QuestionCall {
  const value = object(input);
  exact(value, [
    "message",
    "productIds",
    "question",
    "instructions",
    "productPath",
    "label",
    "unit",
    ...(value.navigationActions !== undefined ? ["navigationActions"] : []),
  ]);
  const { message, productIds, question, navigationActions, ...measurement } = value;
  const selection = parseQuestionSelection({
    question,
    answers: [],
    measurement,
    ...(navigationActions !== undefined ? { navigationActions } : {}),
  });
  questionMessage(
    selection.measurement!.instructions,
    selection.question,
    "instructions",
  );
  return {
    message: questionMessage(message, selection.question),
    productIds: terminalProductIds(productIds),
    ...selection,
  };
}

function terminalProductIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_PRODUCT_CARDS ||
    new Set(input).size !== input.length ||
    input.some(
      (id) =>
        typeof id !== "string" || id.length > 100 || !productIdPattern.test(id),
    )
  )
    throw new Error(
      `Select zero to ${MAX_PRODUCT_CARDS} distinct Shopify Product IDs.`,
    );
  return [...input];
}

/** A customer answer, not a form mutation or a dimension confirmation. */
export function formatMeasurementAnswer(
  selection: QuestionSelection,
  raw: string,
): string {
  const value = raw.trim();
  if (
    !selection.measurement ||
    !value ||
    /\p{Cc}/u.test(value) ||
    `${selection.measurement.label}: ${value}`.length >
      MAX_QUESTION_ANSWER_LENGTH
  )
    throw new Error(
      "Enter a short measurement or reply, including units if needed.",
    );
  return `${selection.measurement.label}: ${value}`;
}

export function isQuestionAnswer(
  selection: QuestionSelection,
  answer: string,
): boolean {
  if (!selection.measurement) return selection.answers.includes(answer);
  const prefix = `${selection.measurement.label}: `;
  if (!answer.startsWith(prefix)) return false;
  try {
    return (
      formatMeasurementAnswer(selection, answer.slice(prefix.length)) === answer
    );
  } catch {
    return false;
  }
}

export function parseQuestionPart(input: unknown): QuestionPart {
  const value = object(input);
  exact(value, [
    "type",
    "version",
    "invocationId",
    "question",
    "answers",
    ...(value.measurement !== undefined ? ["measurement"] : []),
    ...(value.voiceReply !== undefined ? ["voiceReply"] : []),
    ...(value.navigationActions !== undefined ? ["navigationActions"] : []),
  ]);
  if (
    value.type !== "question" ||
    value.version !== 1 ||
    typeof value.invocationId !== "string" ||
    !uuidPattern.test(value.invocationId)
  )
    throw new Error("Invalid question part.");
  const selection = parseQuestionSelection({
    question: value.question,
    answers: value.answers,
    ...(value.navigationActions !== undefined ? { navigationActions: value.navigationActions } : {}),
    ...(value.measurement !== undefined
      ? { measurement: value.measurement }
      : {}),
  });
  let voiceReply: QuestionPart["voiceReply"];
  if (value.voiceReply !== undefined) {
    const voice = object(value.voiceReply);
    exact(voice, ["voiceId", "afterSequence"]);
    if (
      typeof voice.voiceId !== "string" ||
      !uuidPattern.test(voice.voiceId) ||
      typeof voice.afterSequence !== "number" ||
      !Number.isSafeInteger(voice.afterSequence) ||
      voice.afterSequence < 0
    )
      throw new Error("Invalid question voice association.");
    voiceReply = { voiceId: voice.voiceId, afterSequence: voice.afterSequence };
  }
  return {
    type: "question",
    version: 1,
    invocationId: value.invocationId,
    ...selection,
    ...(voiceReply ? { voiceReply } : {}),
  };
}

export function parseQuestionAnswerReference(
  input: unknown,
): QuestionAnswerReference {
  const value = object(input);
  exact(value, ["questionId", "voiceId"]);
  if (
    typeof value.questionId !== "string" ||
    !uuidPattern.test(value.questionId) ||
    typeof value.voiceId !== "string" ||
    !uuidPattern.test(value.voiceId)
  )
    throw new Error("Invalid question answer reference.");
  return { questionId: value.questionId, voiceId: value.voiceId };
}

export function parseVoiceInputReference(input: unknown): VoiceInputReference {
  const value = object(input);
  exact(value, ["voiceId"]);
  if (typeof value.voiceId !== "string" || !uuidPattern.test(value.voiceId))
    throw new Error("Invalid voice input reference.");
  return { voiceId: value.voiceId };
}

/** Customer turns retire questions; leaving a product also retires its measurement input. */
export function latestQuestion(
  messages: readonly ConversationMessage[],
  storefrontPath?: string,
): QuestionPart | undefined {
  const laterPaths: string[] = storefrontPath ? [storefrontPath] : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") return;
    if (message.status !== "complete") continue;
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex--
    ) {
      const part = message.parts[partIndex];
      if (part.type === "page_view" || part.type === "navigation")
        laterPaths.push(part.path);
      if (part.type === "question") {
        if (
          part.measurement &&
          laterPaths.some((path) => {
            const pathname = new URL(path, "https://storefront.invalid")
              .pathname;
            const match =
              /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i.exec(
                pathname,
              );
            return (
              !match ||
              `/products/${match[1]}` !== part.measurement!.productPath
            );
          })
        )
          return;
        return part;
      }
    }
  }
}

/** A transcript page is not authoritative evidence that an older question retired. */
export function currentQuestion(
  conversation:
    | (Pick<ConversationSnapshot, "messages" | "status"> &
        Partial<Pick<ConversationSnapshot, "current">>)
    | null
    | undefined,
  storefrontPath?: string,
) {
  if (conversation?.status !== "active") return;
  if (!conversation.current)
    return latestQuestion(conversation.messages, storefrontPath);
  const part = conversation.current.pendingQuestion;
  return part
    ? latestQuestion(
        [
          {
            id: part.invocationId,
            role: "context",
            status: "complete",
            createdAt: "",
            parts: [part],
          },
        ],
        storefrontPath,
      )
    : undefined;
}
