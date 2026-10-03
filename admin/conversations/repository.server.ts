import { parseCheckoutCall, parseCheckoutResult, type CheckoutResult } from "../../shared/checkout";
import {
  parseGuideLibraryCall,
  parseGuideLibraryResult,
  type GuideLibraryResult,
} from "../../shared/guide-library";
import {
  parseStoreSupportCall,
  parseStoreSupportResult,
  type StoreSupportResult,
} from "../../shared/store-support";
import {
  parseLibrarySourceReceipt,
  readBoundLibrarySource,
  type BoundLibrarySource,
  type LibrarySourceReceipt,
} from "../guides/library.server";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  Conversation,
  ConversationMessage as StoredMessage,
  ToolInvocation as StoredTool,
  VoiceSession,
  VoiceTranscript,
  Prisma,
} from "@prisma/client";
import type {
  ConversationBootstrap,
  ConversationHistoryEntry,
  ConversationHistoryPage,
  ConversationCurrentState,
  ConversationMessage,
  ConversationSnapshot,
  SendMessageInput,
  ConversationPart,
  BrowserToolInvocation,
  BrowserToolName,
  JourneyInput,
  ToolClaim,
} from "../../shared/conversation";
import { CONVERSATION_HISTORY_PAGE_SIZE, MAX_MESSAGE_LENGTH, MAX_PRODUCT_CARDS } from "../../shared/conversation";
import {
  MAX_CATALOG_CANDIDATES,
  parseCatalogQueryOutcomes,
  assertCatalogQueryProvenance,
  type CatalogQueryOutcome,
} from "../../shared/catalog";
import { activeProduct } from "../../shared/active-product";
import {
  isQuestionAnswer,
  MAX_QUESTION_ANSWER_LENGTH,
  latestQuestion,
  parseQuestionAnswerReference,
  parseVoiceInputReference,
  parseQuestionPart,
  parseQuestionSelection,
  type QuestionSelection,
  type MeasurementQuestion,
  type VoiceSelectionInput,
} from "../../shared/questions";
import {
  parseProductChoiceReference,
  parseProductChoice,
  productChoiceText,
  type ProductChoice,
} from "../../shared/product-choice";
import { parseCatalogCall } from "../../shared/catalog-tools";
import {
  parseViewCall,
  parseViewResult,
  type ViewResult,
} from "../../shared/assistant-view";
import {
  parseNavigationCall,
  parseNavigationResult,
  parseNavigationPart,
  type NavigationResult,
} from "../../shared/navigation-tool";
import {
  isCartTool,
  isCartMutation,
  parseCartCall,
  parseCartAddedProduct,
  parseCartAddedSample,
  parseCartResult,
  interruptedCartResult,
  type CartToolResult,
} from "../../shared/cart-tools";
import {
  isProductConfigurationTool,
  parseProductConfigurationCall,
  parseProductConfigurationResult,
  type ConfigureProductResult,
  type ProductConfigurationResult,
} from "../../shared/product-configuration";
import {
  parseApplyMeasurementsCommand,
  parseApplyMeasurementsResult,
  type ApplyMeasurementsResult,
} from "../../shared/measurements";
import { isStorefrontPagePath } from "../../shared/journey";
import { projectConversationTimeline } from "../../shared/conversation-timeline";
import { parseVoiceEventPart, isVoiceCloseReason } from "../../shared/voice";
import {
  parseProductGuidesCall,
  parseProductGuidesResult,
  parseGuidePart,
  type ProductGuidesResult,
} from "../../shared/product-guides";
import {
  closeConversationVoiceSessions,
  expireVoiceSessions,
  expiredVoiceSessionWhere,
  recoverVoiceSessions,
} from "../voice/repository.server";
import prisma from "../db.server";
import {
  latestProductPage,
  productPagePath,
} from "../guides/product-page.server";
import { ConversationError } from "./errors.server";
import { PRIMARY_TEXT_MODEL } from "./availability.server";
import { MAX_TURN_TOOL_CALLS } from "./limits.server";
import type { ModelMessage } from "./history.server";
import { recallConversationHistory } from "./memory-history.server";
import {
  applyMemoryUpdate, memoryMessage, parseMemo, parseCheckpoint,
  parseMemoryUpdate, type MemoryUpdate, type ModelMemory, type ContextCheckpoint,
} from "./memory.server";
import {
  parseProductSelection,
  type ProductPresentation,
  type QuestionPresentation,
  type CachedGuideSource,
} from "./presentation.server";

const processStartedAt = new Date();
const credentialLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const creationWindowMs = 24 * 60 * 60 * 1000;
const maxDailyConversationsPerShop = 100;
const productIdPattern = /^gid:\/\/shopify\/Product\/\d+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoredConversation = Conversation & {
  messages: StoredMessage[];
  toolInvocations: StoredTool[];
  voiceSessions: VoiceSession[];
  voiceTranscripts: VoiceTranscript[];
};

function validProductIds(value: unknown, limit = MAX_PRODUCT_CARDS): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    new Set(value).size === value.length &&
    value.every(
      (id) =>
        typeof id === "string" && id.length <= 100 && productIdPattern.test(id),
    )
  );
}

function validProductRefs(
  value: unknown,
  productIds: string[],
): value is { id: string; title: string }[] {
  return (
    Array.isArray(value) &&
    value.length === productIds.length &&
    value.every(
      (ref, index) =>
        ref &&
        typeof ref === "object" &&
        !Array.isArray(ref) &&
        Object.keys(ref).length === 2 &&
        ref.id === productIds[index] &&
        typeof ref.title === "string" &&
        ref.title.length > 0 &&
        ref.title.length <= 200,
    )
  );
}

function parts(message: StoredMessage, origin: string): ConversationPart[] {
  const value: unknown = JSON.parse(message.partsJson);
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid stored conversation parts.");
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part))
      throw new Error("Invalid stored conversation part.");
    if (part.type === "text" && typeof part.text === "string") {
      if (Object.keys(part).length === 2) continue;
      if (
        message.role === "user" &&
        Object.keys(part).length === 3 &&
        part.questionAnswer !== undefined
      ) {
        parseQuestionAnswerReference(part.questionAnswer);
        continue;
      }
      if (
        message.role === "user" &&
        Object.keys(part).length === 3 &&
        part.productChoice !== undefined
      ) {
        parseProductChoiceReference(part.productChoice);
        continue;
      }
      if (
        message.role === "user" &&
        Object.keys(part).length === 3 &&
        part.voiceInput !== undefined
      ) {
        parseVoiceInputReference(part.voiceInput);
        continue;
      }
    }
    if (part.type === "guides") {
      parseGuidePart(part, origin);
      continue;
    }
    if (part.type === "question") {
      parseQuestionPart(part);
      continue;
    }
    if (part.type === "voice_event" && message.role === "context") {
      parseVoiceEventPart(part);
      continue;
    }
    if (part.type === "navigation") {
      parseNavigationPart(part);
      continue;
    }
    if (
      part.type === "cart_added" &&
      part.version === 1 &&
      typeof part.invocationId === "string" &&
      uuidPattern.test(part.invocationId) &&
      Object.keys(part).length === 4
    ) {
      parseCartAddedProduct(part.product);
      continue;
    }
    if (
      part.type === "cart_sample_added" &&
      part.version === 1 &&
      typeof part.invocationId === "string" &&
      uuidPattern.test(part.invocationId) &&
      Object.keys(part).length === 4
    ) {
      parseCartAddedSample(part.sample);
      continue;
    }
    if (
      part.type === "products" &&
      part.version === 1 &&
      typeof part.invocationId === "string" &&
      uuidPattern.test(part.invocationId) &&
      validProductIds(part.productIds) &&
      Object.keys(part).every((key) =>
        ["type", "version", "invocationId", "productIds", "productRefs", "voiceReply"].includes(key),
      ) &&
      (part.productRefs === undefined ||
        validProductRefs(part.productRefs, part.productIds)) &&
      (part.voiceReply === undefined ||
        (part.voiceReply &&
          typeof part.voiceReply === "object" &&
          Object.keys(part.voiceReply).length === 2 &&
          typeof part.voiceReply.voiceId === "string" &&
          uuidPattern.test(part.voiceReply.voiceId) &&
          Number.isSafeInteger(part.voiceReply.afterSequence) &&
          part.voiceReply.afterSequence >= 0))
    )
      continue;
    if (
      part.type === "page_view" &&
      part.version === 1 &&
      typeof part.title === "string" &&
      part.title.length <= 200 &&
      typeof part.path === "string" &&
      isStorefrontPagePath(part.path, origin) &&
      typeof part.occurredAt === "string" &&
      Number.isFinite(Date.parse(part.occurredAt)) &&
      Object.keys(part).length === 5
    )
      continue;
    throw new Error("Invalid stored conversation part.");
  }
  return value as ConversationPart[];
}

type StoredActionResult =
  CartToolResult | ApplyMeasurementsResult | ProductConfigurationResult;

function isStorefrontMutation(name: string) {
  return (
    isCartMutation(name) ||
    name === "apply_measurements" ||
    name === "configure_product"
  );
}

function storedBrowserCall(
  name: string,
  input: unknown,
): { name: BrowserToolName; arguments: Record<string, unknown> } {
  if (name === "navigate")
    return { name, arguments: parseNavigationCall(input) };
  if (name === "show_view") return { name, arguments: parseViewCall(input) };
  if (name === "open_checkout") return { name, arguments: parseCheckoutCall(input) };
  if (name === "get_product_guides")
    return { name, arguments: parseProductGuidesCall(input) };
  if (name === "discover_guides")
    return { name, arguments: parseGuideLibraryCall(input) };
  if (name === "get_store_support")
    return { name, arguments: parseStoreSupportCall(input) };
  if (name === "apply_measurements")
    return { name, arguments: { ...parseApplyMeasurementsCommand(input) } };
  if (isProductConfigurationTool(name))
    return parseProductConfigurationCall(name, input);
  return isCartTool(name)
    ? parseCartCall(name, input)
    : parseCatalogCall(name, input);
}

