export interface QuestionSelection {
  question: string;
  answers: string[];
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
    "Ask one short follow-up question with one to four concise clickable answers beneath the reply's other widgets. Prefer two or three answers, and fewer where sufficient. Use plain text, without Markdown or URLs. After product suggestions, give a brief overview, show the selected carousel, then use this tool for the next useful choice instead of duplicating product descriptions in a long list. Call once per reply. The customer can answer by clicking or writing their own reply; this does not grant approval for purchases or other actions. Do not repeat the question in your text reply.",
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
  exact(value, ["question", "answers"]);
  const question = plainText(value.question, 300);
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

export function parseQuestionPart(input: unknown): QuestionPart {
  const value = object(input);
  exact(value, [
    "type",
    "version",
    "invocationId",
    "question",
    "answers",
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
