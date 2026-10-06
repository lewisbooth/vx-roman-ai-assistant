import {
  StorefrontTurn,
  isConfigurationStep,
  parseStorefrontCall,
} from "./storefront-turn.server";
import { checkoutToolDefinition } from "../../shared/checkout";
import OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import type {
  Response,
  ResponseError,
  ResponseInput,
} from "openai/resources/responses/responses";
import { catalogToolDefinitions } from "../../shared/catalog-tools";
import { navigationToolDefinition } from "../../shared/navigation-tool";
import type { BrowserToolOutcome } from "./browser-tools.server";
import { cartToolDefinitions, isCartMutation } from "../../shared/cart-tools";
import {
  productConfigurationToolDefinitions,
  type ProductConfigurationResult,
} from "../../shared/product-configuration";
import {
  measurementToolDefinitions,
  applyMeasurementsToolDefinition,
  type MeasurementToolResult,
} from "../../shared/measurements";
import type { ModelUsageUpdate } from "../usage/contracts";
import {
  productGuidesToolDefinition,
  type ProductGuideKind,
} from "../../shared/product-guides";
import { ROMAN_TEXT_PROMPT } from "../prompts/text.server";
import { showViewToolDefinition } from "../../shared/assistant-view";
import {
  askQuestionToolDefinition,
  askMeasurementToolDefinition,
  parseMeasurementQuestionCall,
  parseQuestionCall,
  type QuestionPart,
} from "../../shared/questions";
import { ROMAN_VOICE_BRIEFING_PROMPT } from "../prompts/voice.server";
import {
  parseProductSelection,
  type ProductPresentation,
  type QuestionPresentation,
  type CachedGuideSource,
  type WindowPresentation,
} from "./presentation.server";
import {
  isVisualizationTool,
  presentPhotosToolDefinition,
  visualizationToolDefinitions,
} from "../visualizations/tool-definitions";
import type { VisualizationTurn } from "../visualizations/tools.server";
import { MAX_TURN_TOOL_CALLS } from "./limits.server";
import {
  FALLBACK_TEXT_MODEL,
  PRIMARY_TEXT_MODEL,
  assertServiceAvailable,
  isServiceSuspended,
  reportFallbackUnavailable,
  reportPrimaryUnavailable,
  textModelForRequest,
} from "./availability.server";
import type { ModelMessage } from "./history.server";
import {
  COMPACT_THRESHOLD_TOKENS, applyMemoryUpdate, memoryUpdateSchema,
  modelMemoryInput, parseCheckpoint, parseMemoryUpdate, parseRecallHistory, shouldCompactContext,
  recallHistoryToolDefinition, type MemoryUpdate, type ModelMemory, type ContextCheckpoint,
} from "./memory.server";
import { guideLibraryToolDefinition } from "../../shared/guide-library";
import { storeSupportToolDefinition } from "../../shared/store-support";
import { readLibraryGuidesToolDefinition } from "../guides/library.server";
import {
  createGuideTurn,
  isGuideTool,
  MissingMeasuringSourceError,
  type GuideReuse,
  type LibraryReuse,
} from "./guide-turn.server";

export const TEXT_MODEL = PRIMARY_TEXT_MODEL;
export const TEXT_SERVICE_TIER = "fast";

const isTerminalTool = (name: string) =>
  name === "ask_question" || name === "ask_measurement" || name === "present_photos";

/** Bounded phase facts only; never provider bodies, arguments or customer text. */
export type ModelTurnDiagnostic =
  | { type: "request"; ordinal: number; model: string; inputItems: number; durableInputBytes: number; checkpoint: boolean; compactionEnabled: boolean; allowedTools: number; cacheMode: "implicit" }
  | { type: "repair"; reason: "missing_source" | "invalid_json" | "terminal_validation" | "missing_terminal" | "incomplete_terminal" }
  | { type: "checkpoint"; status: "valid" | "rejected"; bytes: number; throughSequence: number };

// The provider counts reasoning and structured tool arguments as output too.
const OUTPUT_TOKEN_BUDGET = 8192;
const EXPANDED_OUTPUT_TOKEN_BUDGET = 16384;

const incompleteReasons = [
  "max_output_tokens",
  "max_messages",
  "content_filter",
  "steered",
] as const satisfies readonly NonNullable<
  Response["incomplete_details"]
>["reason"][];
const responseErrorCodes = [
  "server_error",
  "rate_limit_exceeded",
  "invalid_prompt",
  "data_residency_mismatch",
  "bio_policy",
  "misalignment_policy_violation",
  "vector_store_timeout",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_too_small",
  "image_parse_error",
  "image_content_policy_violation",
  "invalid_image_mode",
  "image_file_too_large",
  "unsupported_image_media_type",
  "empty_image_file",
  "failed_to_download_image",
  "image_file_not_found",
] as const satisfies readonly ResponseError["code"][];