function storedActionResult(
  tool: StoredTool,
  input: unknown,
): StoredActionResult {
  if (isCartTool(tool.name)) {
    const result = parseCartResult(tool.name, input);
    if (
      tool.name === "add_to_cart" &&
      "addedProduct" in result &&
      result.addedProduct &&
      result.addedProduct.productPath !==
        parseCartCall(tool.name, JSON.parse(tool.argumentsJson)).arguments
          .productPath
    )
      throw new ConversationError(
        400,
        "The added product does not match the requested product page.",
      );
    if (
      tool.name === "add_sample_to_cart" &&
      "addedSample" in result &&
      result.addedSample &&
      result.addedSample.productPath !==
        parseCartCall(tool.name, JSON.parse(tool.argumentsJson)).arguments
          .productPath
    )
      throw new ConversationError(
        400,
        "The added sample does not match the requested product page.",
      );
    return result;
  }
  if (tool.name === "apply_measurements") {
    const result = parseApplyMeasurementsResult(input);
    const command = parseApplyMeasurementsCommand(
      JSON.parse(tool.argumentsJson),
    );
    if (
      result.productPath !== command.productPath ||
      result.draftUpdatedAt !== command.draft.updatedAt
    )
      throw new ConversationError(
        400,
        "The applied measurements do not match the reviewed draft.",
      );
    return result;
  }
  if (isProductConfigurationTool(tool.name)) {
    const result = parseProductConfigurationResult(tool.name, input);
    const call = parseProductConfigurationCall(
      tool.name,
      JSON.parse(tool.argumentsJson),
    );
    if (result.productPath !== call.arguments.productPath)
      throw new ConversationError(
        400,
        "The product configuration result does not match the requested product page.",
      );
    return result;
  }
  throw new ConversationError(400, "This tool cannot return an action result.");
}

function interruptedActionResult(
  tool: StoredTool,
  claimed: boolean,
): StoredActionResult | undefined {
  if (isCartMutation(tool.name)) return interruptedCartResult(claimed);
  if (tool.name === "apply_measurements") {
    const command = parseApplyMeasurementsCommand(
      JSON.parse(tool.argumentsJson),
    );
    return {
      status: claimed ? "uncertain" : "cancelled",
      productPath: command.productPath,
      draftUpdatedAt: command.draft.updatedAt,
      message: claimed
        ? "The product fields may have changed, but application was not confirmed. Check the form before requesting another change."
        : "This application did not start; Roman did not fill the product form.",
    };
  }
  if (tool.name === "configure_product") {
    const command = parseProductConfigurationCall(
      tool.name,
      JSON.parse(tool.argumentsJson),
    );
    return {
      status: claimed ? "uncertain" : "cancelled",
      productPath: command.arguments.productPath,
      message: claimed
        ? "The product option may have changed, but application was not confirmed. Check the form before requesting another change."
        : "This product option change did not start.",
    } satisfies ConfigureProductResult;
  }
}

function toolSnapshot(tool: StoredTool): BrowserToolInvocation {
  if (tool.status !== "pending" && tool.status !== "running")
    throw new Error("Invalid pending tool status.");
  const call = storedBrowserCall(tool.name, JSON.parse(tool.argumentsJson));
  return { id: tool.id, ...call, status: tool.status };
}

export function conversationEntries(
  conversation: Pick<StoredConversation, "origin" | "messages" | "voiceTranscripts">,
): ConversationHistoryEntry[] {
  const entries: ConversationHistoryEntry[] = conversation.messages.map((message) => {
    if (
      !["user", "assistant", "context"].includes(message.role) ||
      !["pending", "complete", "failed"].includes(message.status)
    ) {
      throw new Error("Invalid stored conversation message.");
    }
    return {
      sequence: message.sequence,
      message: {
        id: message.id,
        ...(message.role === "user" && uuidPattern.test(message.requestId)
          ? { requestId: message.requestId }
          : {}),
        role: message.role as ConversationMessage["role"],
        status: message.status as ConversationMessage["status"],
        parts: parts(message, conversation.origin),
        createdAt: message.createdAt.toISOString(),
        ...(message.error ? { error: message.error } : {}),
      } as ConversationMessage,
    };
  });

  for (const fragment of conversation.voiceTranscripts) {
    if (fragment.role !== "user" && fragment.role !== "assistant") throw new Error("Invalid stored voice caption role.");
    entries.push({ sequence: fragment.sequence, caption: { id: fragment.id, voiceId: fragment.voiceId, sequence: fragment.sequence, role: fragment.role, text: fragment.text, startMs: fragment.startMs, endMs: fragment.endMs, createdAt: fragment.createdAt.toISOString() } });
  }
  return entries.sort((left, right) => left.sequence - right.sequence);
}

export function conversationTimeline(
  conversation: Pick<StoredConversation, "origin" | "messages" | "voiceTranscripts">,
): ConversationMessage[] {
  return projectConversationTimeline(conversationEntries(conversation));
}

function snapshot(
  conversation: StoredConversation,
  current?: ConversationCurrentState,
): ConversationSnapshot {
  const entries = conversationEntries(conversation);
  const end = Math.max(conversation.nextSequence, (entries.at(-1)?.sequence ?? -1) + 1);
  const start = Math.max(0, end - CONVERSATION_HISTORY_PAGE_SIZE);
  const history: ConversationHistoryPage = {
    start,
    end,
    before: start || null,
    entries: entries.filter((entry) => entry.sequence >= start),
  };
  const messages = projectConversationTimeline(entries);
  const historyUpdates = conversationEntries({
    ...conversation,
    voiceTranscripts: [],
    messages: [...conversation.messages]
      .sort((left, right) =>
        (right.completedAt ?? right.createdAt).getTime() -
        (left.completedAt ?? left.createdAt).getTime())
      .slice(0, 8)
      .filter((message) => message.sequence < start),
  });
  // Retain the source rows used by existing question and page-grounding checks,
  // even when a long uninterrupted voice exchange has moved their page away.
  for (const type of ["navigation", "page_view", "question", "user", "pending"]) {
    const entry = [...entries].reverse().find((entry) => "message" in entry &&
      (type === "user" ? entry.message.role === "user" :
        type === "pending" ? entry.message.status === "pending" :
          entry.message.parts.some((part) => part.type === type)));
    if (entry && entry.sequence < start && !historyUpdates.some((update) => update.sequence === entry.sequence))
      historyUpdates.push(entry);
  }
  const voice =
    conversation.voiceSessions.find((session) =>
      ["starting", "active"].includes(session.status),
    ) ?? conversation.voiceSessions[0];
  if (
    voice &&
    !["starting", "active", "closed", "failed"].includes(voice.status)
  )
    throw new Error("Invalid stored voice status.");
  if (conversation.status !== "active" && conversation.status !== "ended")
    throw new Error("Invalid stored conversation status.");
  return {
    id: conversation.id,
    status: conversation.status,
    revision: conversation.revision,
    history,
    historyUpdates,
    current: current ?? {
      activeProduct: activeProduct({ status: conversation.status, messages }) ?? null,
      pendingQuestion: latestQuestion(messages) ?? null,
      hasCustomerReply: messages.some((message) => message.role === "user"),
    },
    messages: projectConversationTimeline([...historyUpdates, ...history.entries]).filter(
      (message) => message.parts.length > 0 || message.status === "failed",
    ),
    busy: messages.some((message) => message.status === "pending"),
    tools: conversation.toolInvocations
      .filter((tool) => tool.status === "pending" || tool.status === "running")
      .map(toolSnapshot),
    ...(voice
      ? {
          voice: {
            id: voice.id,
            clientId: voice.clientId,
            status: voice.status as "starting" | "active" | "closed" | "failed",
            ...(voice.error ? { error: voice.error } : {}),
            ...(isVoiceCloseReason(voice.closeReason) ? { closeReason: voice.closeReason } : {}),
          },
        }
      : {}),
  };
}

const withMessages = {
  messages: { orderBy: { sequence: "asc" as const } },
  toolInvocations: { orderBy: { createdAt: "asc" as const } },
  voiceSessions: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  },
};

async function loadConversation(
  transaction: Prisma.TransactionClient,
  id: string,
) {
  const conversation = await transaction.conversation.findUnique({
    where: { id },
    include: withMessages,
  });
  if (!conversation)
    throw new ConversationError(
      404,
      "This chat could not be found. Start a new chat.",
    );
  // Mutations retain every durable message/tool source for exact consent and
  // guide validation. Captions are needed only for the visible tail and the
  // latest customer speech that retires an older question, not a lifetime scan.
  // Query the relation directly: Prisma's nested take may fetch an unbounded
  // relation and trim in memory when it resolves parent rows separately.
  const [voiceTranscripts, customer] = await Promise.all([
    transaction.voiceTranscript.findMany({ where: { conversationId: id }, orderBy: { sequence: "desc" }, take: CONVERSATION_HISTORY_PAGE_SIZE }),
    transaction.voiceTranscript.findFirst({ where: { conversationId: id, role: "user" }, orderBy: { sequence: "desc" } }),
  ]);
  if (customer && !voiceTranscripts.some((row) => row.id === customer.id))
    voiceTranscripts.push(customer);
  voiceTranscripts.sort((left, right) => left.sequence - right.sequence);
  return { ...conversation, voiceTranscripts };
}

function requireActive(conversation: Conversation) {
  if (conversation.status !== "active")
    throw new ConversationError(
      409,
      "This chat has ended. Start a new chat to continue.",
    );
}

