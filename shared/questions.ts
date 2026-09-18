import type { ConversationMessage } from "./conversation";
import type { ProductChoice } from "./product-choice";
import { parseProductPath, productPathSchema } from "./product-path";

// Accepted for answers and durable receipts from already-open clients. New
// measurement widgets leave changes and stopping to normal text or speech.
export const MEASUREMENT_CHANGE_UNITS = "Change units";
export const MEASUREMENT_STOP = "Stop measuring";

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
    "Ask one short follow-up question with one to four concise clickable answers beneath the reply's other widgets. Use an answer widget for every completed substantive reply: choose a contextual clarification or next step, including after a flow completes, without requiring a catalog call or completed action. Fall back to Help me measure, Explore products and Find my style when no more specific next action fits. Use ask_measurement for an individual guided numeric measurement. For open-ended details, offer useful examples or a Not sure choice without limiting typed or spoken answers; never invent numeric readings or imply an action was approved. Prefer two or three answers, and fewer where sufficient. Use plain text, without Markdown or URLs. Before new recommendations, ask the missing room or main requirements unless already known. After product suggestions, give a brief overview, show the carousel, then use this tool for refinement such as Show me more or Different colours. The cards' Choose this blind image controls select products; do not list those product names again as answers. For an unselected entry-PDP card, offer only Something else using the shared product-page entry question. If a customer chooses a different active blind, use Yes, change blind and No, keep this blind before replacement. Call once per reply, choosing either ask_question or ask_measurement. When this tool succeeds, Roman may also include its exact question in the written reply; duplication with the quick-answer widget is allowed. Keep any overview concise and do not add a different question. If neither answer-request tool succeeds, keep the written reply to the useful outcome; the application supplies fallback choices without another written question. In a voice briefing, provide this exact question once after the overview for Roman to say aloud, without adding or rewording another question. The customer can answer by clicking, speaking or writing their own reply. Answers are customer input; the widget does not execute actions or bypass action-specific safeguards.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 300 },
      answers: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 80 },
        minItems: 1,
        maxItems: 4,
      },
    },
    required: ["question", "answers"],
    additionalProperties: false,
  },
} as const;

export const askMeasurementToolDefinition = {
  type: "function",
  name: "ask_measurement",
  description:
    "Request one measurement using a numeric input, selected units and concise guide-grounded instructions beneath the reply's other widgets. Use this product's original guides already supplied by the server, including cached documents; look up a needed guide only if absent. Establish units with ask_question (cm / mm / in), unless already explicit. Label the actual measurement, such as Width, Drop or Handle clearance; never invent a PDP field. Use only the current product and guide-supported instructions. Choose either this tool or ask_question once per reply. This is the last action in a routine measuring reply: finish any necessary guide or product presentation first and include all instructions in this call. The widget owns the written question and instructions; voice says the instructions and question once. Typed or spoken answers also work, including requests to change units or stop measuring. A unit change restarts collection in the new units, without converting or reusing the old set. This only asks a question: it does not save, confirm or apply dimensions.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 300 },
      instructions: { type: "string", minLength: 1, maxLength: 600 },
      productPath: productPathSchema,
      label: { type: "string", minLength: 1, maxLength: 40 },
      unit: { type: "string", enum: ["cm", "mm", "in"] },
    },
    required: ["question", "instructions", "productPath", "label", "unit"],
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

export function parseMeasurementQuestionSelection(
  input: unknown,
): QuestionSelection {
  const value = object(input);
  exact(value, ["question", "instructions", "productPath", "label", "unit"]);
  const { question, ...measurement } = value;
  return parseQuestionSelection({ question, answers: [], measurement });
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
  if (answer === MEASUREMENT_CHANGE_UNITS || answer === MEASUREMENT_STOP)
    return true;
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