/** Provider bodies may contain customer data; retain only known categories. */
export class ModelResponseError extends Error {
  readonly diagnostics: {
    providerStatus: "incomplete" | "failed" | "error" | "stream_ended";
    incompleteReason?: (typeof incompleteReasons)[number] | "unknown";
    providerCode?: (typeof responseErrorCodes)[number] | "unknown";
  };

  constructor(
    status: ModelResponseError["diagnostics"]["providerStatus"],
    response?: Response,
    eventCode?: string | null,
  ) {
    super("The model did not complete its reply.");
    this.name = "ModelResponseError";
    const reason = response?.incomplete_details?.reason;
    const code = response?.error?.code ?? eventCode;
    this.diagnostics = {
      providerStatus: status,
      ...(status === "incomplete"
        ? {
            incompleteReason:
              incompleteReasons.find((known) => known === reason) ?? "unknown",
          }
        : {}),
      ...(code != null || status === "failed" || status === "error"
        ? {
            providerCode:
              responseErrorCodes.find((known) => known === code) ?? "unknown",
          }
        : {}),
    };
  }
}

const providerErrorCodes = [
  "model_not_found",
  "rate_limit_exceeded",
  "insufficient_quota",
] as const;

/** SDK error messages and bodies may contain request data; log only safe fields. */
export function providerFailureDiagnostics(error: unknown) {
  if (error instanceof ModelResponseError) return error.diagnostics;
  if (!(error instanceof OpenAI.APIError)) return {};
  return {
    providerHttpStatus: error.status ?? null,
    providerCode:
      providerErrorCodes.find((code) => code === error.code) ?? "unknown",
  };
}

function isProviderAvailabilityFailure(error: unknown): boolean {
  if (error instanceof ModelResponseError) {
    if (error.diagnostics.providerStatus === "stream_ended") return true;
    return (
      error.diagnostics.providerStatus !== "incomplete" &&
      ["server_error", "rate_limit_exceeded", "vector_store_timeout"].includes(
        error.diagnostics.providerCode ?? "",
      )
    );
  }
  if (!(error instanceof OpenAI.APIError)) return false;
  const policyCode = [
    "invalid_prompt",
    "content_policy_violation",
    "bio_policy",
    "misalignment_policy_violation",
  ].includes(error.code ?? "");
  return (
    error instanceof OpenAI.APIConnectionError ||
    error.status === 401 ||
    (error.status === 403 && !policyCode) ||
    (error.status === 404 && error.code === "model_not_found") ||
    [408, 429, 500, 502, 503, 504].includes(error.status ?? -1)
  );
}

type ModelToolOutcome =
  BrowserToolOutcome | MeasurementToolResult | ProductConfigurationResult;

export interface ModelReply {
  text: string;
  model: string;
  /** Requested alias owns opaque context; model retains provider billing identity. */
  requestedModel?: string;
  serviceTier?: string;
  presentation?: ProductPresentation;
  questionPresentation?: QuestionPresentation;
  photoPresentation?: WindowPresentation;
  cachedGuideSource?: CachedGuideSource;
  memoryUpdate?: MemoryUpdate;
  contextCheckpoint?: ContextCheckpoint;
}

let client: OpenAI | undefined;