function modelHistory(conversation: StoredConversation, context?: Awaited<ReturnType<typeof getCurrentContext>>): ModelMessage[] {
  const timeline = conversationTimeline(conversation);
  const pageEpisodes: ConversationPart[] = [];
  let lastPageKey: string | undefined;
  let backgroundPage: { title: string; path: string } | undefined;
  for (const message of timeline) {
    if (message.status !== "complete") continue;
    for (const part of message.parts) {
      if (part.type !== "page_view" && part.type !== "navigation") continue;
      const key = JSON.stringify([part.path, part.title]);
      if (key !== lastPageKey) pageEpisodes.push(part);
      lastPageKey = key;
      backgroundPage = { title: part.title, path: part.path };
    }
  }
  // The tail state owns the current page; history keeps real prior transitions.
  const historicalPages = new Set(pageEpisodes.slice(0, -1));
  if (context) {
    backgroundPage = undefined;
    for (const message of conversationTimeline({ ...conversation, messages: context.messages, voiceTranscripts: context.voiceTranscripts }))
      for (const part of message.parts)
        if (part.type === "page_view" || part.type === "navigation")
          backgroundPage = { title: part.title, path: part.path };
  }
  const pending = context ? context.current.pendingQuestion ?? undefined : latestQuestion(timeline);
  const pendingQuestion: QuestionSelection | undefined = pending
    ? {
        question: pending.question,
        answers: pending.answers,
        ...(pending.measurement ? { measurement: pending.measurement } : {}),
      }
    : undefined;
  const recentCartResults = conversation.toolInvocations
    .filter(
      (tool) =>
        (isCartTool(tool.name) ||
          tool.name === "apply_measurements" ||
          isProductConfigurationTool(tool.name)) &&
        (tool.status === "complete" || tool.status === "failed"),
    )
    .slice(-8);
  const history: ModelMessage[] = timeline.flatMap((message) => {
    if (message.status === "pending") return [];
    const content = message.parts;
    const text = (message.status === "complete" ? content : [])
      .filter((part) => part.type === "text" || part.type === "voice")
      .map((part) => part.text)
      .join("\n");
    const observations = content.filter(
      // Cart outcomes already enter history through the bounded action results.
      (part) =>
        part.type !== "text" &&
        part.type !== "voice" &&
        part.type !== "voice_event" &&
        part.type !== "question" &&
        part.type !== "cart_added" &&
        part.type !== "cart_sample_added" &&
        ((part.type !== "page_view" && part.type !== "navigation") || historicalPages.has(part)),
    );
    const entries: ModelMessage[] = [
      ...(text
        ? [
            {
              role:
                message.role === "assistant"
                  ? ("assistant" as const)
                  : ("user" as const),
              text,
            },
          ]
        : []),
      ...(message.status === "complete" && message.role === "user"
        ? content.flatMap((part) =>
            part.type === "text" && part.productChoice
              ? [
                  {
                    role: "user" as const,
                    text: `Carousel choice: ${JSON.stringify({ productId: part.productChoice.productId, title: part.productChoice.title, productPath: part.productChoice.productPath })}`,
                  },
                ]
              : [],
          )
        : []),
      ...(observations.length
        ? [
            {
              role: "user" as const,
              text: `Storefront history: ${JSON.stringify(observations)}`,
            },
          ]
        : []),
      ...(message.status === "complete"
        ? content.flatMap((part) =>
            part.type === "question" && part.invocationId !== pending?.invocationId
              ? [
                  {
                    // Widgets are application context, not examples of prose
                    // for either model to imitate. Keep their reply provenance.
                    role: "user" as const,
                    source: "roman_question" as const,
                    text: `Roman question: ${JSON.stringify(
                      {
                        question: part.question,
                        answers: part.answers,
                        ...(part.measurement
                          ? { measurement: part.measurement }
                          : {}),
                      },
                    )}`,
                  },
                ]
              : [],
          )
        : []),
      ...recentCartResults
        .filter((tool) => tool.assistantId === message.id)
        .map((tool) => ({
          role: "user" as const,
          text: `Storefront action: ${JSON.stringify(
            {
              name: tool.name,
              arguments: storedBrowserCall(
                tool.name,
                JSON.parse(tool.argumentsJson),
              ).arguments,
              outcome: tool.resultJson
                ? storedActionResult(tool, JSON.parse(tool.resultJson))
                : {
                    error: tool.error ?? "The action result was not confirmed.",
                  },
              occurredAt: tool.completedAt?.toISOString(),
            },
          )}`,
        })),
    ];
    return entries.map((entry) => ({
      ...entry, sequence: message.sourceSequence, endSequence: message.sourceEndSequence,
    }));
  });
  const memo = memoryMessage(parseMemo(JSON.parse(conversation.memoJson)));
  if (memo) history.push(memo);
  const activeBlind = context ? context.current.activeProduct ?? undefined : activeProduct({
    status: conversation.status === "active" ? "active" : "ended",
    messages: timeline,
  });
  if (backgroundPage || activeBlind || pendingQuestion)
    history.push({
      role: "user",
      source: "application_state",
      ...(pendingQuestion ? { pendingQuestion } : {}),
      text: `Application state: ${JSON.stringify({
        activeBlind: activeBlind ?? null,
        backgroundPage: backgroundPage ?? null,
        pendingQuestion: pendingQuestion ?? null,
      })}`,
    });
  return history;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(): never {
  throw new ConversationError(
    401,
    "This chat has expired. Start a new chat to continue.",
  );
}

export function conversationApiBaseUrl(): string {
  const configuredUrl = process.env.SHOPIFY_APP_URL;
  if (!configuredUrl)
    throw new Error("SHOPIFY_APP_URL is required for storefront chat.");
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Storefront chat requires a public HTTPS SHOPIFY_APP_URL.");
  }
  return `${url.origin}/api/conversations`;
}

export async function createConversation(
  shop: string,
  origin: string,
): Promise<ConversationBootstrap> {
  const apiBaseUrl = conversationApiBaseUrl();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const conversation = await prisma.$transaction(async (transaction) => {
    const recentCount = await transaction.conversation.count({
      where: {
        shop,
        createdAt: { gte: new Date(now.getTime() - creationWindowMs) },
      },
    });
    if (recentCount >= maxDailyConversationsPerShop) {
      throw new ConversationError(
        429,
        "The daily chat limit has been reached. Please try again tomorrow.",
      );
    }
    return transaction.conversation.create({
      data: {
        id: randomUUID(),
        shop,
        origin,
        credentialHash: tokenHash(token),
        credentialExpiresAt: new Date(now.getTime() + credentialLifetimeMs),
      },
      include: { ...withMessages, voiceTranscripts: true },
    });
  });
  return {
    conversationId: conversation.id,
    token,
    expiresAt: conversation.credentialExpiresAt.toISOString(),
    apiBaseUrl,
    conversation: snapshot(conversation),
  };
}

export async function authorizeCredential(id: string, token: string) {
  if (!uuidPattern.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
    unauthorized();
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      origin: true,
      credentialHash: true,
      credentialExpiresAt: true,
    },
  });
  const suppliedHash = Buffer.from(tokenHash(token), "hex");
  const expectedHash = Buffer.from(
    conversation?.credentialHash ?? "0".repeat(64),
    "hex",
  );
  if (
    expectedHash.length !== suppliedHash.length ||
    !timingSafeEqual(expectedHash, suppliedHash) ||
    !conversation ||
    conversation.credentialExpiresAt.getTime() <= Date.now()
  )
    unauthorized();
  const installation = await prisma.session.findFirst({
    where: { shop: conversation.shop, isOnline: false },
    select: { accessToken: true, scope: true },
  });
  if (
    !installation?.accessToken ||
    !installation.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("write_app_proxy")
  )
    unauthorized();
  // Active customers renew the existing bearer; expiry remains an idle-session
  // authorization boundary, not a lifetime conversation limit. Write at most daily.
  let expiresAt = conversation.credentialExpiresAt;
  if (expiresAt.getTime() < Date.now() + 24 * 60 * 60 * 1000) {
    expiresAt = new Date(Date.now() + credentialLifetimeMs);
    await prisma.conversation.update({ where: { id }, data: { credentialExpiresAt: expiresAt } });
  }
  return {
    id: conversation.id,
    shop: conversation.shop,
    origin: conversation.origin,
    expiresAt,
  };
}

