import type { ConversationMessage } from "./conversation";
import type { ProductChoice } from "./product-choice";
import { parseProductPath, productPathSchema } from "./product-path";

export interface MeasurementQuestion {
  productPath: string;
  label: string;
  unit: "cm" | "mm" | "in";
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
  /** Numeric input instead of suggested answers. */
  measurement?: MeasurementQuestion;
}

/** Complete model reply; message is context, never a second question. */
export interface QuestionCall extends QuestionSelection {
  message: string;
}

export interface QuestionPart extends QuestionSelection {
  type: "question";
  version: 1;
  invocationId: string;
  /** Display association only; it does not assert that the shopper heard it. */
  voiceReply?: { voiceId: string; afterSequence: number };
}

export const askQuestionToolDefinition = {
  type: "function",
  name: "ask_question",
  description:
    "Finish this reply with a brief message, one question and one to four concise clickable answers. This is a terminal tool: complete necessary research, actions and carousel presentation first, then call this alone; there is no prose response afterward. Put only necessary confirmed outcomes, explanation or introduction in message, or use an empty string for a simple follow-up. Put the question only in question, never in message. Prefer two or three answers and fewer where sufficient. Use contextual choices throughout the conversation; default to Help me measure, Explore products and Find my style only when no useful contextual next step remains. Ask missing room/requirements before new recommendations. Carousel images select products; use refinement answers rather than repeating product names. The unselected entry-PDP choice has only Something else. A replacement needs Yes, change blind / No, keep this blind. Use ask_measurement instead for a supported individual numeric reading. Questions and answers are plain text; message may use brief Markdown in text mode. In voice mode keep message plus question within 1000 characters; the application assembles the spoken briefing. Clicked, typed and spoken answers are customer input, never implicit tool commands or approval to act.",
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
      question: { type: "string", minLength: 1, maxLength: 300 },
      answers: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 80 },
        minItems: 1,
        maxItems: 4,
      },
    },
    required: ["message", "question", "answers"],
    additionalProperties: false,
  },
} as const;

export const askMeasurementToolDefinition = {
  type: "function",
  name: "ask_measurement",
  description:
    "Finish this reply with one guide-grounded numeric measurement, its units, instructions and question. This is a terminal tool: complete needed guide reads, actions and carousel presentation first, then call this alone; there is no prose response afterward. Use message only for a necessary confirmed outcome or the initial guide introduction, otherwise an empty string. Put the question only in question and the complete current-step method only in instructions. Use the current product and verified original-guide evidence, including valid prior reads. Establish cm/mm/in first unless already clear. Label the actual reading; never invent a PDP field. In voice mode keep message plus instructions plus question within 1000 characters without losing fit-critical conditions; stage a smaller step if needed. Typed or spoken answers also work, including unit changes and stopping. Unit changes restart collection without silently converting or reusing the old set. This requests a reading; it does not save, confirm or apply dimensions.",
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
      question: { type: "string", minLength: 1, maxLength: 300 },
      instructions: { type: "string", minLength: 1, maxLength: 600 },
      productPath: productPathSchema,
      label: { type: "string", minLength: 1, maxLength: 40 },
      unit: { type: "string", enum: ["cm", "mm", "in"] },
    },
    required: [
      "message",
      "question",
      "instructions",
      "productPath",
      "label",
      "unit",
    ],
    additionalProperties: false,
  },
} as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  ]);
  const question = plainText(value.question, 300);
  if (value.measurement !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.length !== 0)
      throw new Error(
        "A measurement question uses a number input, not answer choices.",
      );
    const measurement = object(value.measurement);
    exact(measurement, ["productPath", "label", "unit", "instructions"]);
    if (!["cm", "mm", "in"].includes(measurement.unit as string))
      throw new Error("Choose cm, mm or in for this measurement.");
    return {
      question,
      answers: [],
      measurement: {
        productPath: parseProductPath(measurement.productPath),
        label: plainText(measurement.label, 40),
        unit: measurement.unit as MeasurementQuestion["unit"],
        instructions: plainText(measurement.instructions, 600),
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
  return { question, answers };
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
  exact(value, ["message", "question", "answers"]);
  const selection = parseQuestionSelection({
    question: value.question,
    answers: value.answers,
  });
  return {
    message: questionMessage(value.message, selection.question),
    ...selection,
  };
}

export function parseMeasurementQuestionCall(input: unknown): QuestionCall {
  const value = object(input);
  exact(value, [
    "message",
    "question",
    "instructions",
    "productPath",
    "label",
    "unit",
  ]);
  const { message, question, ...measurement } = value;
  const selection = parseQuestionSelection({
    question,
    answers: [],
    measurement,
  });
  questionMessage(
    selection.measurement!.instructions,
    selection.question,
    "instructions",
  );
  return {
    message: questionMessage(message, selection.question),
    ...selection,
  };
}

/** A customer answer, not a form mutation or a dimension confirmation. */
export function formatMeasurementAnswer(
  selection: QuestionSelection,
  raw: string,
): string {
  const value = raw.trim();
  if (
    !selection.measurement ||
    value.length > 24 ||
    !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0 ||
    Number(value) > Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      "Enter zero or a positive number, using a decimal point if needed.",
    );
  return `${selection.measurement.label}: ${value} ${selection.measurement.unit}`;
}

export function isQuestionAnswer(
  selection: QuestionSelection,
  answer: string,
): boolean {
  if (!selection.measurement) return selection.answers.includes(answer);
  const prefix = `${selection.measurement.label}: `;
  const suffix = ` ${selection.measurement.unit}`;
  if (!answer.startsWith(prefix) || !answer.endsWith(suffix)) return false;
  try {
    return (
      formatMeasurementAnswer(
        selection,
        answer.slice(prefix.length, -suffix.length),
      ) === answer
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

/** Customer turns retire questions; leaving a product also retires its numeric input. */
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