function reportedTokens(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

function responseUsage(
  id: string,
  status: ModelUsageUpdate["status"],
  response?: Response,
  requestedModel = TEXT_MODEL,
): ModelUsageUpdate {
  const usage = response?.usage;
  const inputTokens = reportedTokens(usage?.input_tokens);
  const outputTokens = reportedTokens(usage?.output_tokens);
  const cachedInputTokens = reportedTokens(
    usage?.input_tokens_details?.cached_tokens,
  );
  const cacheWriteInputTokens = reportedTokens(
    usage?.input_tokens_details?.cache_write_tokens,
  );
  const reasoningTokens = reportedTokens(
    usage?.output_tokens_details?.reasoning_tokens,
  );
  return {
    id,
    status,
    model:
      response?.model && /^[a-zA-Z0-9._:-]{1,100}$/.test(response.model)
        ? response.model
        : requestedModel,
    serviceTier:
      response?.service_tier && /^[a-z0-9_-]{1,40}$/.test(response.service_tier)
        ? response.service_tier
        : null,
    inputTokens,
    cachedInputTokens:
      cachedInputTokens !== null &&
      inputTokens !== null &&
      cachedInputTokens > inputTokens
        ? null
        : cachedInputTokens,
    cacheWriteInputTokens:
      cacheWriteInputTokens !== null &&
      inputTokens !== null &&
      cacheWriteInputTokens + (cachedInputTokens ?? 0) > inputTokens
        ? null
        : cacheWriteInputTokens,
    outputTokens,
    reasoningTokens:
      reasoningTokens !== null &&
      outputTokens !== null &&
      reasoningTokens > outputTokens
        ? null
        : reasoningTokens,
    totalTokens: reportedTokens(usage?.total_tokens),
  };
}

export async function generateReply(
  history: ModelMessage[],
  onText: (text: string) => void,
  signal: AbortSignal,
  execute?: (
    callId: string,
    name: string,
    input: unknown,
  ) => Promise<ModelToolOutcome>,
  mode: "text" | "voice" = "text",
  onUsage?: (usage: ModelUsageUpdate) => Promise<void>,
  storefrontOrigin?: string,
  resumeQuestion?: QuestionPart,
  onGuideReading?: (kinds: ProductGuideKind[] | undefined) => void,
  guideReuse?: GuideReuse,
  libraryReuse?: LibraryReuse,
  onToolActivity?: (name: string, active: boolean) => void,
  reasoningEffort: "low" | "medium" = "medium",
  memory?: ModelMemory,
  recallHistory?: (input: unknown, signal: AbortSignal) => Promise<unknown>,
  visualizations?: VisualizationTurn,
  onDiagnostic?: (event: ModelTurnDiagnostic) => void,
): Promise<ModelReply> {
  const trackTool = async <T>(name: string, action: () => Promise<T>) => {
    onToolActivity?.(name, true);
    try {
      return await action();
    } finally {
      onToolActivity?.(name, false);
    }
  };
  let turnModel = await textModelForRequest();
  client ??= new OpenAI({ maxRetries: 0, timeout: 90_000 });
  // Provider checkpoints are model-specific; this turn's verified results are
  // separately retained so failover never replays actions or uses foreign state.
  const input: ResponseInput = [];
  const replay: ResponseInput = [];
  const histories = new Map<string, ModelMessage[]>();
  let compactedThisTurn = false;
  let recallCalls = 0;
  let requestOrdinal = 0;
  const appendInput = (...items: ResponseInput) => {
    input.push(...items);
    replay.push(...items.filter((item) => item.type !== "compaction"));
  };
  const appendOutput = (output: Response["output"]) => {
    const items = output.filter(
      (item) =>
        item.type === "message" ||
        item.type === "reasoning" ||
        item.type === "function_call" ||
        item.type === "compaction",
    );
    // Fallback needs every raw call and result, including calls emitted before
    // a compaction item in this response. Only the owning model uses that item.
    replay.push(...items.filter((item) => item.type !== "compaction"));
    const compactIndex = items.reduce(
      (latest, item, index) => (item.type === "compaction" ? index : latest),
      -1,
    );
    if (compactIndex >= 0) {
      compactedThisTurn = true;
      input.splice(0, input.length, ...items.slice(compactIndex));
    } else input.push(...items);
  };
  const checkpoint = (model: string): ContextCheckpoint | undefined => {
    if (!memory || !compactedThisTurn) return undefined;
    const candidate = { model, throughSequence: memory.throughSequence, input: [...input] };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    try {
      const parsed = parseCheckpoint(candidate);
      onDiagnostic?.({ type: "checkpoint", status: "valid", bytes, throughSequence: memory.throughSequence });
      return parsed;
    } catch {
      // A provider-sized checkpoint must never turn a completed shopping action
      // into a failed reply. The original transcript still supplies the next call.
      onDiagnostic?.({ type: "checkpoint", status: "rejected", bytes, throughSequence: memory.throughSequence });
      console.warn("[Roman] Context checkpoint was not persisted.", { bytes, throughSequence: memory.throughSequence });
      return undefined;
    }
  };
  let browserCalls = 0;
  const actions = new StorefrontTurn();
  const withinToolBudget = (name: string) =>
    browserCalls < 4 ||
    (actions.configurationMode &&
      (isConfigurationStep(name) || isGuideTool(name) || actions.isConfigurationCompletion(name)) &&
      browserCalls < MAX_TURN_TOOL_CALLS);
  let answerRepair = false;
  let sourceRecovery = false;
  let sourceRecoveryReads = 0;
  let outputTokenBudget = OUTPUT_TOKEN_BUDGET;
  const availableProducts = new Map<string, string>();
  const guides = createGuideTurn({
    execute,
    signal,
    storefrontOrigin,
    onGuideReading,
    onConfiguration: (configuration) =>
      actions.observeConfiguration(configuration),
    guideReuse,
    libraryReuse,
    resumeQuestion,
    trackTool,
  });
  const resumePresentation = resumeQuestion?.measurement
    ? "ask_measurement"
    : "ask_question";
  const terminalRepairGuidance = visualizations && !resumeQuestion
    ? "Use present_photos with only message and photoPresentation when choosing/uploading a photo is next; do not add question or answer fields. Otherwise use ask_question or ask_measurement for the single next decision."
    : "Use ask_question or ask_measurement for the single next decision.";
  // Stable schemas preserve cached prefixes; allowed_tools narrows each round.
  // Existing runtime budgets and read-only guards remain the authority.
  const allTools = [
    ...(execute
      ? [
          ...catalogToolDefinitions,
          navigationToolDefinition,
          showViewToolDefinition,
          checkoutToolDefinition,
          productGuidesToolDefinition,
          ...(libraryReuse
            ? [guideLibraryToolDefinition, readLibraryGuidesToolDefinition]
            : []),
          storeSupportToolDefinition,
          ...measurementToolDefinitions,
          ...cartToolDefinitions,
          ...productConfigurationToolDefinitions,
          applyMeasurementsToolDefinition,
        ]
      : []),
    ...(recallHistory ? [recallHistoryToolDefinition] : []),
    ...(visualizations ? visualizationToolDefinitions : []),
    ...[
      askQuestionToolDefinition,
      ...(execute ? [askMeasurementToolDefinition] : []),
      ...(visualizations ? [presentPhotosToolDefinition] : []),
    ].map((tool) => ({
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          ...(memory ? { memoryUpdate: memoryUpdateSchema } : {}),
        },
        required: [
          ...tool.parameters.required,
          ...(memory ? ["memoryUpdate"] : []),
        ],
      },
    })),
  ];
  const stableTools = resumeQuestion
    ? allTools.filter(
        (tool) => isGuideTool(tool.name) || tool.name === resumePresentation,
      )
    : allTools;
  const prefix: ResponseInput = [
    {
      role: "developer",
      content: [
        {
          type: "input_text",
          text: "Roman runtime references follow.",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
    },
  ];
  const resumeInput: ResponseInput = resumeQuestion
    ? [
        {
          role: "developer",
          content: `Read-only resume of the saved question${history.some((message) => message.source === "application_state" && message.pendingQuestion) ? " in application state" : `: ${JSON.stringify({ question: resumeQuestion.question, answers: resumeQuestion.answers, navigationActions: resumeQuestion.navigationActions ?? [], ...(resumeQuestion.measurement ? { measurement: resumeQuestion.measurement } : {}) })}`}. Preserve its question, answers, navigation actions and measurement identity. Read only missing source evidence; no actions or new product cards.`,
        },
      ]
    : [];
  replyRounds: for (
    let round = 0;
    round < (actions.configurationMode ? 16 : 8) + (sourceRecovery ? 3 : 0) + (answerRepair ? 1 : 0);
    round++
  ) {
    signal.throwIfAborted();
    await assertServiceAvailable();
    const tools = stableTools.filter(({ name }) => {
      if (
        actions.checkoutHandoff ||
        (name === "open_checkout" && actions.checkoutAttempted)
      )
        return false;
      if (isTerminalTool(name)) return true;
      if (answerRepair) return false;
      if (sourceRecovery)
        return isGuideTool(name) && sourceRecoveryReads < 2 && browserCalls < MAX_TURN_TOOL_CALLS;
      if (name === "recall_history") return recallCalls < 2;
      if (isVisualizationTool(name)) return !!visualizations?.allows();
      return withinToolBudget(name) && actions.allows(name);
    });
    let model = turnModel;
    let fallbackAttempted = false;
    let text = "";
    let completed: Response | undefined;
    let repairIncompleteAnswer = false;
    for (;;) {
      if (!histories.has(model)) {
        histories.set(
          model,
          (await memory?.historyForModel?.(model)) ?? history,
        );
        signal.throwIfAborted();
      }
      const durableInput: ResponseInput = [
        ...(compactedThisTurn
          ? []
          : modelMemoryInput(histories.get(model)!, model, memory)),
        ...input,
      ];
      const usageId = randomUUID();
      const attempt = responseUsage(usageId, "pending", undefined, model);
      // Persist each provider attempt before issuing a possibly billed request.
      await onUsage?.(attempt);
      let terminalReceived = false;
      text = "";
      try {
        signal.throwIfAborted();
        onDiagnostic?.({
          type: "request", ordinal: ++requestOrdinal, model,
          inputItems: durableInput.length,
          durableInputBytes: Buffer.byteLength(JSON.stringify(durableInput), "utf8"),
          checkpoint: durableInput.some((item) => item.type === "compaction"),
          compactionEnabled: !!memory && shouldCompactContext(durableInput),
          allowedTools: tools.length, cacheMode: "implicit",
        });
        const stream = await client.responses.create(
          {
            model,
            service_tier: TEXT_SERVICE_TIER,
            reasoning: { effort: reasoningEffort },
            instructions:
              mode === "voice"
                ? ROMAN_VOICE_BRIEFING_PROMPT
                : ROMAN_TEXT_PROMPT,
            input: [
              ...prefix,
              ...guides.context(),
              ...resumeInput,
              ...durableInput,
            ],
            ...(memory && shouldCompactContext(durableInput)
              ? {
                  context_management: [
                    {
                      type: "compaction" as const,
                      compact_threshold: COMPACT_THRESHOLD_TOKENS,
                    },
                  ],
                }
              : {}),
            prompt_cache_key: createHash("sha256")
              .update(
                JSON.stringify([
                  "roman-guides-v1",
                  storefrontOrigin ?? "no-store",
                  mode,
                  resumeQuestion ? resumePresentation : "regular",
                  model,
                ]),
              )
              .digest("hex"),
            // Keep explicit stable/PDF prefixes while permitting reuse at
            // immutable history/tool endings before changing notes/state.
            prompt_cache_options: { mode: "implicit", ttl: "30m" },
            include: ["reasoning.encrypted_content"],
            ...(stableTools.length
              ? {
                  tools: stableTools,
                  parallel_tool_calls: false,
                  tool_choice: tools.length
                    ? {
                        type: "allowed_tools" as const,
                        mode: "required" as const,
                        tools: tools.map(({ name }) => ({
                          type: "function" as const,
                          name,
                        })),
                      }
                    : ("none" as const),
                }
              : {}),
            max_output_tokens: outputTokenBudget,
            store: false,
            stream: true,
          },
          { signal },
        );
        for await (const event of stream) {
          if (
            event.type === "response.completed" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            guides.finishReading();
            terminalReceived = true;
            await onUsage?.(
              responseUsage(
                usageId,
                event.type.slice(
                  "response.".length,
                ) as ModelUsageUpdate["status"],
                event.response,
                model,
              ),
            );
          }
          if (event.type === "response.output_text.delta") {
            if (event.delta.trim()) guides.finishReading();
            text += event.delta;
          } else if (event.type === "response.completed") {
            // Refusals are displayable responses too, without exposing reasoning items.
            text = event.response.output
              .flatMap((item) => (item.type === "message" ? item.content : []))
              .map((part) =>
                part.type === "output_text" ? part.text : part.refusal,
              )
              .join("");
            completed = event.response;
            break;
          } else if (event.type === "error") {
            throw new ModelResponseError("error", undefined, event.code);
          } else if (
            event.type === "response.incomplete" &&
            event.response?.incomplete_details?.reason === "max_messages" &&
            !answerRepair &&
            !actions.checkoutHandoff &&
            input.some((item) => item.type === "function_call_output")
          ) {
            // A finished tool round may still need its terminal customer reply.
            // Never retain or execute an incomplete response's output.
            repairIncompleteAnswer = true;
            break;
          } else if (
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            throw new ModelResponseError(
              event.type === "response.failed" ? "failed" : "incomplete",
              event.response,
            );
          }
        }
        if (!completed && !repairIncompleteAnswer)
          throw new ModelResponseError("stream_ended");
      } catch (error) {
        if (
          error instanceof ModelResponseError &&
          error.diagnostics.incompleteReason === "max_output_tokens" &&
          outputTokenBudget === OUTPUT_TOKEN_BUDGET
        ) {
          signal.throwIfAborted();
          await assertServiceAvailable();
          // Retry this provider round once per turn, with its unchanged validated
          // input. No partial text, tool calls or checkpoints have been retained.
          outputTokenBudget = EXPANDED_OUTPUT_TOKEN_BUDGET;
          console.warn("[Roman] Retrying truncated model response.", {
            providerStatus: "incomplete",
            incompleteReason: "max_output_tokens",
            maxOutputTokens: outputTokenBudget,
          });
          continue;
        }
        if (!signal.aborted && isProviderAvailabilityFailure(error)) {
          if (model === PRIMARY_TEXT_MODEL) {
            await reportPrimaryUnavailable();
            // The current provider round has not published text or dispatched
            // its tool calls. Prior round outcomes are already in its input.
            if (!fallbackAttempted && !isServiceSuspended()) {
              fallbackAttempted = true;
              model = FALLBACK_TEXT_MODEL;
              turnModel = model;
              // Encrypted reasoning is owned by the model that produced it.
              // Function calls and confirmed results remain valid turn input.
              compactedThisTurn = false;
              input.splice(
                0,
                input.length,
                ...replay.filter(
                  (item) =>
                    item.type !== "reasoning" && item.type !== "compaction",
                ),
              );
              continue;
            }
          } else await reportFallbackUnavailable();
        }
        throw error;
      } finally {
        if (!terminalReceived)
          await onUsage?.({ ...attempt, status: "unavailable" });
      }
      break;
    }
    signal.throwIfAborted();
    await assertServiceAvailable();
    if (repairIncompleteAnswer) {
      answerRepair = true;
      onDiagnostic?.({ type: "repair", reason: "incomplete_terminal" });
      console.warn("[Roman] Repairing incomplete reply.", {
        providerStatus: "incomplete",
        incompleteReason: "max_messages",
      });
      appendInput({
        role: "developer",
        content:
          "The previous response ended before producing a complete answer request; none of its output was displayed or executed. Use the completed tool results already in this turn to finish once. " + terminalRepairGuidance + " Preserve the confirmed outcome in message. Do not repeat completed work or claim that unfinished work happened; only an answer request is available.",
      });
      continue;
    }
    if (!completed) throw new ModelResponseError("stream_ended");
    appendOutput(completed.output);
    const toolCalls = completed.output.filter(
      (item) => item.type === "function_call",
    );
    if (
      toolCalls.length > 1 &&
      toolCalls.some(
        (call) =>
          isTerminalTool(call.name),
      )
    )
      throw new Error(
        "Roman returned concurrent tool calls despite sequential execution being required.",
      );
    if (!toolCalls.length) {
      const refused = completed.output.some(
        (item) =>
          item.type === "message" &&
          item.content.some((part) => part.type === "refusal"),
      );
      if (refused || (actions.checkoutHandoff && text.trim())) {
        const contextCheckpoint = checkpoint(model);
        onText(text);
        return {
          text,
          model: completed.model,
          serviceTier: completed.service_tier ?? undefined,
          ...(contextCheckpoint
            ? { contextCheckpoint, requestedModel: model }
            : {}),
        };
      }
      if (!text.trim()) throw new Error("The model returned an empty reply.");
      if (answerRepair)
        throw new Error("Roman did not finish with a valid answer request.");
      answerRepair = true;
      onDiagnostic?.({ type: "repair", reason: "missing_terminal" });
      appendInput({
        role: "developer",
        content:
          "Finish this reply. " + terminalRepairGuidance + " Put the useful overview or confirmed outcome in message. No answer was displayed. Do not repeat completed work; only an answer request is available.",
      });
      continue;
    }
    for (const call of toolCalls) {
      signal.throwIfAborted();
      if (actions.checkoutHandoff)
        throw new Error(
          "Checkout handoff is complete; no further tools are allowed in this reply.",
        );
      // The advertised subset is not authorization: reject even an unsolicited
      // provider call before parsing or dispatching any privileged action.
      if (
        resumeQuestion &&
        !isGuideTool(call.name) &&
        call.name !== resumePresentation
      )
        throw new Error("Only read-only question resume tools are allowed.");
      if (isTerminalTool(call.name)) {
        try {
          const argumentsValue: unknown = JSON.parse(call.arguments);
          if (
            !argumentsValue ||
            typeof argumentsValue !== "object" ||
            Array.isArray(argumentsValue)
          )
            throw new Error("Invalid answer request.");
          const {
            memoryUpdate: rawMemoryUpdate,
            ...publicAnswer
          } = argumentsValue as Record<string, unknown>;
          const memoryUpdate = parseMemoryUpdate(rawMemoryUpdate);
          if (memoryUpdate && !memory)
            throw new Error("Private memory is not available for this reply.");
          if (resumeQuestion && memoryUpdate)
            throw new Error(
              "Read-only question resumption cannot change private memory.",
            );
          if (memory) applyMemoryUpdate(memory.memo, memoryUpdate);
          if (!call.call_id || call.call_id.length > 200)
            throw new Error("Invalid terminal presentation call ID.");
          if (call.name === "present_photos") {
            if (!visualizations || resumeQuestion)
              throw new Error("Photo presentation is not available for this reply.");
            if (
              Object.keys(publicAnswer).length !== 2 ||
              !Object.hasOwn(publicAnswer, "photoPresentation") ||
              typeof publicAnswer.message !== "string" ||
              !publicAnswer.message.trim() ||
              publicAnswer.message.length > 1000 ||
              /(?![\n\r\t])\p{Cc}/u.test(publicAnswer.message)
            )
              throw new Error("Present photos with only a short message and photoPresentation; no question, answers or measurement.");
            const photoSelection = await visualizations.validatePresentation(publicAnswer.photoPresentation);
            if (!photoSelection) throw new Error("A photo picker is required.");
            const answer = publicAnswer.message.trim();
            signal.throwIfAborted();
            appendInput({
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify({ displayed: true, photoPresentation: photoSelection }),
            });
            const contextCheckpoint = checkpoint(model);
            onText(answer);
            return {
              text: answer,
              model: completed.model,
              serviceTier: completed.service_tier ?? undefined,
              photoPresentation: { ...photoSelection, callId: call.call_id },
              ...(memoryUpdate ? { memoryUpdate } : {}),
              ...(contextCheckpoint ? { contextCheckpoint, requestedModel: model } : {}),
            };
          }
          const { message, productIds, ...selection } =
            call.name === "ask_measurement"
              ? parseMeasurementQuestionCall(publicAnswer)
              : parseQuestionCall(publicAnswer);
          if (!call.call_id || call.call_id.length > 200)
            throw new Error("Invalid question presentation call ID.");
          const selectedIds = productIds.length
            ? parseProductSelection({ productIds })
            : [];
          if (selectedIds.some((id) => !availableProducts.has(id)))
            throw new Error(
              "Select only product IDs verified by successful catalogue results in this turn.",
            );
          if (resumeQuestion && selectedIds.length)
            throw new Error(
              "A question resume cannot introduce product cards.",
            );
          const presentation: ProductPresentation | undefined =
            selectedIds.length
              ? {
                  callId: call.call_id,
                  productIds: selectedIds,
                  productRefs: selectedIds.map((id) => ({
                    id,
                    title: availableProducts.get(id)!,
                  })),
                }
              : undefined;
          if (
            resumeQuestion &&
            (selection.question !== resumeQuestion.question ||
              JSON.stringify(selection.answers) !==
                JSON.stringify(resumeQuestion.answers) ||
              JSON.stringify(selection.navigationActions ?? []) !==
                JSON.stringify(resumeQuestion.navigationActions ?? []) ||
              selection.measurement?.productPath !==
                resumeQuestion.measurement?.productPath ||
              selection.measurement?.label !==
                resumeQuestion.measurement?.label ||
              selection.measurement?.unit !== resumeQuestion.measurement?.unit)
          )
            throw new Error("Resume only the saved unanswered question.");
          const source = await guides.questionSource(
            selection.measurement?.productPath,
          );
          const spoken = [
            message,
            selection.measurement?.instructions,
            selection.question,
          ]
            .filter(Boolean)
            .join(" ");
          if (mode === "voice" && spoken.length > 1_000)
            throw new Error(
              "The complete spoken reply exceeds 1000 characters. Shorten message while preserving the exact question and all fit-critical instructions.",
            );
          const questionPresentation: QuestionPresentation = {
            callId: call.call_id,
            ...selection,
            ...source,
          };
          signal.throwIfAborted();
          const cachedGuideSource = guides.cachedSource();
          const answer = mode === "voice" ? spoken : message;
          appendInput({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              displayed: true,
              question: selection.question,
            }),
          });
          const contextCheckpoint = checkpoint(model);
          onText(answer);
          return {
            text: answer,
            model: completed.model,
            serviceTier: completed.service_tier ?? undefined,
            ...(presentation ? { presentation } : {}),
            questionPresentation,
            ...(cachedGuideSource ? { cachedGuideSource } : {}),
            ...(memoryUpdate ? { memoryUpdate } : {}),
            ...(contextCheckpoint
              ? { contextCheckpoint, requestedModel: model }
              : {}),
          };
        } catch (error) {
          signal.throwIfAborted();
          if (answerRepair)
            throw new Error(
              "Roman did not finish with a valid answer request.",
            );
          const recoverSource = error instanceof MissingMeasuringSourceError && !sourceRecovery;
          if (recoverSource) sourceRecovery = true;
          else answerRepair = true;
          onDiagnostic?.({ type: "repair", reason: recoverSource ? "missing_source" : error instanceof SyntaxError ? "invalid_json" : "terminal_validation" });
          appendInput({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({
              error:
                error instanceof SyntaxError
                  ? "Invalid answer request JSON."
                  : error instanceof Error
                    ? error.message
                    : "Invalid answer request.",
              instruction:
                recoverSource
                  ? "No answer was displayed. Read only the missing applicable guide evidence (at most two source operations), then finish with ask_question or ask_measurement. Research is already authorized. Preserve completed actions; do not repeat them. If no applicable source can be verified, explain the limitation without physical instructions."
                  : "No answer request was displayed. Correct it once. " + terminalRepairGuidance + " Keep the confirmed outcome in message. Do not repeat completed work; only an answer request is available.",
            }),
          });
          continue;
        }
      }
      if (answerRepair)
        throw new Error(
          "Only an answer request can repair the completed work's reply.",
        );
      if (sourceRecovery && (!isGuideTool(call.name) || sourceRecoveryReads >= 2))
        throw new Error("Only bounded missing-source reads can recover this answer.");
      if (call.name === "recall_history") {
        if (!recallHistory || ++recallCalls > 2)
          throw new Error(
            "Roman reached the history retrieval budget for this reply.",
          );
        const result = await recallHistory(
          parseRecallHistory(JSON.parse(call.arguments)),
          signal,
        );
        signal.throwIfAborted();
        appendInput({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
        continue;
      }
      if (isVisualizationTool(call.name)) {
        if (!visualizations)
          throw new Error("Photo tools are unavailable for this reply.");
        const result = await trackTool(call.name, () =>
          visualizations.execute(
            call.call_id,
            call.name,
            JSON.parse(call.arguments),
          ),
        );
        signal.throwIfAborted();
        appendInput({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
        continue;
      }
      if (!execute || !(withinToolBudget(call.name) || (sourceRecovery && isGuideTool(call.name) && sourceRecoveryReads < 2 && browserCalls < MAX_TURN_TOOL_CALLS)))
        throw new Error(
          "Roman reached the storefront tool limit for this reply.",
        );
      browserCalls++;
      if (isGuideTool(call.name)) {
        if (sourceRecovery) sourceRecoveryReads++;
        const result = await guides.read(call);
        if (result.resumeFailure)
          return {
            text: result.resumeFailure,
            model: completed.model,
            serviceTier: completed.service_tier ?? undefined,
          };
        appendInput({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result.output),
        });
        if (result.stopBatch) {
          for (const queued of toolCalls.slice(toolCalls.indexOf(call) + 1))
            appendInput({
              type: "function_call_output",
              call_id: queued.call_id,
              output: JSON.stringify({
                error:
                  "Not executed: the preceding guide read failed. Resolve relevant source evidence before continuing.",
              }),
            });
          continue replyRounds;
        }
        continue;
      }
      if (call.name === "navigate") guides.invalidateForNavigation();
      let outcome: ModelToolOutcome;
      try {
        const parsed = parseStorefrontCall(
          call.name,
          JSON.parse(call.arguments),
        );
        actions.before(parsed);
        signal.throwIfAborted();
        guides.beforeOperation();
        outcome = await trackTool(parsed.name, () =>
          execute(call.call_id, parsed.name, parsed.arguments),
        );
        signal.throwIfAborted();
        actions.after(parsed, outcome);
        if ("products" in outcome)
          for (const product of outcome.products)
            availableProducts.set(product.id, product.title);
      } catch {
        signal.throwIfAborted();
        actions.failed(call.name);
        outcome = {
          error:
            isCartMutation(call.name) ||
            call.name === "apply_measurements" ||
            call.name === "configure_product"
              ? "The storefront change was not confirmed. Do not claim it succeeded or repeat it automatically. Check the current cart/form and ask the shopper before requesting a new change."
              : call.name === "get_cart"
                ? "The current cart could not be read. Do not infer its contents or claim it is empty."
                : call.name === "get_measurements" ||
                    call.name === "set_measurements"
                  ? "The measurement draft could not be read or saved. Do not claim dimensions were saved or applied."
                  : call.name === "open_checkout"
                    ? "Checkout opening could not be confirmed. Do not claim it opened or retry automatically; show Roman's Cart and direct the customer to Continue to checkout."
                    : call.name === "show_view"
                      ? "Roman's requested view could not be confirmed. Do not claim the view changed or navigate the storefront as a substitute."
                      : call.name === "navigate"
                        ? "Storefront navigation could not be confirmed. Do not claim the page changed or repeat the navigation automatically."
                        : "The store lookup could not be completed. Do not claim product availability or invent the missing details.",
        };
      }

      const output = JSON.stringify(outcome);
      appendInput({
        type: "function_call_output",
        call_id: call.call_id,
        output,
      });
    }
  }
  throw new Error("Roman reached the tool limit for this reply.");
}