export async function getSnapshot(id: string): Promise<ConversationSnapshot> {
  await recoverVoiceSessions(id);
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.findUnique({ where: { id } });
    if (!conversation) throw new ConversationError(404, "This chat could not be found. Start a new chat.");
    const context = await getCurrentContext(id, transaction);
    const start = Math.max(0, conversation.nextSequence - CONVERSATION_HISTORY_PAGE_SIZE);
    const [messages, recentResults, pending, voiceTranscripts, toolInvocations, voiceSessions] = await Promise.all([
      transaction.conversationMessage.findMany({ where: { conversationId: id, sequence: { gte: start } }, orderBy: { sequence: "asc" }, take: CONVERSATION_HISTORY_PAGE_SIZE }),
      transaction.conversationMessage.findMany({ where: { conversationId: id, completedAt: { not: null }, sequence: { lt: start } }, orderBy: [{ completedAt: "desc" }, { sequence: "desc" }], take: 8 }),
      transaction.conversationMessage.findMany({ where: { conversationId: id, status: "pending" }, take: 2 }),
      transaction.voiceTranscript.findMany({ where: { conversationId: id, sequence: { gte: start } }, orderBy: { sequence: "asc" }, take: CONVERSATION_HISTORY_PAGE_SIZE }),
      transaction.toolInvocation.findMany({ where: { conversationId: id, status: { in: ["pending", "running"] } }, orderBy: { createdAt: "asc" }, take: MAX_TURN_TOOL_CALLS }),
      Promise.all([
        transaction.voiceSession.findMany({ where: { conversationId: id, status: { in: ["starting", "active"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
        transaction.voiceSession.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
      ]).then(([active, latest]) => [...new Map([...active, ...latest].map((voice) => [voice.id, voice])).values()]),
    ]);
    return snapshot({
      ...conversation,
      messages: [...new Map([...messages, ...recentResults, ...pending, ...context.messages].map((message) => [message.id, message])).values()].sort((left, right) => left.sequence - right.sequence),
      voiceTranscripts,
      toolInvocations,
      voiceSessions,
    }, context.current);
  });
}

/** Current facts remain independent of whichever transcript pages are loaded. */
export async function getCurrentContext(id: string, transaction: Prisma.TransactionClient = prisma) {
  const where = { conversationId: id, status: "complete" };
  const [navigation, page, question, customer, caption] = await Promise.all([
    transaction.conversationMessage.findFirst({ where: { ...where, partsJson: { contains: '"type":"navigation"' } }, orderBy: { sequence: "desc" } }),
    transaction.conversationMessage.findFirst({ where: { ...where, OR: [{ partsJson: { contains: '"type":"navigation"' } }, { partsJson: { contains: '"type":"page_view"' } }] }, orderBy: { sequence: "desc" } }),
    transaction.conversationMessage.findFirst({ where: { ...where, partsJson: { contains: '"type":"question"' } }, orderBy: { sequence: "desc" } }),
    transaction.conversationMessage.findFirst({ where: { conversationId: id, role: "user" }, orderBy: { sequence: "desc" } }),
    transaction.voiceTranscript.findFirst({ where: { conversationId: id, role: "user" }, orderBy: { sequence: "desc" } }),
  ]);
  const conversation = await transaction.conversation.findUniqueOrThrow({ where: { id }, select: { origin: true, status: true } });
  const messages = [...new Map([navigation, page, question, customer].filter((value): value is StoredMessage => value !== null).map((message) => [message.id, message])).values()].sort((left, right) => left.sequence - right.sequence);
  const voiceTranscripts = caption ? [caption] : [];
  const timeline = conversationTimeline({ ...conversation, messages, voiceTranscripts });
  return {
    messages,
    voiceTranscripts,
    current: {
      activeProduct: activeProduct({ status: conversation.status === "active" ? "active" : "ended", messages: timeline }) ?? null,
      pendingQuestion: latestQuestion(timeline) ?? null,
      hasCustomerReply: !!customer || !!caption,
    } satisfies ConversationCurrentState,
    backgroundPage: latestProductPage(timeline),
  };
}

/** A stable exclusive sequence cursor never changes when new turns arrive. */
export async function getHistoryPage(id: string, before: number) {
  if (!Number.isSafeInteger(before) || before <= 0)
    throw new ConversationError(400, "Send a valid history cursor.");
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.findUnique({ where: { id } });
    if (!conversation) throw new ConversationError(404, "This chat could not be found. Start a new chat.");
    if (before > conversation.nextSequence) throw new ConversationError(400, "The history cursor is ahead of this conversation.");
    const start = Math.max(0, before - CONVERSATION_HISTORY_PAGE_SIZE);
    const range = { conversationId: id, sequence: { gte: start, lt: before } };
    const [messages, voiceTranscripts] = await Promise.all([
      transaction.conversationMessage.findMany({ where: range, orderBy: { sequence: "asc" }, take: CONVERSATION_HISTORY_PAGE_SIZE }),
      transaction.voiceTranscript.findMany({ where: range, orderBy: { sequence: "asc" }, take: CONVERSATION_HISTORY_PAGE_SIZE }),
    ]);
    return { id, revision: conversation.revision, history: {
      start,
      end: before,
      before: start || null,
      entries: conversationEntries({ ...conversation, messages, voiceTranscripts }),
    } satisfies ConversationHistoryPage };
  });
}

/** Probe only revision/recovery metadata before loading any transcript history. */
export async function getReadRevision(id: string, recoverPending: boolean) {
  const current = await prisma.conversation.findUnique({
    where: { id },
    select: {
      revision: true,
      messages: {
        where: abandonedReplyWhere,
        take: 1,
        select: { id: true },
      },
      voiceSessions: {
        where: expiredVoiceSessionWhere(),
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!current)
    throw new ConversationError(
      404,
      "This chat could not be found. Start a new chat.",
    );
  const staleReply = recoverPending && current.messages.length > 0;
  const staleVoice = current.voiceSessions.length > 0;
  if (!staleReply && !staleVoice) return current.revision;
  if (staleReply) await failPending(id);
  if (staleVoice) await recoverVoiceSessions(id);
  return (
    await prisma.conversation.findUniqueOrThrow({
      where: { id },
      select: { revision: true },
    })
  ).revision;
}

/** A model's own checkpoint is the only authority to omit its older raw input. */
async function readModelHistory(
  transaction: Prisma.TransactionClient,
  conversation: Conversation,
  context: Awaited<ReturnType<typeof getCurrentContext>>,
  throughSequence: number,
  afterSequence = -1,
) {
  const sequence = { gt: afterSequence, lte: throughSequence };
  const [messages, voiceTranscripts, toolInvocations] = await Promise.all([
    transaction.conversationMessage.findMany({ where: { conversationId: conversation.id, sequence }, orderBy: { sequence: "asc" } }),
    transaction.voiceTranscript.findMany({ where: { conversationId: conversation.id, sequence }, orderBy: { sequence: "asc" } }),
    transaction.toolInvocation.findMany({ where: { conversationId: conversation.id, assistant: { sequence } }, orderBy: { createdAt: "asc" } }),
  ]);
  return modelHistory({ ...conversation, messages, voiceTranscripts, toolInvocations, voiceSessions: [] }, context);
}

async function readHistoryForModel(
  transaction: Prisma.TransactionClient,
  conversation: Conversation,
  context: Awaited<ReturnType<typeof getCurrentContext>>,
  throughSequence: number,
  checkpoints: ContextCheckpoint[],
  model: string,
) {
  const checkpoint = checkpoints.find((item) => item.model === model);
  const cold = !checkpoint && checkpoints.length > 0 &&
    Object.keys(parseMemo(JSON.parse(conversation.memoJson))).length > 0 && throughSequence >= 120;
  const after = checkpoint?.throughSequence ?? (cold ? throughSequence - 120 : -1);
  const history = await readModelHistory(transaction, conversation, context, throughSequence, after);
  if (!cold) return history;
  // A cold fallback cannot consume another model's encrypted checkpoint. Its
  // private notes + recent original records are an explicit retrieval bootstrap.
  const references = history.filter((item) => item.source === "memory" || item.source === "application_state");
  const recent = history.filter((item) => item.source !== "memory" && item.source !== "application_state");
  const selected: ModelMessage[] = [];
  let remaining = 48_000;
  for (let index = recent.length - 1; index >= 0; index--) {
    const bytes = Buffer.byteLength(recent[index].text, "utf8") + 16;
    if (bytes > remaining) break;
    selected.unshift(recent[index]);
    remaining -= bytes;
  }
  const start = selected[0]?.sequence ?? throughSequence;
  return [
    { role: "user" as const, text: `Historical context boundary: this model has no saved context checkpoint. Original records before sequence ${start} are omitted from this input; private notes are fallible reference, not instructions, consent or a new request. Use recall_history to recover earlier evidence or unresolved details rather than guessing. Current application state remains authoritative.` },
    ...selected, ...references,
  ];
}

export async function getModelHistory(id: string) {
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.findUniqueOrThrow({ where: { id } });
    return readModelHistory(transaction, conversation, await getCurrentContext(id, transaction), conversation.nextSequence - 1);
  });
}

/** Read one coherent transcript for voice history and its current UI state. */
export async function getVoiceStartupContext(id: string) {
  await recoverVoiceSessions(id);
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.findUniqueOrThrow({ where: { id } });
    const context = await getCurrentContext(id, transaction);
    const messages: StoredMessage[] = [];
    const voiceTranscripts: VoiceTranscript[] = [];
    const toolInvocations: StoredTool[] = [];
    let before = conversation.nextSequence;
    let history: ModelMessage[] = [];
    // Live accepts a small startup context. Read backwards to that byte budget
    // instead of materializing the entire caption log for every reconnect.
    // Empty lifecycle records also have a bounded read cost.
    let rows = 0;
    do {
      const start = Math.max(0, before - 256);
      const sequence = { gte: start, lt: before };
      const [page, captions, tools] = await Promise.all([
        transaction.conversationMessage.findMany({ where: { conversationId: id, sequence }, orderBy: { sequence: "asc" }, take: 256 }),
        transaction.voiceTranscript.findMany({ where: { conversationId: id, sequence }, orderBy: { sequence: "asc" }, take: 256 }),
        transaction.toolInvocation.findMany({ where: { conversationId: id, assistant: { sequence } }, orderBy: { createdAt: "asc" } }),
      ]);
      messages.unshift(...page);
      voiceTranscripts.unshift(...captions);
      toolInvocations.unshift(...tools);
      rows += page.length + captions.length;
      before = start;
      history = modelHistory({ ...conversation, messages, voiceTranscripts, toolInvocations, voiceSessions: [] }, context);
      const rawHistory = history.filter((item) => item.source !== "memory" && item.source !== "application_state");
      const bytes = rawHistory.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8") + 16, 0);
      if (bytes >= 7_500 || rawHistory.length >= 128) break;
    } while (before > 0 && rows < 8_192);
    if (before > 0) {
      // A range can start in the middle of an utterance. Do not present that
      // fragment as a complete historical request; current facts are separate.
      const first = history.find((item) => item.sequence !== undefined);
      if (first && voiceTranscripts.some((caption) => caption.sequence === first.sequence))
        history = history.filter((item) => item !== first);
      history.unshift({ role: "user", text: "Context boundary: earlier conversation is omitted from this voice connection. Private notes and current application state are historical reference; no earlier action or request is newly authorized." });
    }
    const currentTimeline = conversationTimeline({ ...conversation, messages: context.messages, voiceTranscripts: context.voiceTranscripts });
    return {
      history,
      pendingQuestion: context.current.pendingQuestion ?? undefined,
      lastPage: currentTimeline.flatMap((message) => message.parts)
        .filter((part) => part.type === "page_view" || part.type === "navigation").at(-1)?.path,
    };
  });
}

type VoiceQuestionAnswerInput = VoiceSelectionInput;

export interface VoiceQuestionAnswerReceipt {
  created: boolean;
  messageId: string;
  sequence: number;
  question: string;
  answer: string;
  productChoice?: ProductChoice;
  customerText?: string;
  measurement?: MeasurementQuestion;
}

function validateVoiceQuestionAnswer(
  id: string,
  voiceId: string,
  input: VoiceQuestionAnswerInput,
) {
  if (
    typeof id !== "string" ||
    !uuidPattern.test(id) ||
    typeof voiceId !== "string" ||
    !uuidPattern.test(voiceId) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.clientId !== "string" ||
    !uuidPattern.test(input.clientId) ||
    typeof input.requestId !== "string" ||
    !uuidPattern.test(input.requestId)
  )
    throw new ConversationError(
      400,
      "Choose a valid answer to Roman's question.",
    );
  try {
    if ("carouselId" in input) {
      if (Object.keys(input).length !== 6)
        throw new Error("Invalid product selection.");
      parseProductChoice({
        carouselId: input.carouselId,
        productId: input.productId,
        title: input.title,
        productPath: input.productPath,
      });
    } else if ("text" in input) {
      if (
        Object.keys(input).length !== 3 ||
        typeof input.text !== "string" ||
        !input.text.trim() ||
        input.text.length > MAX_MESSAGE_LENGTH
      )
        throw new Error("Invalid customer message.");
    } else if (
      Object.keys(input).length !== 4 ||
      typeof input.questionId !== "string" ||
      !uuidPattern.test(input.questionId) ||
      typeof input.answer !== "string" ||
      !input.answer.trim() ||
      input.answer.length > MAX_QUESTION_ANSWER_LENGTH
    )
      throw new Error("Invalid selected answer.");
  } catch {
    throw new ConversationError(
      400,
      "Send a valid message, offered answer or carousel product.",
    );
  }
  return "text" in input ? { ...input, text: input.text.trim() } : input;
}

function selectedCarouselProduct(
  conversation: StoredConversation,
  input: ProductChoice,
): ProductChoice {
  const found = conversation.messages.some(
    (message) =>
      message.status === "complete" &&
      ["assistant", "context"].includes(message.role) &&
      parts(message, conversation.origin).some(
        (part) =>
          part.type === "products" &&
          part.invocationId === input.carouselId &&
          part.productIds.includes(input.productId),
      ),
  );
  if (!found)
    throw new ConversationError(
      409,
      "Choose a product shown in this conversation's carousel.",
    );
  const { carouselId, productId, title, productPath } = input;
  return { carouselId, productId, title, productPath };
}

async function voiceQuestionAnswerReceipt(
  transaction: Prisma.TransactionClient,
  conversation: StoredConversation,
  voiceId: string,
  input: VoiceQuestionAnswerInput,
): Promise<VoiceQuestionAnswerReceipt | null> {
  if (
    !conversation.voiceSessions.some(
      (session) =>
        session.id === voiceId && session.clientId === input.clientId,
    )
  )
    throw new ConversationError(404, "This voice session could not be found.");
  const existing = await transaction.conversationMessage.findUnique({
    where: { id: input.requestId },
  });
  const sameRequest = conversation.messages.find(
    (message) => message.requestId === input.requestId,
  );
  if (!existing && !sameRequest) return null;
  const saved =
    existing?.conversationId === conversation.id &&
    existing.role === "user" &&
    existing.status === "complete" &&
    existing.requestId === input.requestId
      ? parts(existing, conversation.origin)
      : [];
  const part = saved[0];
  if ("text" in input) {
    if (
      !existing ||
      saved.length !== 1 ||
      part?.type !== "text" ||
      part.text !== input.text ||
      part.voiceInput?.voiceId !== voiceId
    )
      throw new ConversationError(
        400,
        "This request ID was already used for a different message.",
      );
    return {
      created: false,
      messageId: existing.id,
      sequence: existing.sequence,
      question: "",
      answer: part.text,
      customerText: part.text,
    };
  }
  if ("carouselId" in input) {
    const choice = selectedCarouselProduct(conversation, input);
    if (
      !existing ||
      saved.length !== 1 ||
      part?.type !== "text" ||
      JSON.stringify(part.productChoice) !==
        JSON.stringify({ ...choice, voiceId })
    )
      throw new ConversationError(
        400,
        "This request ID was already used for a different selection.",
      );
    return {
      created: false,
      messageId: existing.id,
      sequence: existing.sequence,
      question: "",
      answer: part.text,
      productChoice: choice,
    };
  }
  if (
    !existing ||
    saved.length !== 1 ||
    part?.type !== "text" ||
    part.text !== input.answer ||
    part.questionAnswer?.questionId !== input.questionId ||
    part.questionAnswer.voiceId !== voiceId
  )
    throw new ConversationError(
      400,
      "This request ID was already used for a different answer.",
    );
  const question = conversation.messages
    .flatMap((message) => parts(message, conversation.origin))
    .find(
      (part) =>
        part.type === "question" && part.invocationId === input.questionId,
    );
  if (
    question?.type !== "question" ||
    !isQuestionAnswer(question, input.answer)
  )
    throw new Error("The saved answer has no matching question.");
  return {
    created: false,
    messageId: existing.id,
    sequence: existing.sequence,
    question: question.question,
    answer: part.text,
    ...(question.measurement ? { measurement: question.measurement } : {}),
  };
}

/** Durable receipts remain readable after voice stops; they never authorize another cue. */
export async function findVoiceQuestionAnswer(
  id: string,
  voiceId: string,
  input: VoiceQuestionAnswerInput,
): Promise<VoiceQuestionAnswerReceipt | null> {
  input = validateVoiceQuestionAnswer(id, voiceId, input);
  return voiceQuestionAnswerReceipt(
    prisma,
    await loadConversation(prisma, id),
    voiceId,
    input,
  );
}

/** Persist voice-connected customer input without creating a Terra reply or caption. */
export async function appendVoiceQuestionAnswer(
  id: string,
  voiceId: string,
  input: VoiceQuestionAnswerInput,
): Promise<VoiceQuestionAnswerReceipt> {
  input = validateVoiceQuestionAnswer(id, voiceId, input);
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    const receipt = await voiceQuestionAnswerReceipt(
      transaction,
      conversation,
      voiceId,
      input,
    );
    if (receipt) return receipt;
    requireActive(conversation);
    const session = conversation.voiceSessions.find(
      (session) => session.id === voiceId,
    )!;
    const now = new Date();
    if (
      session.status !== "active" ||
      session.leaseExpiresAt <= now ||
      session.createdAt < processStartedAt
    )
      throw new ConversationError(
        409,
        "Voice has ended. Start voice again before choosing an answer.",
      );
    if (
      conversation.pendingRequestId ||
      conversation.messages.some((message) => message.status === "pending")
    )
      throw new ConversationError(
        409,
        "Wait for Roman's current reply before choosing an answer.",
      );
    const choice =
      "carouselId" in input
        ? selectedCarouselProduct(conversation, input)
        : undefined;
    const question = latestQuestion(conversationTimeline(conversation));
    if (
      "questionId" in input &&
      (question?.invocationId !== input.questionId ||
        !isQuestionAnswer(question, input.answer))
    )
      throw new ConversationError(
        409,
        "This question is no longer waiting for that answer.",
      );
    const selected = await transaction.conversation.updateMany({
      where: {
        id,
        status: "active",
        pendingRequestId: null,
        nextSequence: conversation.nextSequence,
      },
      data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
    });
    if (!selected.count)
      throw new ConversationError(
        409,
        "This question changed while your answer was being saved. Refresh the chat.",
      );
    await transaction.conversationMessage.create({
      data: {
        id: input.requestId,
        conversationId: id,
        requestId: input.requestId,
        sequence: conversation.nextSequence,
        role: "user",
        status: "complete",
        partsJson: JSON.stringify([
          {
            type: "text",
            text:
              "text" in input
                ? input.text
                : "carouselId" in input
                  ? productChoiceText(input)
                  : input.answer,
            ...("carouselId" in input
              ? { productChoice: { ...choice, voiceId } }
              : "text" in input
                ? { voiceInput: { voiceId } }
                : {
                    questionAnswer: { questionId: input.questionId, voiceId },
                  }),
          },
        ]),
        createdAt: now,
        completedAt: now,
      },
    });
    return {
      created: true,
      messageId: input.requestId,
      sequence: conversation.nextSequence,
      question: "questionId" in input ? (question?.question ?? "") : "",
      answer:
        "text" in input
          ? input.text
          : "carouselId" in input
            ? productChoiceText(input)
            : input.answer,
      ...(choice ? { productChoice: choice } : {}),
      ...("text" in input ? { customerText: input.text } : {}),
      ...("questionId" in input && question?.measurement
        ? { measurement: question.measurement }
        : {}),
    };
  });
}

export async function getBrowserToolContext(id: string, invocationId: string) {
  const conversation = await loadConversation(prisma, id);
  const tool = invocation(conversation, invocationId);
  if (
    !isCartTool(tool.name) &&
    ![
      "navigate",
      "show_view",
      "open_checkout",
      "search_products",
      "get_product",
      "lookup_catalog",
      "apply_measurements",
      "get_product_configuration",
      "configure_product",
      "get_product_guides",
      "discover_guides",
      "get_store_support",
    ].includes(tool.name)
  )
    throw new ConversationError(400, "This invocation is not a browser tool.");
  const call = storedBrowserCall(tool.name, JSON.parse(tool.argumentsJson));
  return { origin: conversation.origin, ...call };
}

export async function beginTurn(
  id: string,
  input: SendMessageInput,
  voiceId?: string,
  resumeQuestionId?: string,
): Promise<{
  snapshot: ConversationSnapshot;
  assistantId: string | null;
  history: ModelMessage[];
  memory?: ModelMemory;
  origin: string;
}> {
  if (
    !uuidPattern.test(input.requestId) ||
    (!voiceId && !input.text.trim()) ||
    (voiceId !== undefined && !uuidPattern.test(voiceId)) ||
    (resumeQuestionId !== undefined &&
      (!voiceId || !uuidPattern.test(resumeQuestionId))) ||
    input.text.length > MAX_MESSAGE_LENGTH
  ) {
    throw new ConversationError(
      400,
      "Send a message of up to 4,000 characters with a valid request ID.",
    );
  }
  let selectedProduct: ProductChoice | undefined;
  if (input.productChoice !== undefined) {
    try {
      selectedProduct = parseProductChoice(input.productChoice);
      if (voiceId || input.text !== productChoiceText(selectedProduct))
        throw new Error();
    } catch {
      throw new ConversationError(
        400,
        "Send a valid carousel choice and its matching message.",
      );
    }
  }
  return prisma.$transaction(async (transaction) => {
    await expireVoiceSessions(transaction, id);
    const conversation = await loadConversation(transaction, id);
    requireActive(conversation);
    const choice = selectedProduct
      ? selectedCarouselProduct(conversation, selectedProduct)
      : undefined;
    const userParts = [
      {
        type: "text",
        text: input.text,
        ...(choice ? { productChoice: choice } : {}),
      },
    ];
    if (
      resumeQuestionId !== undefined &&
      latestQuestion(conversationTimeline(conversation))?.invocationId !==
        resumeQuestionId
    )
      return {
        snapshot: snapshot(conversation),
        assistantId: null,
        history: [],
        origin: conversation.origin,
      };
    const existing = conversation.messages.find(
      (message) =>
        message.requestId === input.requestId &&
        message.role === (voiceId ? "context" : "user"),
    );
    if (existing) {
      if (!voiceId && existing.partsJson !== JSON.stringify(userParts))
        throw new ConversationError(
          400,
          "This request ID was already used for a different message.",
        );
      return {
        snapshot: snapshot(conversation),
        assistantId: null,
        history: [],
        origin: conversation.origin,
      };
    }
    if (
      conversation.pendingRequestId ||
      conversation.messages.some((message) => message.status === "pending")
    ) {
      throw new ConversationError(
        409,
        "Roman is still replying. Wait for that reply before sending another message.",
      );
    }
    const voice = conversation.voiceSessions.find((session) =>
      ["starting", "active"].includes(session.status),
    );
    if (voiceId ? voice?.id !== voiceId : !!voice)
      throw new ConversationError(
        409,
        voiceId
          ? "This voice session has ended."
          : "Switch to text before sending a typed message.",
      );
    const claimed = await transaction.conversation.updateMany({
      where: {
        id,
        status: "active",
        pendingRequestId: null,
        nextSequence: conversation.nextSequence,
      },
      data: {
        pendingRequestId: input.requestId,
        turnCount: { increment: 1 },
        nextSequence: { increment: voiceId ? 1 : 2 },
        revision: { increment: 1 },
      },
    });
    if (!claimed.count)
      throw new ConversationError(
        409,
        "Roman is still replying. Wait for that reply before sending another message.",
      );
    const assistantId = randomUUID();
    const now = new Date();
    await transaction.conversationMessage.createMany({
      data: [
        ...(voiceId
          ? []
          : [
              {
                id: randomUUID(),
                conversationId: id,
                requestId: input.requestId,
                sequence: conversation.nextSequence,
                role: "user",
                status: "complete",
                partsJson: JSON.stringify(userParts),
                createdAt: now,
                completedAt: now,
              },
            ]),
        {
          id: assistantId,
          conversationId: id,
          requestId: input.requestId,
          sequence: conversation.nextSequence + (voiceId ? 0 : 1),
          role: voiceId ? "context" : "assistant",
          status: "pending",
          partsJson: JSON.stringify(
            voiceId ? [] : [{ type: "text", text: "" }],
          ),
          createdAt: now,
        },
      ],
    });
    const updated = await loadConversation(transaction, id);
    const context = await getCurrentContext(id, transaction);
    const throughSequence = updated.nextSequence - 1;
    const checkpoints = (await transaction.conversationContext.findMany({ where: { conversationId: id } }))
      .map((checkpoint) => parseCheckpoint({ model: checkpoint.model, throughSequence: checkpoint.throughSequence, input: JSON.parse(checkpoint.inputJson) }));
    const history = await readHistoryForModel(transaction, updated, context, throughSequence, checkpoints, PRIMARY_TEXT_MODEL);
    return {
      snapshot: snapshot(updated),
      assistantId,
      history,
      memory: {
        recall: (input, signal) => recallConversationHistory(id, input, signal),
        memo: parseMemo(JSON.parse(updated.memoJson)),
        throughSequence,
        checkpoints,
        historyForModel: (model) => model === PRIMARY_TEXT_MODEL ? Promise.resolve(history) :
          readHistoryForModel(prisma, updated, context, throughSequence, checkpoints, model),
      },
      origin: updated.origin,
    };
  });
}

function validateLibraryMeasurementSource(
  conversation: StoredConversation,
  assistantId: string,
  sourceCallId: string | undefined,
  productPath: string,
  bound: BoundLibrarySource,
): void {
  const source = parseLibrarySourceReceipt(bound.source);
  const page = latestProductPage(conversationTimeline(conversation));
  const cached = readBoundLibrarySource(
    conversation.id,
    conversation.origin,
    page,
  );
  if (
    Object.keys(bound).length !== 3 ||
    !page ||
    bound.productPath !== productPath ||
    page.productPath !== productPath ||
    page.pageId !== bound.pageId ||
    sourceCallId !== source.sourceCallId ||
    !cached ||
    JSON.stringify(cached) !== JSON.stringify(bound)
  )
    throw new ConversationError(
      400,
      "The library measurement source is no longer valid for this product.",
    );
  verifiedLibrarySource(conversation, assistantId, source);
}

function verifiedLibrarySource(
  conversation: StoredConversation,
  assistantId: string,
  source: LibrarySourceReceipt,
): GuideLibraryResult {
  const original = conversation.messages.find(
    (message) => message.id === source.sourceAssistantId,
  );
  const tool = conversation.toolInvocations.find(
    (entry) =>
      entry.assistantId === source.sourceAssistantId &&
      entry.providerCallId === source.sourceCallId &&
      entry.name === "discover_guides" &&
      entry.status === "complete" &&
      !entry.error &&
      entry.resultJson,
  );
  if (
    !tool?.resultJson ||
    !original ||
    (original.id !== assistantId && original.status !== "complete") ||
    !["assistant", "context"].includes(original.role)
  )
    throw new ConversationError(400, "A verified library source is required.");
  const found = parseGuideLibraryResult(
    JSON.parse(tool.resultJson),
    conversation.origin,
  );
  if (
    found.library !== source.library ||
    found.pagePath !== source.pagePath ||
    parseGuideLibraryCall(JSON.parse(tool.argumentsJson)).library !==
      source.library ||
    source.guideIds.some((id) => !found.guides.some((guide) => guide.id === id))
  )
    throw new ConversationError(
      400,
      "The library source belongs to another discovery.",
    );
  return found;
}

function guideSourceResult(
  conversation: StoredConversation,
  assistantId: string,
  sourceCallId: string | undefined,
  productPath: string,
  cached?: CachedGuideSource,
): ProductGuidesResult {
  const eligible = (tool: StoredTool) =>
    tool.providerCallId === sourceCallId &&
    tool.name === "get_product_guides" &&
    tool.status === "complete" &&
    !tool.error &&
    !!tool.resultJson;
  let source = conversation.toolInvocations.find(
    (tool) => tool.assistantId === assistantId && eligible(tool),
  );
  let cachedKinds: CachedGuideSource["kinds"] | undefined;
  if (!source && cached) {
    const original = conversation.messages.find(
      (message) => message.id === cached.sourceAssistantId,
    );
    if (
      cached.sourceCallId !== sourceCallId ||
      cached.productPath !== productPath ||
      !Number.isFinite(cached.expiresAt) ||
      cached.expiresAt <= Date.now() ||
      !Array.isArray(cached.kinds) ||
      !cached.kinds.length ||
      cached.kinds.length > 2 ||
      new Set(cached.kinds).size !== cached.kinds.length ||
      cached.kinds.some((kind) => kind !== "measuring" && kind !== "fitting") ||
      !original ||
      original.status !== "complete" ||
      !["assistant", "context"].includes(original.role) ||
      latestProductPage(conversationTimeline(conversation))?.productPath !==
        productPath ||
      conversation.messages.some(
        (message) =>
          message.sequence > original.sequence &&
          message.role === "context" &&
          message.status === "complete" &&
          parts(message, conversation.origin).some(
            (part) =>
              (part.type === "page_view" || part.type === "navigation") &&
              productPagePath(part.path) !== productPath,
          ),
      )
    )
      throw new ConversationError(
        400,
        "The cached guide source is no longer valid for this product.",
      );
    source = conversation.toolInvocations.find(
      (tool) => tool.assistantId === cached.sourceAssistantId && eligible(tool),
    );
    cachedKinds = cached.kinds;
  }
  if (!source?.resultJson)
    throw new ConversationError(
      400,
      "A verified product-guide source is required.",
    );
  const found = parseProductGuidesResult(
    JSON.parse(source.resultJson),
    conversation.origin,
  );
  if (
    found.status !== "found" ||
    found.productPath !== productPath ||
    parseProductGuidesCall(JSON.parse(source.argumentsJson)).productPath !==
      productPath ||
    cachedKinds?.some(
      (kind) => !found.guides.some((guide) => guide.kind === kind),
    )
  )
    throw new ConversationError(
      400,
      "The guide source belongs to another product or guide kind.",
    );
  return cachedKinds
    ? {
        ...found,
        guides: found.guides.filter((guide) =>
          cachedKinds.includes(guide.kind),
        ),
      }
    : found;
}

export async function finishTurn(
  id: string,
  assistantId: string,
  result: {
    text: string;
    status: "complete" | "failed" | "cancelled";
    error?: string;
    model?: string;
    serviceTier?: string;
    voiceId?: string;
    presentation?: ProductPresentation;
    questionPresentation?: QuestionPresentation;
    cachedGuideSource?: CachedGuideSource;
    memoryUpdate?: MemoryUpdate;
    contextCheckpoint?: ContextCheckpoint;
    requestedModel?: string;
    resumeQuestionId?: string;
  },
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    if (conversation.status !== "active") return false;
    const message = await transaction.conversationMessage.findFirst({
      where: {
        id: assistantId,
        conversationId: id,
        role: { in: ["assistant", "context"] },
        status: "pending",
      },
    });
    if (!message) return false;
    const staleResume =
      result.resumeQuestionId !== undefined &&
      (latestQuestion(conversationTimeline(conversation))?.invocationId !==
        result.resumeQuestionId ||
        !conversation.voiceSessions.some(
          (session) =>
            session.id === result.voiceId &&
            ["starting", "active"].includes(session.status) &&
            session.leaseExpiresAt > new Date(),
        ));
    // A customer answer or departure while guides are being read wins over a
    // startup refresh. Retire its pending row without reviving the old input.
    if (staleResume)
      result = { text: "", status: "cancelled", model: result.model };
    if (result.status === "cancelled" && message.role !== "context")
      throw new ConversationError(400, "Only voice work can be cancelled.");
    // Cancelling ordinary voice work is expected bookkeeping, not a failed
    // spoken reply. Retain a warning only when a claimed action has no confirmed
    // outcome, including tools already failed by the browser waiter's abort.
    const interruptedAction =
      result.status === "cancelled" &&
      conversation.toolInvocations.some(
        (tool) =>
          tool.assistantId === assistantId &&
          (tool.name === "navigate" || isStorefrontMutation(tool.name)) &&
          tool.claimTokenHash !== null &&
          (tool.status === "running" || tool.status === "failed"),
      );
    const status =
      result.status === "cancelled"
        ? interruptedAction
          ? "failed"
          : "complete"
        : result.status;
    const error =
      result.status === "cancelled"
        ? interruptedAction
          ? "The storefront action was not confirmed. Check the page or cart before repeating it."
          : null
        : (result.error ?? null);
    const content: ConversationPart[] =
      message.role === "context" || !result.text
        ? []
        : [{ type: "text", text: result.text }];
    if (
      result.voiceId !== undefined &&
      (message.role !== "context" ||
        !conversation.voiceSessions.some(
          (session) => session.id === result.voiceId,
        ))
    )
      throw new ConversationError(400, "Invalid voice presentation owner.");
    let selectedProducts: ProductPresentation | undefined;
    let selectedQuestion: QuestionSelection | undefined;
    if (result.status === "complete" && result.presentation) {
      let productIds: string[];
      try {
        productIds = parseProductSelection({
          productIds: result.presentation.productIds,
        });
      } catch {
        throw new ConversationError(400, "Invalid product selection.");
      }
      if (
        typeof result.presentation.callId !== "string" ||
        !result.presentation.callId ||
        result.presentation.callId.length > 200
      )
        throw new ConversationError(
          400,
          "Invalid product presentation call ID.",
        );
      if (
        !result.questionPresentation ||
        result.presentation.callId !== result.questionPresentation.callId
      )
        throw new ConversationError(
          400,
          "Product cards and the final question must belong to the same terminal response.",
        );
      const available = new Set(
        conversation.toolInvocations
          .filter(
            (tool) =>
              tool.assistantId === assistantId &&
              tool.status === "complete" &&
              ["search_products", "get_product", "lookup_catalog"].includes(
                tool.name,
              ) &&
              !tool.error,
          )
          .flatMap((tool) => {
            const ids: unknown = JSON.parse(tool.productIdsJson ?? "[]");
            if (!validProductIds(ids, MAX_CATALOG_CANDIDATES))
              throw new Error("Invalid stored catalog references.");
            return ids;
          }),
      );
      if (productIds.some((productId) => !available.has(productId)))
        throw new ConversationError(
          400,
          "Product cards must come from this reply's successful catalog lookups.",
        );
      if (!validProductRefs(result.presentation.productRefs, productIds))
        throw new ConversationError(400, "Invalid product card references.");
      selectedProducts = { ...result.presentation, productIds };
    }
    if (result.status === "complete" && result.questionPresentation) {
      const selected = result.questionPresentation;
      let selection;
      try {
        selection = parseQuestionSelection({
          question: selected.question,
          answers: selected.answers,
          ...(selected.measurement !== undefined
            ? { measurement: selected.measurement }
            : {}),
        });
      } catch {
        throw new ConversationError(400, "Invalid question selection.");
      }
      if (
        typeof selected.callId !== "string" ||
        !selected.callId ||
        selected.callId.length > 200
      )
        throw new ConversationError(
          400,
          "Invalid question presentation call ID.",
        );
      if (selection.measurement) {
        if (selected.librarySource)
          validateLibraryMeasurementSource(
            conversation,
            assistantId,
            selected.sourceCallId,
            selection.measurement.productPath,
            selected.librarySource,
          );
        else {
          const source = guideSourceResult(
            conversation,
            assistantId,
            selected.sourceCallId,
            selection.measurement.productPath,
            result.cachedGuideSource,
          );
          if (!source.guides.some((guide) => guide.kind === "measuring"))
            throw new ConversationError(
              400,
              "A numeric measurement needs a verified measuring guide.",
            );
        }
      } else if (
        selected.sourceCallId !== undefined ||
        selected.librarySource !== undefined
      )
        throw new ConversationError(400, "Unexpected question source.");
      selectedQuestion = selection;
    }
    // Validate every response part before writing either projection. They share
    // a provider call, but retain the historical separate durable widget records.
    if (selectedProducts) {
      const childCallId = `roman:products:${createHash("sha256")
        .update(JSON.stringify([assistantId, selectedProducts.callId]))
        .digest("hex")}`;
      const presentation = await transaction.toolInvocation.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          assistantId,
          providerCallId: childCallId,
          name: "show_products",
          argumentsJson: JSON.stringify({ productIds: selectedProducts.productIds }),
          productIdsJson: JSON.stringify(selectedProducts.productIds),
          status: "complete",
          completedAt: new Date(),
        },
      });
      content.push({
        type: "products",
        version: 1,
        invocationId: presentation.id,
        productIds: selectedProducts.productIds,
        productRefs: selectedProducts.productRefs,
        ...(message.role === "context" && result.voiceId
          ? { voiceReply: { voiceId: result.voiceId, afterSequence: conversation.nextSequence } }
          : {}),
      });
    }
    if (selectedQuestion && result.questionPresentation) {
      const selection = selectedQuestion;
      const selected = result.questionPresentation;
      const presentation = await transaction.toolInvocation.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          assistantId,
          providerCallId: selected.callId,
          name: selection.measurement ? "ask_measurement" : "ask_question",
          argumentsJson: JSON.stringify({
            ...selection,
            ...(selection.measurement
              ? {
                  sourceCallId: selected.sourceCallId,
                  ...(selected.librarySource
                    ? { librarySource: selected.librarySource }
                    : {}),
                }
              : {}),
          }),
          status: "complete",
          completedAt: new Date(),
        },
      });
      content.push(
        parseQuestionPart({
          type: "question",
          version: 1,
          invocationId: presentation.id,
          ...selection,
          ...(message.role === "context" && result.voiceId
            ? {
                voiceReply: {
                  voiceId: result.voiceId,
                  afterSequence: conversation.nextSequence,
                },
              }
            : {}),
        }),
      );
    }
    const finished = await transaction.conversationMessage.updateMany({
      where: { id: assistantId, conversationId: id, status: "pending" },
      data: {
        status,
        partsJson: JSON.stringify(content),
        model: result.model,
        serviceTier: result.serviceTier,
        error,
        completedAt: new Date(),
      },
    });
    if (finished.count) {
      const nextMemo = result.status === "complete"
        ? applyMemoryUpdate(parseMemo(JSON.parse(conversation.memoJson)), parseMemoryUpdate(result.memoryUpdate))
        : undefined;
      if (result.status === "complete" && result.contextCheckpoint) {
        const checkpoint = parseCheckpoint(result.contextCheckpoint);
        if (checkpoint.model !== (result.requestedModel ?? result.model) || checkpoint.throughSequence >= conversation.nextSequence)
          throw new ConversationError(400, "Invalid context checkpoint owner.");
        const existing = await transaction.conversationContext.findUnique({
          where: { conversationId_model: { conversationId: id, model: checkpoint.model } },
        });
        if (!existing || existing.throughSequence <= checkpoint.throughSequence)
          await transaction.conversationContext.upsert({
            where: { conversationId_model: { conversationId: id, model: checkpoint.model } },
            create: { conversationId: id, model: checkpoint.model, throughSequence: checkpoint.throughSequence, inputJson: JSON.stringify(checkpoint.input) },
            update: { throughSequence: checkpoint.throughSequence, inputJson: JSON.stringify(checkpoint.input) },
          });
      }
      await transaction.conversation.updateMany({
        where: { id, pendingRequestId: message.requestId },
        data: { pendingRequestId: null, revision: { increment: 1 }, ...(nextMemo ? { memoJson: JSON.stringify(nextMemo) } : {}) },
      });
      await failToolInvocations(
        transaction,
        { conversationId: id, assistantId },
        "The reply ended before this storefront action completed.",
      );
    }
    return !!finished.count && !staleResume;
  });
}

const abandonedReplyWhere = {
  role: { in: ["assistant", "context"] },
  status: "pending",
  createdAt: { lt: processStartedAt },
};

export async function failPending(id: string): Promise<void> {
  if (
    !(await prisma.conversationMessage.findFirst({
      where: { conversationId: id, ...abandonedReplyWhere },
      select: { id: true },
    }))
  )
    return;
  await prisma.$transaction(async (transaction) => {
    const abandoned = await transaction.conversationMessage.findMany({
      where: {
        conversationId: id,
        ...abandonedReplyWhere,
      },
      select: { id: true, requestId: true },
    });
    if (!abandoned.length) return;
    await transaction.conversationMessage.updateMany({
      where: {
        conversationId: id,
        ...abandonedReplyWhere,
      },
      data: {
        status: "failed",
        error:
          "The server restarted before this reply finished. Please send your message again.",
        completedAt: new Date(),
      },
    });
    await transaction.conversation.updateMany({
      where: {
        id,
        pendingRequestId: { in: abandoned.map((message) => message.requestId) },
      },
      data: { pendingRequestId: null },
    });
    // Recovered historical rows still change the displayed snapshot when a
    // newer request owns pendingRequestId (or a prior shutdown cleared it).
    await transaction.conversation.update({
      where: { id },
      data: { revision: { increment: 1 } },
    });
    await failToolInvocations(
      transaction,
      {
        conversationId: id,
        assistantId: { in: abandoned.map((message) => message.id) },
      },
      "The server restarted before this storefront action completed.",
    );
  });
}

export async function appendJourney(
  id: string,
  input: JourneyInput,
): Promise<ConversationSnapshot> {
  const occurredAt = Date.parse(input.occurredAt);
  if (
    !uuidPattern.test(input.requestId) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 200 ||
    !Number.isFinite(occurredAt) ||
    occurredAt > Date.now() + 5 * 60 * 1000 ||
    occurredAt < Date.now() - credentialLifetimeMs
  )
    throw new ConversationError(
      400,
      "Send a valid recent page view with a title of up to 200 characters.",
    );
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    requireActive(conversation);
    if (!isStorefrontPagePath(input.path, conversation.origin))
      throw new ConversationError(
        400,
        "This page is not a safe storefront destination.",
      );
    const partsJson = JSON.stringify([
      {
        type: "page_view",
        version: 1,
        title: input.title.trim(),
        path: input.path,
        occurredAt: new Date(occurredAt).toISOString(),
      },
    ]);
    const existing = conversation.messages.find(
      (message) =>
        message.role === "context" && message.requestId === input.requestId,
    );
    if (existing) {
      if (existing.partsJson !== partsJson)
        throw new ConversationError(
          400,
          "This journey request ID already has different data.",
        );
      return snapshot(conversation);
    }
    const claimed = await transaction.conversation.updateMany({
      where: { id, status: "active", nextSequence: conversation.nextSequence },
      data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
    });
    if (!claimed.count)
      throw new ConversationError(
        409,
        "The conversation changed. Retry this page view.",
      );
    await transaction.conversationMessage.create({
      data: {
        id: randomUUID(),
        conversationId: id,
        requestId: input.requestId,
        sequence: conversation.nextSequence,
        role: "context",
        status: "complete",
        partsJson,
        completedAt: new Date(),
      },
    });
    return snapshot(await loadConversation(transaction, id));
  });
}

export async function endConversation(
  id: string,
): Promise<ConversationSnapshot> {
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    if (conversation.status === "ended") return snapshot(conversation);
    await transaction.conversation.update({
      where: { id },
      data: {
        status: "ended",
        pendingRequestId: null,
        revision: { increment: 1 },
      },
    });
    await transaction.conversationMessage.updateMany({
      where: { conversationId: id, status: "pending" },
      data: {
        status: "failed",
        error: "The conversation ended before this reply completed.",
        completedAt: new Date(),
      },
    });
    await failToolInvocations(
      transaction,
      { conversationId: id },
      "The conversation ended before this storefront action completed.",
    );
    await closeConversationVoiceSessions(transaction, id);
    return snapshot(await loadConversation(transaction, id));
  });
}

function pendingAssistant(
  conversation: StoredConversation,
  assistantId: string,
): StoredMessage {
  requireActive(conversation);
  const assistant = conversation.messages.find(
    (message) =>
      message.id === assistantId &&
      ["assistant", "context"].includes(message.role) &&
      message.status === "pending" &&
      message.requestId === conversation.pendingRequestId,
  );
  if (!assistant || assistant.createdAt < processStartedAt)
    throw new ConversationError(
      409,
      "This reply is no longer waiting for a catalog result.",
    );
  return assistant;
}

function invocation(
  conversation: StoredConversation,
  invocationId: string,
): StoredTool {
  const tool = conversation.toolInvocations.find(
    (entry) => entry.id === invocationId,
  );
  if (!tool)
    throw new ConversationError(
      404,
      "This storefront action could not be found.",
    );
  return tool;
}

function validateClaim(claim: ToolClaim) {
  if (
    Object.keys(claim).length !== 2 ||
    !uuidPattern.test(claim.clientId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(claim.claimToken)
  )
    throw new ConversationError(400, "Send a valid catalog executor claim.");
}

function ownsClaim(tool: StoredTool, claim: ToolClaim): boolean {
  const expected = Buffer.from(tool.claimTokenHash ?? "0".repeat(64), "hex");
  const supplied = Buffer.from(tokenHash(claim.claimToken), "hex");
  return (
    tool.claimClientId === claim.clientId &&
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
}

export async function createToolInvocation(
  id: string,
  assistantId: string,
  input: {
    providerCallId: string;
    name: BrowserToolName;
    arguments: Record<string, unknown>;
  },
): Promise<BrowserToolInvocation> {
  if (!input.providerCallId || input.providerCallId.length > 200)
    throw new ConversationError(400, "Invalid storefront call ID.");
  let call;
  try {
    call = storedBrowserCall(input.name, input.arguments);
  } catch {
    throw new ConversationError(400, "Invalid storefront tool arguments.");
  }
  const argumentsJson = JSON.stringify(call.arguments);
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    pendingAssistant(conversation, assistantId);
    const existing = conversation.toolInvocations.find(
      (tool) => tool.providerCallId === input.providerCallId,
    );
    if (existing) {
      if (
        existing.assistantId !== assistantId ||
        existing.name !== call.name ||
        existing.argumentsJson !== argumentsJson
      )
        throw new ConversationError(
          400,
          "This storefront call ID already has different arguments.",
        );
      if (existing.status !== "pending" && existing.status !== "running")
        throw new ConversationError(
          409,
          "This storefront action has already finished.",
        );
      return toolSnapshot(existing);
    }
    if (
      conversation.toolInvocations.filter(
        (tool) => tool.assistantId === assistantId,
      ).length >= MAX_TURN_TOOL_CALLS
    )
      throw new ConversationError(
        429,
        "This reply has reached its storefront action limit.",
      );
    const tool = await transaction.toolInvocation.create({
      data: {
        id: randomUUID(),
        conversationId: id,
        assistantId,
        providerCallId: input.providerCallId,
        name: call.name,
        argumentsJson,
      },
    });
    await transaction.conversation.update({
      where: { id },
      data: { revision: { increment: 1 } },
    });
    return toolSnapshot(tool);
  });
}

export async function claimToolInvocation(
  id: string,
  invocationId: string,
  claim: ToolClaim,
): Promise<{ claimed: boolean }> {
  validateClaim(claim);
  return prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    requireActive(conversation);
    const tool = invocation(conversation, invocationId);
    if (tool.status !== "pending" && tool.status !== "running")
      return { claimed: false };
    pendingAssistant(conversation, tool.assistantId);
    if (tool.status === "running") {
      if (!ownsClaim(tool, claim)) return { claimed: false };
    }
    if (tool.name === "apply_measurements") {
      const command = parseApplyMeasurementsCommand(
        JSON.parse(tool.argumentsJson),
      );
      const draft = await transaction.measurementDraft.findUnique({
        where: {
          conversationId_productPath: {
            conversationId: id,
            productPath: command.productPath,
          },
        },
      });
      if (
        !draft ||
        draft.updatedAt.toISOString() !== command.draft.updatedAt ||
        draft.width !== command.draft.width ||
        draft.height !== command.draft.height ||
        draft.unit !== command.draft.unit ||
        draft.kind !== "order" ||
        draft.mount !== command.draft.mount
      )
        throw new ConversationError(
          409,
          "The saved measurements changed. Review the latest draft before applying it.",
        );
    }
    if (tool.status === "running") return { claimed: true };
    const claimed = await transaction.toolInvocation.updateMany({
      where: { id: invocationId, conversationId: id, status: "pending" },
      data: {
        status: "running",
        claimClientId: claim.clientId,
        claimTokenHash: tokenHash(claim.claimToken),
      },
    });
    if (!claimed.count) return { claimed: false };
    await transaction.conversation.update({
      where: { id },
      data: { revision: { increment: 1 } },
    });
    return { claimed: true };
  });
}

export async function completeToolInvocation(
  id: string,
  invocationId: string,
  claim: ToolClaim,
  result: {
    productIds: string[];
    catalogQueries?: CatalogQueryOutcome[];
    error?: string;
    outcome?:
      | StoredActionResult
      | ProductGuidesResult
      | NavigationResult
      | ViewResult
      | CheckoutResult
      | GuideLibraryResult
      | StoreSupportResult;
  },
): Promise<void> {
  validateClaim(claim);
  if (
    !validProductIds(result.productIds, MAX_CATALOG_CANDIDATES) ||
    (result.error !== undefined &&
      (typeof result.error !== "string" ||
        !result.error.trim() ||
        result.error.length > 500 ||
        result.productIds.length > 0))
  )
    throw new ConversationError(400, "Invalid storefront completion.");
  const productIdsJson = JSON.stringify(result.productIds);
  const error = result.error ?? null;
  await prisma.$transaction(async (transaction) => {
    const conversation = await loadConversation(transaction, id);
    requireActive(conversation);
    const tool = invocation(conversation, invocationId);
    if (!ownsClaim(tool, claim))
      throw new ConversationError(
        401,
        "This storefront result belongs to another executor.",
      );
    let catalogQueries: CatalogQueryOutcome[] | undefined;
    try {
      if (tool.name === "search_products" && !error) {
        catalogQueries = parseCatalogQueryOutcomes(result.catalogQueries, result.productIds);
        const call = parseCatalogCall(tool.name, JSON.parse(tool.argumentsJson));
        if (call.name !== "search_products")
          throw new Error("Query provenance requires a search invocation.");
        assertCatalogQueryProvenance({ queries: catalogQueries }, call.arguments.queries);
      } else if (result.catalogQueries !== undefined) {
        throw new Error("Query provenance belongs only to a successful catalog search.");
      }
      if (tool.name !== "search_products" && result.productIds.length > MAX_PRODUCT_CARDS)
        throw new Error("A product lookup returns at most ten candidates.");
    } catch {
      throw new ConversationError(400, "Invalid catalog query provenance.");
    }
    const persistsOutcome =
      isCartTool(tool.name) ||
      tool.name === "navigate" ||
      tool.name === "show_view" ||
      tool.name === "open_checkout" ||
      tool.name === "apply_measurements" ||
      tool.name === "get_product_guides" ||
      tool.name === "discover_guides" ||
      tool.name === "get_store_support" ||
      isProductConfigurationTool(tool.name);
    const outcome = persistsOutcome
      ? result.outcome === undefined
        ? isStorefrontMutation(tool.name) && error
          ? interruptedActionResult(tool, true)
          : undefined
        : tool.name === "open_checkout"
          ? parseCheckoutResult(result.outcome)
        : tool.name === "show_view"
          ? parseViewResult(result.outcome)
          : tool.name === "discover_guides"
            ? parseGuideLibraryResult(result.outcome, conversation.origin)
            : tool.name === "get_store_support"
              ? parseStoreSupportResult(result.outcome, conversation.origin)
              : tool.name === "get_product_guides"
                ? parseProductGuidesResult(result.outcome, conversation.origin)
                : tool.name === "navigate"
                  ? parseNavigationResult(result.outcome)
                  : storedActionResult(tool, result.outcome)
      : undefined;
    if (
      tool.name === "show_view" &&
      outcome &&
      "view" in outcome &&
      outcome.view !== parseViewCall(JSON.parse(tool.argumentsJson)).view
    )
      throw new ConversationError(
        400,
        "The browser showed a different Roman view.",
      );
    if (
      tool.name === "get_product_guides" &&
      outcome &&
      "productPath" in outcome &&
      outcome.productPath !==
        parseProductGuidesCall(JSON.parse(tool.argumentsJson)).productPath
    )
      throw new ConversationError(
        400,
        "The guide links belong to another product.",
      );
    if (
      tool.name === "discover_guides" &&
      outcome &&
      "library" in outcome &&
      outcome.library !==
        parseGuideLibraryCall(JSON.parse(tool.argumentsJson)).library
    )
      throw new ConversationError(
        400,
        "The guide library belongs to another page.",
      );
    if (
      (result.outcome !== undefined && !persistsOutcome) ||
      (persistsOutcome && (result.productIds.length || (!error && !outcome)))
    )
      throw new ConversationError(400, "Invalid storefront completion.");
    const resultJson = catalogQueries
      ? JSON.stringify({ queries: catalogQueries })
      : outcome === undefined ? null : JSON.stringify(outcome);
    if (tool.status === "complete" || tool.status === "failed") {
      if (
        tool.productIdsJson === productIdsJson &&
        tool.error === error &&
        tool.resultJson === resultJson
      )
        return;
      throw new ConversationError(
        409,
        "This storefront action has already finished.",
      );
    }
    if (tool.status !== "running")
      throw new ConversationError(
        409,
        "Claim this storefront action before completing it.",
      );
    if (tool.name === "navigate" && result.productIds.length)
      throw new ConversationError(
        400,
        "Navigation cannot return product references.",
      );
    pendingAssistant(conversation, tool.assistantId);
    const completedAt = new Date();
    const addedProduct =
      !error &&
      tool.name === "add_to_cart" &&
      outcome &&
      "status" in outcome &&
      outcome.status === "added"
        ? outcome.addedProduct
        : undefined;
    const addedSample =
      !error &&
      tool.name === "add_sample_to_cart" &&
      outcome &&
      "status" in outcome &&
      outcome.status === "added"
        ? outcome.addedSample
        : undefined;
    const navigation =
      !error &&
      tool.name === "navigate" &&
      outcome &&
      "status" in outcome &&
      outcome.status === "navigated"
        ? outcome
        : undefined;
    const notification: ConversationPart | undefined = addedProduct
      ? { type: "cart_added", version: 1, invocationId, product: addedProduct }
      : addedSample
        ? {
            type: "cart_sample_added",
            version: 1,
            invocationId,
            sample: addedSample,
          }
        : navigation
          ? parseNavigationPart({
              type: "navigation",
              version: 1,
              invocationId,
              path: navigation.path.split(/[?#]/, 1)[0],
              title:
                navigation.title ??
                navigation.path.split(/[?#]/, 1)[0].slice(0, 200),
            })
          : undefined;
    await transaction.toolInvocation.update({
      where: { id: invocationId },
      data: {
        status:
          error ||
          (outcome &&
            "status" in outcome &&
            ["handed_off", "uncertain"].includes(outcome.status))
            ? "failed"
            : "complete",
        productIdsJson,
        error,
        resultJson,
        completedAt,
      },
    });
    if (notification) {
      await transaction.conversationMessage.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          requestId: randomUUID(),
          sequence: conversation.nextSequence,
          role: "context",
          status: "complete",
          partsJson: JSON.stringify([notification]),
          createdAt: completedAt,
          completedAt,
        },
      });
    }
    await transaction.conversation.update({
      where: { id },
      data: {
        revision: { increment: 1 },
        ...(notification ? { nextSequence: { increment: 1 } } : {}),
      },
    });
  });
}

export async function failToolInvocation(
  id: string,
  invocationId: string,
  reason: string,
) {
  if (!reason.trim() || reason.length > 500)
    throw new ConversationError(400, "Invalid storefront failure reason.");
  return prisma.$transaction(async (transaction) => {
    const failed = await failToolInvocations(
      transaction,
      { id: invocationId, conversationId: id },
      reason,
    );
    if (failed)
      await transaction.conversation.update({
        where: { id },
        data: { revision: { increment: 1 } },
      });
    const tool = await transaction.toolInvocation.findFirst({
      where: { id: invocationId, conversationId: id },
    });
    return tool &&
      (isCartTool(tool.name) ||
        tool.name === "apply_measurements" ||
        isProductConfigurationTool(tool.name)) &&
      tool.resultJson
      ? storedActionResult(tool, JSON.parse(tool.resultJson))
      : undefined;
  });
}

/** Keep uncertain writes durable when their reply, process or browser goes away. */
async function failToolInvocations(
  transaction: Prisma.TransactionClient,
  where: Prisma.ToolInvocationWhereInput,
  reason: string,
) {
  const pending = await transaction.toolInvocation.findMany({
    where: { ...where, status: { in: ["pending", "running"] } },
  });
  for (const tool of pending) {
    const outcome = interruptedActionResult(tool, tool.status === "running");
    await transaction.toolInvocation.update({
      where: { id: tool.id },
      data: {
        status: "failed",
        error: reason,
        completedAt: new Date(),
        ...(outcome ? { resultJson: JSON.stringify(outcome) } : {}),
      },
    });
  }
  return pending.length;
}
