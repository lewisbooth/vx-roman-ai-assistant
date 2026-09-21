import { parseCheckoutCall } from "../../../shared/checkout";
import {
  MAX_MESSAGE_LENGTH,
  MAX_CONVERSATION_MESSAGES,
  MAX_PRODUCT_CARDS,
  CONVERSATION_STORAGE_KEY,
  type ConversationBootstrap,
  type ConversationCredential,
  type ConversationSnapshot,
  type ConversationMessage,
  type ConversationReadVersion,
  type BrowserToolInvocation,
  type ToolClaim,
} from "../../../shared/conversation";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import { parseViewCall } from "../../../shared/assistant-view";
import { parseGuideLibraryCall } from "../../../shared/guide-library";
import { parseStoreSupportCall } from "../../../shared/store-support";
import {
  isProductConfigurationTool,
  parseProductConfigurationCall,
} from "../../../shared/product-configuration";
import {
  parseGuidePart,
  parseProductGuidesCall,
} from "../../../shared/product-guides";
import {
  isCartMutation,
  isCartTool,
  parseCartAddedProduct,
  parseCartAddedSample,
  parseCartCall,
  requiresCartConfirmation,
} from "../../../shared/cart-tools";
import {
  parseApplyMeasurementsCommand,
  parseMeasurementCall,
  parseMeasurementToolResult,
} from "../../../shared/measurements";
import {
  parseNavigationCall,
  parseNavigationPart,
} from "../../../shared/navigation-tool";
import {
  isQuestionAnswer,
  latestQuestion,
  parseQuestionAnswerReference,
  parseVoiceInputReference,
  parseQuestionPart,
  type QuestionAnswerReference,
  type VoiceSelectionInput,
} from "../../../shared/questions";
import {
  parseProductChoice,
  parseProductChoiceReference,
  productChoiceText,
  type ProductChoiceReference,
  type ProductChoice,
} from "../../../shared/product-choice";
import type { CatalogProduct } from "../../../shared/catalog";
import type {
  createStorefrontExecutor,
  BrowserToolResult,
  PreparedToolApproval,
} from "./storefront-executor";
import { isConversationStorefront } from "../../../shared/storefronts";
import type { ConversationClient, ConversationClientState } from "./types";
import {
  createVoiceConnection,
  MicrophonePermissionError,
} from "./voice-connection";
import { setVoiceAutostartPreference } from "./voice-preference";
import {
  DEFAULT_LIVE_VOICE,
  isLiveVoice,
  parseVoiceEventPart,
  type LiveVoice,
  type VoiceClientState,
} from "../../../shared/voice";

const STORAGE_KEY = CONVERSATION_STORAGE_KEY;
const VOICE_STORAGE_KEY = "roman:voice";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idleVoice: VoiceClientState = {
  status: "idle",
  muted: false,
  error: null,
};

function voiceSnapshot(value: unknown) {
  return (
    value == null ||
    (record(value) &&
      typeof value.id === "string" &&
      UUID.test(value.id) &&
      typeof value.clientId === "string" &&
      UUID.test(value.clientId) &&
      ["starting", "active", "closed", "failed"].includes(
        String(value.status),
      ) &&
      (value.error === undefined || typeof value.error === "string"))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validGuidePart(value: unknown) {
  try {
    parseGuidePart(value, window.location.origin);
    return true;
  } catch {
    return false;
  }
}

function validQuestionPart(value: unknown) {
  try {
    parseQuestionPart(value);
    return true;
  } catch {
    return false;
  }
}

function validProductChoice(value: unknown) {
  try {
    parseProductChoiceReference(value);
    return true;
  } catch {
    return false;
  }
}

function validQuestionAnswer(value: unknown) {
  try {
    parseQuestionAnswerReference(value);
    return true;
  } catch {
    return false;
  }
}

function validVoiceInput(value: unknown) {
  try {
    parseVoiceInputReference(value);
    return true;
  } catch {
    return false;
  }
}

function validVoiceEvent(value: unknown) {
  try {
    parseVoiceEventPart(value);
    return true;
  } catch {
    return false;
  }
}

function validNavigationPart(value: unknown) {
  try {
    parseNavigationPart(value);
    return true;
  } catch {
    return false;
  }
}

function validCartAddedPart(value: Record<string, unknown>) {
  if (
    value.version !== 1 ||
    typeof value.invocationId !== "string" ||
    !UUID.test(value.invocationId) ||
    Object.keys(value).some(
      (key) => !["type", "version", "invocationId", "product"].includes(key),
    )
  )
    return false;
  try {
    parseCartAddedProduct(value.product);
    return true;
  } catch {
    return false;
  }
}

function validCartSampleAddedPart(value: Record<string, unknown>) {
  if (
    value.version !== 1 ||
    typeof value.invocationId !== "string" ||
    !UUID.test(value.invocationId) ||
    Object.keys(value).some(
      (key) => !["type", "version", "invocationId", "sample"].includes(key),
    )
  )
    return false;
  try {
    parseCartAddedSample(value.sample);
    return true;
  } catch {
    return false;
  }
}

function credential(value: unknown): value is ConversationCredential {
  if (
    !record(value) ||
    typeof value.conversationId !== "string" ||
    !UUID.test(value.conversationId) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.apiBaseUrl !== "string"
  )
    return false;
  try {
    const url = new URL(value.apiBaseUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/api/conversations"
    );
  } catch {
    return false;
  }
}

function snapshot(value: unknown): value is ConversationSnapshot {
  return (
    record(value) &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    typeof value.busy === "boolean" &&
    (value.status === "active" || value.status === "ended") &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    (value.readingGuides === undefined ||
      (value.status === "active" &&
        value.busy &&
        Array.isArray(value.readingGuides) &&
        value.readingGuides.length >= 1 &&
        value.readingGuides.length <= 2 &&
        new Set(value.readingGuides).size === value.readingGuides.length &&
        value.readingGuides.every(
          (kind) => kind === "measuring" || kind === "fitting",
        ))) &&
    voiceSnapshot(value.voice) &&
    Array.isArray(value.tools) &&
    value.tools.length <= 4 &&
    value.tools.every((tool) => {
      if (
        !record(tool) ||
        typeof tool.id !== "string" ||
        !UUID.test(tool.id) ||
        (tool.status !== "pending" && tool.status !== "running")
      )
        return false;
      try {
        const name = String(tool.name);
        if (tool.name === "navigate") parseNavigationCall(tool.arguments);
        else if (tool.name === "show_view") parseViewCall(tool.arguments);
        else if (tool.name === "open_checkout") parseCheckoutCall(tool.arguments);
        else if (isCartTool(String(tool.name)))
          parseCartCall(String(tool.name), tool.arguments);
        else if (tool.name === "apply_measurements")
          parseApplyMeasurementsCommand(tool.arguments);
        else if (tool.name === "get_product_guides")
          parseProductGuidesCall(tool.arguments);
        else if (tool.name === "discover_guides")
          parseGuideLibraryCall(tool.arguments);
        else if (tool.name === "get_store_support")
          parseStoreSupportCall(tool.arguments);
        else if (isProductConfigurationTool(name))
          parseProductConfigurationCall(name, tool.arguments);
        else parseCatalogCall(String(tool.name), tool.arguments);
        return true;
      } catch {
        return false;
      }
    }) &&
    Array.isArray(value.messages) &&
    value.messages.length <= MAX_CONVERSATION_MESSAGES &&
    value.messages.every(
      (message) =>
        record(message) &&
        typeof message.id === "string" &&
        (message.role === "user" ||
          message.role === "assistant" ||
          message.role === "context") &&
        ["pending", "complete", "failed"].includes(String(message.status)) &&
        typeof message.createdAt === "string" &&
        (message.requestId === undefined ||
          (message.role === "user" &&
            typeof message.requestId === "string" &&
            UUID.test(message.requestId))) &&
        (message.error === undefined || typeof message.error === "string") &&
        Array.isArray(message.parts) &&
        message.parts.every(
          (part) =>
            record(part) &&
            ((part.type === "text" &&
              typeof part.text === "string" &&
              (part.questionAnswer === undefined ||
                (message.role === "user" &&
                  validQuestionAnswer(part.questionAnswer))) &&
              (part.productChoice === undefined ||
                (message.role === "user" &&
                  part.questionAnswer === undefined &&
                  validProductChoice(part.productChoice))) &&
              (part.voiceInput === undefined ||
                (message.role === "user" &&
                  part.questionAnswer === undefined &&
                  part.productChoice === undefined &&
                  validVoiceInput(part.voiceInput)))) ||
              (part.type === "guides" && validGuidePart(part)) ||
              (part.type === "question" && validQuestionPart(part)) ||
              (part.type === "voice_event" &&
                message.role === "context" &&
                validVoiceEvent(part)) ||
              (part.type === "navigation" && validNavigationPart(part)) ||
              (part.type === "cart_added" && validCartAddedPart(part)) ||
              (part.type === "cart_sample_added" &&
                validCartSampleAddedPart(part)) ||
              (part.type === "voice" &&
                part.version === 1 &&
                typeof part.voiceId === "string" &&
                UUID.test(part.voiceId) &&
                typeof part.text === "string" &&
                part.text.length <= 60_000 &&
                typeof part.startMs === "number" &&
                Number.isFinite(part.startMs) &&
                Number(part.startMs) >= 0 &&
                typeof part.endMs === "number" &&
                Number.isFinite(part.endMs) &&
                Number(part.endMs) >= Number(part.startMs)) ||
              (part.type === "products" &&
                part.version === 1 &&
                typeof part.invocationId === "string" &&
                UUID.test(part.invocationId) &&
                Array.isArray(part.productIds) &&
                part.productIds.length <= MAX_PRODUCT_CARDS &&
                part.productIds.every(
                  (id) =>
                    typeof id === "string" &&
                    /^gid:\/\/shopify\/Product\/\d+$/.test(id),
                )) ||
              (part.type === "page_view" &&
                part.version === 1 &&
                typeof part.title === "string" &&
                typeof part.path === "string" &&
                /^\/(?!\/)[^?#]*$/.test(part.path) &&
                typeof part.occurredAt === "string")),
        ),
    )
  );
}

class SessionRequestError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

function pendingUserMessage(
  requestId: string,
  text: string,
  questionAnswer?: QuestionAnswerReference,
  productChoice?: ProductChoiceReference,
): ConversationMessage {
  return {
    id: requestId,
    requestId,
    role: "user",
    status: "pending",
    parts: [
      {
        type: "text",
        text,
        ...(questionAnswer ? { questionAnswer } : {}),
        ...(productChoice ? { productChoice } : {}),
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

export function createConversationClient(
  executor?: ReturnType<typeof createStorefrontExecutor>,
): ConversationClient {
  let state: ConversationClientState = {
    conversation: null,
    optimisticMessage: null,
    pending: false,
    restoring: false,
    error: null,
    voice: idleVoice,
    selectedVoice: DEFAULT_LIVE_VOICE,
    approval: null,
  };
  let access: ConversationCredential | null = null;
  let resumeAccess: ConversationCredential | null = null;
  let bootstrapping: { epoch: number; promise: Promise<void> } | undefined;
  let disposed = false;
  let pollTimer: number | undefined;
  let pollFailures = 0;
  let polling = false;
  let pollAfterCurrent = false;
  let apiSequence = 0;
  let appliedSequence = 0;
  let readVersion: ConversationReadVersion | undefined;
  let epoch = 0;
  let ending = false;
  let voiceEpoch = 0;
  let voiceId: string | undefined;
  let voiceConnection: ReturnType<typeof createVoiceConnection> | undefined;
  let heartbeatTimer: number | undefined;
  let voiceLimitTimer: number | undefined;
  let voiceStop: Promise<void> | undefined;
  let voiceStart: Promise<void> | undefined;
  let queuedVoiceInput:
    | {
        requestId: string;
        text: string;
        claimed: boolean;
        voiceId?: string;
        cancel?: () => void;
      }
    | undefined;
  let voiceStorageWarned = false;
  let journeyQueue: Promise<unknown> = Promise.resolve();
  let processingTool = false;
  let toolController: AbortController | undefined;
  let activeToolId: string | undefined;
  let approvalChoice:
    { id: string; resolve(confirmed: boolean): void } | undefined;
  const clientId = window.crypto.randomUUID();
  const toolAttempts = new Map<
    string,
    {
      claim: ToolClaim;
      attempts: number;
      confirmed?: boolean;
      approval?: PreparedToolApproval;
      abandoned?: boolean;
      outcome?: { result: BrowserToolResult } | { error: string };
    }
  >();
  let uncertainSubmission: {
    requestId: string;
    text: string;
    productChoice?: ProductChoice;
  } | null = null;
  let uncertainVoiceAnswer: (VoiceSelectionInput & { voiceId: string }) | null =
    null;
  let uncertainMeasurement: { requestId: string; key: string } | null = null;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();

  function update(change: Partial<ConversationClientState>) {
    if (
      state.optimisticMessage &&
      change.conversation?.messages.some(
        (message) =>
          message.role === "user" &&
          (message.requestId === state.optimisticMessage?.id ||
            message.id === state.optimisticMessage?.id),
      )
    )
      change = { ...change, optimisticMessage: null };
    if (
      disposed ||
      Object.entries(change).every(
        ([key, value]) => state[key as keyof ConversationClientState] === value,
      )
    )
      return;
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  }

  function persist() {
    try {
      if (access)
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(access));
      else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      console.warn(
        "[Roman] Conversation storage is unavailable; this conversation cannot resume after a page reload.",
      );
    }
  }

  function warnVoiceStorage() {
    if (voiceStorageWarned) return;
    voiceStorageWarned = true;
    console.warn(
      "[Roman] Voice preference storage is unavailable; the default will return after a page reload.",
    );
  }

  function restoreVoiceChoice() {
    try {
      const saved = window.sessionStorage.getItem(VOICE_STORAGE_KEY);
      update({
        selectedVoice: isLiveVoice(saved) ? saved : DEFAULT_LIVE_VOICE,
      });
    } catch {
      warnVoiceStorage();
    }
  }

  function setVoice(voice: LiveVoice) {
    if (disposed) throw new Error("Roman has been removed.");
    if (!isLiveVoice(voice))
      throw new Error("Choose one of the available voices.");
    if (
      ending ||
      voiceId ||
      state.voice.status === "starting" ||
      state.voice.status === "active" ||
      state.voice.status === "stopping" ||
      (state.voice.status === "error" && state.voice.muted) ||
      state.conversation?.voice?.status === "starting" ||
      state.conversation?.voice?.status === "active"
    )
      throw new Error("End voice before changing the voice.");
    update({ selectedVoice: voice });
    try {
      window.sessionStorage.setItem(VOICE_STORAGE_KEY, voice);
    } catch {
      warnVoiceStorage();
    }
  }

  async function request(url: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await window.fetch(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(20_000),
          ...(init.signal ? [init.signal] : []),
        ]),
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new SessionRequestError(
          "Roman could not connect. Open the app in Shopify admin to approve its connection, then refresh the storefront.",
          response.status,
        );
      }
      const body: unknown = await response.json();
      if (disposed) throw new SessionRequestError("Roman has been removed.");
      if (!response.ok) {
        const error =
          record(body) &&
          record(body.error) &&
          typeof body.error.message === "string"
            ? body.error.message
            : "Roman could not complete the request. Please try again.";
        throw new SessionRequestError(error, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof SessionRequestError) throw error;
      throw new SessionRequestError(
        "Roman could not connect. Check your connection and try again.",
      );
    }
  }

  function bootstrap(resume: ConversationCredential | null) {
    // Stopping voice must not race a subsequent text reply into a second chat.
    if (bootstrapping?.epoch === epoch) return bootstrapping.promise;
    const attempt = { epoch, promise: requestBootstrap(resume) };
    bootstrapping = attempt;
    void attempt.promise
      .finally(() => {
        if (bootstrapping === attempt) bootstrapping = undefined;
      })
      .catch(() => undefined);
    return attempt.promise;
  }

  async function requestBootstrap(resume: ConversationCredential | null) {
    const requestedEpoch = epoch;
    const url = new URL("/apps/roman/bootstrap", window.location.origin);
    url.searchParams.set("storefront_origin", window.location.origin);
    const result = await request(url.href, {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        resume
          ? { conversationId: resume.conversationId, token: resume.token }
          : {},
      ),
    });
    if (requestedEpoch !== epoch || disposed)
      throw new SessionRequestError("The conversation has changed.");
    if (
      !credential(result) ||
      !record(result) ||
      !snapshot(result.conversation) ||
      result.conversation.id !== result.conversationId
    ) {
      throw new SessionRequestError(
        "Roman received an invalid session response.",
      );
    }
    const boot = result as unknown as ConversationBootstrap;
    access = {
      conversationId: boot.conversationId,
      token: boot.token,
      expiresAt: boot.expiresAt,
      apiBaseUrl: boot.apiBaseUrl,
    };
    resumeAccess = null;
    readVersion = undefined;
    persist();
    update({ conversation: boot.conversation });
  }

  async function rawApi(path = "", body?: unknown, signal?: AbortSignal) {
    const credential = access;
    const requestedEpoch = epoch;
    if (!credential)
      throw new SessionRequestError("Start a conversation first.");
    const result = await request(
      `${credential.apiBaseUrl}/${credential.conversationId}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      },
    );
    if (
      requestedEpoch !== epoch ||
      access?.conversationId !== credential.conversationId
    )
      throw new SessionRequestError("The conversation has changed.");
    return result;
  }

  async function api(path = "", body?: unknown) {
    if (!access) throw new SessionRequestError("Start a conversation first.");
    const sequence = ++apiSequence;
    const isRead = path === "" && body === undefined;
    const requestedVersion = isRead ? readVersion : undefined;
    const query = requestedVersion
      ? `?revision=${requestedVersion.revision}&streamRevision=${requestedVersion.streamRevision}`
      : "";
    const result = await rawApi(`${path}${query}`, body);
    const version =
      record(result) &&
      Number.isSafeInteger(result.revision) &&
      Number(result.revision) >= 0 &&
      Number.isSafeInteger(result.streamRevision) &&
      Number(result.streamRevision) >= 0
        ? {
            revision: Number(result.revision),
            streamRevision: Number(result.streamRevision),
          }
        : undefined;
    if (record(result) && result.unchanged === true) {
      if (
        !isRead ||
        !requestedVersion ||
        !version ||
        result.id !== access?.conversationId ||
        version.revision !== requestedVersion.revision ||
        version.streamRevision !== requestedVersion.streamRevision
      )
        throw new SessionRequestError(
          "Roman received an invalid conversation version.",
        );
      // An intervening mutation can supersede this read. Retry only work from
      // the current authoritative state, including a lost tool-result response.
      void executePendingTool();
      return;
    }
    if (isRead && !version)
      throw new SessionRequestError(
        "Roman received an invalid conversation version.",
      );
    if (!snapshot(result) || result.id !== access?.conversationId)
      throw new SessionRequestError(
        "Roman received an invalid conversation response.",
      );
    // Older backend snapshots may omit requestId; a valid POST acknowledgement
    // still confirms this exact submission without comparing customer text.
    const acknowledged =
      path === "/messages" &&
      record(body) &&
      body.requestId === state.optimisticMessage?.requestId;
    const revision = state.conversation?.revision ?? -1;
    const currentStream =
      readVersion?.revision === revision ? readVersion.streamRevision : 0;
    if (
      result.revision > revision ||
      (result.revision === revision &&
        ((version && version.streamRevision > currentStream) ||
          (!readVersion && sequence >= appliedSequence)))
    ) {
      appliedSequence = Math.max(sequence, appliedSequence);
      readVersion = version;
      // A spoken correction can retire work before it completes in this page.
      // Cancel the browser action as soon as its authoritative invocation ends.
      if (
        activeToolId &&
        !result.tools.some((tool) => tool.id === activeToolId)
      )
        toolController?.abort();
      update({
        conversation: result,
        ...(acknowledged ? { optimisticMessage: null } : {}),
      });
      if (result.status === "ended") reset();
      else {
        if (
          voiceId &&
          result.voice?.id === voiceId &&
          (result.voice.status === "closed" ||
            result.voice.status === "failed") &&
          state.voice.status !== "stopping"
        ) {
          closeVoiceLocally();
          voiceId = undefined;
          update({
            voice:
              result.voice.status === "failed"
                ? {
                    status: "error",
                    muted: false,
                    error:
                      result.voice.error ||
                      "Voice ended. You can continue in text.",
                  }
                : idleVoice,
          });
        }
        void executePendingTool();
      }
    } else {
      if (acknowledged) update({ optimisticMessage: null });
      // Same-version snapshots can arrive from idempotent mutation responses.
      // They must not replace streamed text or retrigger transcript rendering.
      void executePendingTool();
    }
  }

  function reset() {
    closeVoiceLocally();
    voiceId = undefined;
    voiceStop = undefined;
    toolController?.abort();
    epoch++;
    access = null;
    readVersion = undefined;
    resumeAccess = null;
    uncertainSubmission = null;
    uncertainVoiceAnswer = null;
    uncertainMeasurement = null;
    toolAttempts.clear();
    pollAfterCurrent = false;
    window.clearTimeout(pollTimer);
    persist();
    update({
      conversation: null,
      optimisticMessage: null,
      pending: false,
      restoring: false,
      error: null,
      voice: idleVoice,
      approval: null,
    });
  }

  async function executePendingTool() {
    if (
      disposed ||
      ending ||
      state.voice.status === "stopping" ||
      processingTool ||
      !executor ||
      state.conversation?.status !== "active"
    )
      return;
    const voice = state.conversation.voice;
    if (
      voice &&
      (voice.status === "starting" || voice.status === "active") &&
      (voice.clientId !== clientId || state.voice.status === "error")
    )
      return;
    const tool = state.conversation.tools.find(
      (item) => item.status === "pending" || toolAttempts.has(item.id),
    );
    if (!tool) return;
    processingTool = true;
    const startedEpoch = epoch;
    const startedVoiceEpoch = voiceEpoch;
    const controller = new AbortController();
    toolController = controller;
    activeToolId = tool.id;
    let submitted = false;
    try {
      submitted =
        (await executeTool(tool, startedEpoch, controller.signal)) === true;
    } catch (error) {
      if (
        !disposed &&
        startedEpoch === epoch &&
        !ending &&
        !controller.signal.aborted
      )
        update({
          error:
            error instanceof Error
              ? error.message
              : "The storefront tool could not finish.",
        });
    } finally {
      if (
        controller.signal.aborted &&
        (isCartMutation(tool.name) ||
          tool.name === "apply_measurements" ||
          tool.name === "configure_product")
      ) {
        const attempt = toolAttempts.get(tool.id);
        if (attempt) {
          // End/Stop may fail while a claim response is in flight. Ownership
          // can be reconciled later, but that cannot revive permission to act.
          attempt.abandoned = true;
          attempt.approval = undefined;
          if (requiresCartConfirmation(tool.name)) attempt.confirmed ??= false;
        }
      }
      processingTool = false;
      if (toolController === controller) {
        toolController = undefined;
        activeToolId = undefined;
      }
      if (
        submitted &&
        !disposed &&
        !ending &&
        startedEpoch === epoch &&
        startedVoiceEpoch === voiceEpoch
      ) {
        if (polling) pollAfterCurrent = true;
        else if (pollFailures === 0) {
          window.clearTimeout(pollTimer);
          void poll();
        }
      }
    }
  }

  async function executeTool(
    tool: BrowserToolInvocation,
    startedEpoch: number,
    signal: AbortSignal,
  ) {
    let attempt = toolAttempts.get(tool.id);
    if (!attempt) {
      const bytes = window.crypto.getRandomValues(new Uint8Array(32));
      const claimToken = window
        .btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      attempt = { claim: { clientId, claimToken }, attempts: 0 };
      toolAttempts.set(tool.id, attempt);
    }
    const needsApproval = requiresCartConfirmation(tool.name);
    if (needsApproval && attempt.confirmed === undefined) {
      let unavailable: string | undefined;
      try {
        attempt.approval = await executor!.prepareApproval(tool, signal);
      } catch (error) {
        signal.throwIfAborted();
        unavailable =
          error instanceof Error
            ? error.message
            : "This action cannot be reviewed on this page.";
      }
      signal.throwIfAborted();
      attempt.confirmed = await new Promise<boolean>((resolve, reject) => {
        const finish = (confirmed: boolean) => {
          if (confirmed && unavailable) return;
          signal.removeEventListener("abort", cancel);
          if (approvalChoice?.id === tool.id) approvalChoice = undefined;
          update({ approval: null });
          resolve(confirmed);
        };
        const cancel = () => {
          if (approvalChoice?.id === tool.id) approvalChoice = undefined;
          update({ approval: null });
          reject(signal.reason);
        };
        approvalChoice = { id: tool.id, resolve: finish };
        signal.addEventListener("abort", cancel, { once: true });
        update({
          approval: {
            invocationId: tool.id,
            title: attempt!.approval?.title ?? "This action needs your review",
            details: attempt!.approval?.details ?? [],
            ...(unavailable ? { unavailable } : {}),
          },
        });
      });
    }
    signal.throwIfAborted();
    if (attempt.attempts++ >= 5) return;
    if (!attempt.outcome) {
      const claimed = await rawApi(`/tools/${tool.id}/claim`, {
        ...attempt.claim,
        ...(needsApproval ? { confirmed: attempt.confirmed } : {}),
      });
      if (!record(claimed) || claimed.claimed !== true) {
        if (record(claimed) && claimed.claimed === false) {
          toolAttempts.delete(tool.id);
          return needsApproval && attempt.confirmed === false;
        }
        throw new Error(
          "Roman could not confirm ownership of this storefront action.",
        );
      }
      if (needsApproval && attempt.confirmed !== true)
        throw new Error(
          "The cancelled action was not executed. Refresh Roman to check its status.",
        );
      if (disposed || ending || signal.aborted || startedEpoch !== epoch)
        return;
      try {
        if (attempt.abandoned)
          throw new Error(
            "This action was interrupted. Check the product or cart before requesting another change; Roman will not repeat it automatically.",
          );
        attempt.outcome = {
          result: needsApproval
            ? await executor!.executeApproved(tool, attempt.approval!, signal)
            : tool.name === "apply_measurements"
              ? await executor!.execute(
                  "apply_measurements",
                  tool.arguments,
                  signal,
                )
              : tool.name === "navigate"
                ? await executor!.execute("navigate", tool.arguments, signal)
                : tool.name === "open_checkout"
                  ? await executor!.execute("open_checkout", tool.arguments, signal)
                : tool.name === "show_view"
                  ? await executor!.execute("show_view", tool.arguments, signal)
                  : tool.name === "get_product_guides" ||
                      tool.name === "discover_guides" ||
                      tool.name === "get_store_support"
                    ? await executor!.execute(tool.name, tool.arguments, signal)
                    : tool.name === "get_cart" ||
                        tool.name === "add_to_cart" ||
                        tool.name === "add_sample_to_cart"
                      ? await executor!.execute(
                          tool.name,
                          tool.arguments,
                          signal,
                        )
                      : tool.name === "get_product_configuration" ||
                          tool.name === "configure_product"
                        ? await executor!.execute(
                            tool.name,
                            tool.arguments,
                            signal,
                          )
                        : await executor!.execute(
                            tool.name as
                              | "search_products"
                              | "get_product"
                              | "lookup_catalog",
                            tool.arguments,
                            signal,
                          ),
        };
      } catch (error) {
        attempt.outcome = {
          error: (error instanceof Error
            ? error.message
            : "The storefront tool failed."
          ).slice(0, 500),
        };
      }
    }
    if (disposed || ending || signal.aborted || startedEpoch !== epoch) return;
    await api(`/tools/${tool.id}/result`, {
      ...attempt.claim,
      ...attempt.outcome,
    });
    toolAttempts.delete(tool.id);
    return true;
  }

  function hasPendingWork() {
    return (
      state.pending ||
      state.conversation?.busy ||
      !!state.conversation?.tools.length ||
      !!state.conversation?.messages.some(
        (message) => message.status === "pending",
      )
    );
  }

  function schedulePoll(delay = hasPendingWork() ? 250 : 500) {
    window.clearTimeout(pollTimer);
    if (
      !disposed &&
      (hasPendingWork() ||
        state.conversation?.voice?.status === "starting" ||
        state.conversation?.voice?.status === "active" ||
        voiceId)
    )
      pollTimer = window.setTimeout(() => {
        void poll();
      }, delay);
  }

  async function poll() {
    if (disposed || polling || state.pending || ending) return;
    polling = true;
    const requestedEpoch = epoch;
    try {
      await api();
      pollFailures = 0;
      update({ error: null });
      schedulePoll();
    } catch (error) {
      if (requestedEpoch !== epoch || disposed) return;
      update({
        error:
          error instanceof Error
            ? error.message
            : "Roman could not refresh this conversation.",
      });
      pollFailures += 1;
      if (pollFailures < 5)
        schedulePoll(Math.min(500 * 2 ** pollFailures, 8000));
    } finally {
      polling = false;
      if (pollAfterCurrent) {
        pollAfterCurrent = false;
        if (
          pollFailures === 0 &&
          requestedEpoch === epoch &&
          !disposed &&
          !ending &&
          state.voice.status !== "stopping"
        ) {
          window.clearTimeout(pollTimer);
          void poll();
        }
      }
    }
  }

  function closeVoiceLocally() {
    voiceEpoch++;
    queuedVoiceInput?.cancel?.();
    queuedVoiceInput = undefined;
    voiceConnection?.close();
    voiceConnection = undefined;
    window.clearTimeout(heartbeatTimer);
    window.clearTimeout(voiceLimitTimer);
    toolController?.abort();
  }

  function bestEffortVoiceStop(id: string, credential = access) {
    if (!credential) return;
    // Page exit must stop microphone/playback synchronously. A keepalive stop
    // releases the server lease when possible; the lease bounds lost requests.
    void window
      .fetch(
        `${credential.apiBaseUrl}/${credential.conversationId}/voice/${id}/stop`,
        {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          keepalive: true,
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientId }),
        },
      )
      .catch(() => undefined);
  }

  async function stopVoice(reason?: "connection_lost") {
    if (disposed) return;
    if (voiceStop) return voiceStop;
    const previous = state.conversation?.voice;
    const remote =
      previous &&
      (previous.status === "starting" || previous.status === "active")
        ? previous
        : undefined;
    const id = voiceId ?? remote?.id;
    const ownerClientId = voiceId ? clientId : remote?.clientId;
    closeVoiceLocally();
    const stoppedEpoch = epoch;
    const stoppedVoiceEpoch = voiceEpoch;
    const current = () =>
      !disposed && stoppedEpoch === epoch && stoppedVoiceEpoch === voiceEpoch;
    if (!id) {
      update({ voice: idleVoice });
      return;
    }
    update({
      voice: { ...state.voice, status: "stopping", muted: true, error: null },
    });
    const stopping = (async () => {
      try {
        await api(`/voice/${id}/stop`, {
          clientId: ownerClientId,
          ...(reason ? { reason } : {}),
        });
        if (!current()) return;
        if (voiceId === id) voiceId = undefined;
        const terminal = state.conversation?.voice;
        update({
          voice:
            terminal?.id === id && terminal.status === "failed"
              ? {
                  status: "error",
                  muted: false,
                  error:
                    terminal.error || "Voice ended. You can continue in text.",
                }
              : idleVoice,
        });
        pollFailures = 0;
        schedulePoll();
      } catch (error) {
        if (!current()) return;
        update({
          voice: {
            status: "error",
            muted: true,
            error:
              "Microphone stopped. Roman could not confirm voice ended; retry Stop voice before sending text.",
          },
        });
        schedulePoll();
        throw error;
      }
    })();
    voiceStop = stopping;
    void stopping
      .finally(() => {
        if (voiceStop === stopping) voiceStop = undefined;
      })
      .catch(() => undefined);
    return voiceStop;
  }

  async function sendVoiceAnswer(questionId: string, answer: string) {
    return sendVoiceSelection({ questionId, answer });
  }

  async function sendVoiceProductChoice(
    carouselId: string,
    product: Pick<CatalogProduct, "id" | "title" | "url">,
  ) {
    const url = new URL(product.url, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password)
      throw new Error("Choose a product from this storefront.");
    return sendVoiceSelection(
      parseProductChoice({
        carouselId,
        productId: product.id,
        title: product.title,
        productPath: url.pathname,
      }),
    );
  }

  async function sendVoiceSelection(
    selection:
      | { questionId: string; answer: string }
      | { text: string }
      | import("../../../shared/product-choice").ProductChoice,
  ) {
    if (disposed) throw new Error("Roman has been removed.");
    let id = voiceId;
    const starting =
      "text" in selection && state.voice.status === "starting" && voiceStart;
    const startedEpoch = epoch;
    const startedVoiceEpoch = voiceEpoch;
    if (
      (!starting && (!id || !access || state.voice.status !== "active")) ||
      ending ||
      state.pending ||
      state.restoring ||
      state.conversation?.busy ||
      (!starting && state.conversation?.status !== "active")
    )
      throw new Error(
        "Wait until voice is connected here and Roman has finished replying.",
      );
    const question = latestQuestion(
      state.conversation?.messages ?? [],
      window.location.pathname,
    );
    if (
      "questionId" in selection &&
      (question?.invocationId !== selection.questionId ||
        !isQuestionAnswer(question, selection.answer))
    )
      throw new Error("This question is no longer waiting for that answer.");
    if (
      "carouselId" in selection &&
      !state.conversation?.messages.some(
        (message) =>
          message.status === "complete" &&
          ["assistant", "context"].includes(message.role) &&
          message.parts.some(
            (part) =>
              part.type === "products" &&
              part.invocationId === selection.carouselId &&
              part.productIds.includes(selection.productId),
          ),
      )
    )
      throw new Error(
        "Choose a product shown in this conversation's carousel.",
      );
    const answer =
      "text" in selection
        ? selection.text
        : "questionId" in selection
          ? selection.answer
          : productChoiceText(selection);
    const provenance =
      "questionId" in selection && id
        ? { questionId: selection.questionId, voiceId: id }
        : undefined;
    const productProvenance =
      "carouselId" in selection && id
        ? { ...selection, voiceId: id }
        : undefined;
    const current = () =>
      !disposed &&
      !ending &&
      epoch === startedEpoch &&
      voiceEpoch === startedVoiceEpoch &&
      voiceId === id;
    const submission =
      id &&
      uncertainVoiceAnswer?.voiceId === id &&
      Object.entries(selection).every(
        ([key, value]) =>
          (uncertainVoiceAnswer as unknown as Record<string, unknown>)[key] ===
          value,
      )
        ? uncertainVoiceAnswer
        : {
            requestId: window.crypto.randomUUID(),
            voiceId: id,
            clientId,
            ...selection,
          };
    if (id) uncertainVoiceAnswer = { ...submission, voiceId: id };
    const queued: typeof queuedVoiceInput =
      starting && "text" in selection
        ? {
            requestId: submission.requestId,
            text: selection.text,
            claimed: false,
          }
        : undefined;
    if (queued) queuedVoiceInput = queued;
    const cancelled = queued
      ? new Promise<void>((_resolve, reject) => {
          queued.cancel = () =>
            reject(new Error("Voice was stopped. Please retry your message."));
        })
      : undefined;
    update({
      pending: true,
      error: null,
      optimisticMessage: pendingUserMessage(
        submission.requestId,
        answer,
        provenance,
        productProvenance,
      ),
    });
    try {
      if (starting) {
        await Promise.race([starting, cancelled!]);
        id = voiceId;
        if (!current() || !id || state.voice.status !== "active")
          throw new Error(
            "Voice was stopped before your message could be sent. Please retry your message.",
          );
        uncertainVoiceAnswer = { ...submission, voiceId: id };
      }
      if (queued?.claimed) {
        // /ready accepted this customer input before opening Roman's voice.
        await api();
      } else {
        await api(`/voice/${id}/answers`, {
          clientId,
          requestId: submission.requestId,
          ...selection,
        });
      }
      if (!current()) return;
      uncertainVoiceAnswer = null;
      pollFailures = 0;
      schedulePoll();
    } catch (error) {
      if (queued?.claimed && !disposed && !ending && epoch === startedEpoch) {
        // A lost /ready response can stop voice after the input was saved.
        // Drain that stop and reconcile before offering a duplicate submission.
        await voiceStop?.catch(() => undefined);
        if (!disposed && !ending && epoch === startedEpoch && access) {
          const accepted = () =>
            state.conversation?.messages.some(
              (message) =>
                message.id === submission.requestId &&
                message.role === "user" &&
                message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    part.text === answer &&
                    part.voiceInput?.voiceId === queued.voiceId,
                ),
            );
          if (!accepted()) {
            try {
              await api();
            } catch {
              /* Preserve the original voice error. */
            }
          }
          if (!disposed && !ending && epoch === startedEpoch && accepted()) {
            uncertainVoiceAnswer = null;
            return;
          }
        }
      }
      if (!current()) throw error;
      const message =
        error instanceof Error
          ? error.message
          : "Roman could not receive your answer. Please try again.";
      update({ error: message });
      // Reconcile accepted answers after a lost response; never replay a live cue.
      try {
        await api();
        if (current()) {
          schedulePoll();
          if (
            error instanceof SessionRequestError &&
            error.status === 0 &&
            state.conversation?.messages.some(
              (message) =>
                message.id === submission.requestId &&
                message.role === "user" &&
                message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    part.text === answer &&
                    ("text" in selection
                      ? part.voiceInput?.voiceId === id
                      : "questionId" in selection
                        ? part.questionAnswer?.questionId ===
                            selection.questionId &&
                          part.questionAnswer.voiceId === id
                        : JSON.stringify(part.productChoice) ===
                          JSON.stringify(productProvenance)),
                ),
            )
          ) {
            uncertainVoiceAnswer = null;
            update({ error: null });
            return;
          }
        }
      } catch {
        /* Retain the original submission error and retry identity. */
      }
      throw new Error(message);
    } finally {
      if (queued) queued.cancel = undefined;
      if (queuedVoiceInput === queued) queuedVoiceInput = undefined;
      if (epoch === startedEpoch)
        update({
          ...(!ending ? { pending: false } : {}),
          optimisticMessage: null,
        });
    }
  }

  function failVoice(message: string) {
    const failureEpoch = epoch;
    const stopping = stopVoice("connection_lost");
    const failureVoiceEpoch = voiceEpoch;
    void stopping
      .then(() => {
        if (
          !disposed &&
          epoch === failureEpoch &&
          voiceEpoch === failureVoiceEpoch
        )
          update({ voice: { status: "error", muted: false, error: message } });
      })
      .catch(() => undefined);
  }

  function scheduleHeartbeat(id: string, startedVoiceEpoch: number) {
    window.clearTimeout(heartbeatTimer);
    if (disposed || voiceId !== id || startedVoiceEpoch !== voiceEpoch) return;
    heartbeatTimer = window.setTimeout(() => {
      void rawApi(`/voice/${id}/heartbeat`, { clientId })
        .then((result) => {
          if (!record(result) || result.ok !== true)
            throw new Error("Voice heartbeat failed.");
          scheduleHeartbeat(id, startedVoiceEpoch);
        })
        .catch(() => {
          if (voiceId !== id || startedVoiceEpoch !== voiceEpoch || disposed)
            return;
          const message =
            "Voice lost its connection. Your microphone has stopped; start voice again to reconnect.";
          failVoice(message);
        });
    }, 20_000);
  }

  function startVoice() {
    if (voiceStart)
      return Promise.reject(new Error("Voice is already connecting."));
    const starting = connectVoice();
    voiceStart = starting;
    void starting
      .finally(() => {
        if (voiceStart === starting) voiceStart = undefined;
      })
      .catch(() => undefined);
    return starting;
  }

  async function connectVoice() {
    if (
      disposed ||
      ending ||
      state.pending ||
      state.restoring ||
      state.conversation?.busy ||
      state.conversation?.voice?.status === "starting" ||
      state.conversation?.voice?.status === "active" ||
      voiceId ||
      state.voice.status === "starting" ||
      state.voice.status === "stopping"
    )
      throw new Error("Wait for Roman's current session to finish.");
    if (!isConversationStorefront(window.location.origin)) {
      const error =
        "Voice is available on the installed development storefronts.";
      update({ voice: { status: "error", muted: false, error } });
      throw new Error(error);
    }
    const startedVoiceEpoch = ++voiceEpoch;
    const selectedVoice = state.selectedVoice;
    const startedEpoch = epoch;
    const current = () =>
      !disposed &&
      !ending &&
      epoch === startedEpoch &&
      voiceEpoch === startedVoiceEpoch;
    update({
      voice: { status: "starting", muted: false, error: null },
      error: null,
    });
    const connection = createVoiceConnection((message) => {
      if (!current()) return;
      failVoice(message);
    });
    voiceConnection = connection;
    try {
      // Permission precedes bootstrap, so denying the microphone creates no chat.
      const sdp = await connection.prepare(async () => {
        if (!current()) return;
        if (!access) await bootstrap(resumeAccess);
        if (!current()) return;
        await journeyQueue;
      });
      if (!current()) return;
      await journeyQueue;
      if (!current()) return;
      const id = window.crypto.randomUUID();
      voiceId = id;
      const result = await rawApi("/voice", {
        requestId: id,
        clientId,
        sdp,
        voice: selectedVoice,
      });
      if (!current()) {
        bestEffortVoiceStop(id);
        return;
      }
      if (
        !record(result) ||
        result.voiceId !== id ||
        typeof result.sdp !== "string" ||
        !result.sdp ||
        result.sdp.length > 65_536
      )
        throw new Error("Roman received an invalid voice connection response.");
      scheduleHeartbeat(id, startedVoiceEpoch);
      schedulePoll();
      await connection.connect(result.sdp, async () => {
        if (!current()) throw new Error("Voice was stopped.");
        const input = queuedVoiceInput;
        if (input) {
          input.claimed = true;
          input.voiceId = id;
        }
        const ready = await rawApi(`/voice/${id}/ready`, {
          clientId,
          ...(input
            ? { input: { requestId: input.requestId, text: input.text } }
            : {}),
        });
        if (!current()) return;
        if (!record(ready) || ready.ok !== true)
          throw new Error("Roman could not begin voice. Please try again.");
      });
      if (!current()) return;
      update({ voice: { status: "active", muted: false, error: null } });
      voiceLimitTimer = window.setTimeout(() => {
        void stopVoice().catch(() => undefined);
      }, 10 * 60_000);
      void poll();
    } catch (error) {
      connection.close();
      if (!current()) return;
      const message =
        error instanceof Error ? error.message : "Roman could not start voice.";
      const stopping = stopVoice();
      const stoppedVoiceEpoch = voiceEpoch;
      try {
        await stopping;
      } catch {
        return;
      }
      if (
        disposed ||
        epoch !== startedEpoch ||
        voiceEpoch !== stoppedVoiceEpoch
      )
        return;
      update({
        voice: {
          status: "error",
          muted: false,
          error: message,
          ...(error instanceof MicrophonePermissionError
            ? { errorCode: "microphone_denied" as const }
            : {}),
        },
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  function onPageHide() {
    const id = voiceId;
    closeVoiceLocally();
    if (id) bestEffortVoiceStop(id);
    voiceId = undefined;
    update({ voice: idleVoice });
  }

  function restore() {
    let saved: unknown;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      saved = access ?? resumeAccess;
    }
    if (!credential(saved) || Date.parse(saved.expiresAt) <= Date.now()) {
      if (access || resumeAccess || state.restoring || saved != null) reset();
      return;
    }
    toolController?.abort();
    const restoredEpoch = ++epoch;
    resumeAccess = saved;
    update({ restoring: true });
    // The signed proxy supplies the current backend origin, including tunnel changes.
    void bootstrap(saved)
      .then(async () => {
        await api();
        schedulePoll();
      })
      .catch((error: unknown) => {
        if (restoredEpoch !== epoch || disposed) return;
        if (
          error instanceof SessionRequestError &&
          [401, 404, 410].includes(error.status)
        ) {
          access = null;
          resumeAccess = null;
          persist();
        }
        update({
          error:
            error instanceof Error
              ? error.message
              : "Roman could not restore this conversation.",
        });
      })
      .finally(() => {
        if (restoredEpoch === epoch) update({ restoring: false });
      });
  }
  restoreVoiceChoice();
  restore();
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) {
      restoreVoiceChoice();
      restore();
    }
  }
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);

  return {
    sendVoiceAnswer,
    sendVoiceProductChoice,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async sendMessage(value, selectedProduct) {
      const choice = selectedProduct
        ? parseProductChoice(selectedProduct)
        : undefined;
      const text = value.trim();
      if (choice && text !== productChoiceText(choice))
        throw new Error(
          "The selected product message does not match this choice.",
        );
      if (disposed) throw new Error("Roman has been removed.");
      if (!text || text.length > MAX_MESSAGE_LENGTH)
        throw new Error(
          `Enter a message of up to ${MAX_MESSAGE_LENGTH} characters.`,
        );
      if (state.voice.status === "starting" || state.voice.status === "active")
        return sendVoiceSelection(choice ?? { text });
      if (
        ending ||
        voiceId ||
        state.voice.status === "stopping" ||
        state.conversation?.voice?.status === "starting" ||
        state.conversation?.voice?.status === "active" ||
        state.pending ||
        state.restoring ||
        state.conversation?.busy
      )
        throw new Error("Wait for Roman's current reply.");
      if (!isConversationStorefront(window.location.origin)) {
        const error =
          "Text chat is available on the installed development storefronts. This local preview shows the interface only.";
        update({ error });
        throw new Error(error);
      }
      const startedEpoch = epoch;
      const submission =
        uncertainSubmission?.text === text &&
        JSON.stringify(uncertainSubmission.productChoice) ===
          JSON.stringify(choice)
          ? uncertainSubmission
          : {
              requestId: window.crypto.randomUUID(),
              text,
              ...(choice ? { productChoice: choice } : {}),
            };
      uncertainSubmission = submission;
      update({
        pending: true,
        error: null,
        optimisticMessage: pendingUserMessage(
          submission.requestId,
          text,
          undefined,
          choice,
        ),
      });
      try {
        if (!access) await bootstrap(resumeAccess);
        await journeyQueue;
        if (disposed || ending || epoch !== startedEpoch)
          throw new Error("The conversation has changed.");
        await api("/messages", submission);
        if (disposed || epoch !== startedEpoch)
          throw new Error("The conversation has changed.");
        uncertainSubmission = null;
        pollFailures = 0;
        schedulePoll();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Roman could not send your message.";
        if (epoch === startedEpoch) update({ error: message });
        // A lost POST response may still have started a turn. Reconcile without replaying it.
        if (access && !disposed && epoch === startedEpoch) {
          try {
            await api();
            schedulePoll();
            if (
              state.conversation?.messages.some(
                (row) =>
                  row.role === "user" && row.requestId === submission.requestId,
              )
            ) {
              uncertainSubmission = null;
              update({ error: null });
              return;
            }
          } catch {
            /* Preserve the original actionable error. */
          }
        }
        throw new Error(message);
      } finally {
        if (epoch === startedEpoch)
          update({ pending: false, optimisticMessage: null });
      }
    },
    recordPage(input) {
      if (
        disposed ||
        ending ||
        !access ||
        state.restoring ||
        state.conversation?.status !== "active"
      )
        return Promise.resolve();
      const observedEpoch = epoch;
      const observation = { ...input, requestId: window.crypto.randomUUID() };
      const task = journeyQueue.then(async () => {
        if (disposed || ending || epoch !== observedEpoch) return;
        try {
          await api("/journey", observation);
        } catch (error) {
          if (!disposed && epoch === observedEpoch)
            update({
              error:
                "Roman could not save this page visit. Chat can continue; retry the connection to refresh.",
            });
          throw error;
        }
      });
      journeyQueue = task.catch(() => undefined);
      return task;
    },
    async executeMeasurements(name, input, signal) {
      const call = parseMeasurementCall(name, input);
      signal?.throwIfAborted();
      if (
        disposed ||
        ending ||
        state.pending ||
        state.restoring ||
        state.conversation?.busy
      )
        throw new Error(
          "Wait for Roman's current work before changing measurements.",
        );
      if (!isConversationStorefront(window.location.origin))
        throw new Error(
          "Persistent measurements are available on the installed development storefronts.",
        );
      const key = JSON.stringify(call);
      if (
        name === "set_measurements" &&
        uncertainMeasurement &&
        uncertainMeasurement.key !== key
      )
        throw new Error(
          "The previous measurement save is unconfirmed. Retry those same values before saving different measurements.",
        );
      const startedEpoch = epoch;
      update({ pending: true });
      try {
        if (!access) await bootstrap(resumeAccess);
        signal?.throwIfAborted();
        if (disposed || ending || epoch !== startedEpoch)
          throw new Error("The conversation changed.");
        if (name === "set_measurements")
          uncertainMeasurement ??= {
            requestId: window.crypto.randomUUID(),
            key,
          };
        const response = await rawApi(
          "/measurements",
          {
            requestId:
              name === "set_measurements"
                ? uncertainMeasurement!.requestId
                : window.crypto.randomUUID(),
            ...call,
          },
          signal,
        );
        if (disposed || ending || epoch !== startedEpoch)
          throw new Error("The conversation changed.");
        if (!record(response))
          throw new Error("Roman received an invalid measurement response.");
        const result = parseMeasurementToolResult(response.result);
        const path =
          result.status === "not_found"
            ? result.productPath
            : result.draft.productPath;
        if (
          path !== call.arguments.productPath ||
          (name === "set_measurements"
            ? result.status !== "saved"
            : result.status === "saved")
        )
          throw new Error(
            "Roman received a measurement result for a different request.",
          );
        if (name === "set_measurements") uncertainMeasurement = null;
        readVersion = undefined;
        try {
          await api();
        } catch {
          if (!disposed && !ending && epoch === startedEpoch)
            update({
              error:
                "Your measurement request completed, but the chat could not refresh. Reopen Roman to refresh it.",
            });
        }
        return result;
      } catch (error) {
        if (
          name === "set_measurements" &&
          error instanceof SessionRequestError &&
          [400, 401, 404, 409, 429].includes(error.status)
        )
          uncertainMeasurement = null;
        throw error;
      } finally {
        if (!disposed && epoch === startedEpoch) update({ pending: false });
      }
    },
    getCachedProducts(ids) {
      if (
        !executor ||
        disposed ||
        ending ||
        state.conversation?.status !== "active"
      )
        return [];
      return executor.getCachedProducts(ids);
    },
    loadProducts(ids, signal) {
      if (
        !executor ||
        disposed ||
        ending ||
        state.conversation?.status !== "active"
      )
        return Promise.reject(
          new Error("Start a chat to load these products."),
        );
      return executor.loadProducts(ids, signal);
    },
    loadProductImage(url, signal, maxWidth) {
      if (
        !executor ||
        disposed ||
        ending ||
        state.conversation?.status !== "active"
      )
        return Promise.reject(
          new Error("Start a chat to load product images."),
        );
      return executor.loadProductImage(url, signal, maxWidth);
    },
    loadProductGallery(url, signal) {
      if (
        !executor ||
        disposed ||
        ending ||
        state.conversation?.status !== "active"
      )
        return Promise.reject(
          new Error("Start a chat to load product images."),
        );
      return executor.loadProductGallery(url, signal);
    },
    resolveToolApproval(invocationId, confirmed) {
      if (approvalChoice?.id === invocationId && typeof confirmed === "boolean")
        approvalChoice.resolve(confirmed);
    },
    startVoice() {
      setVoiceAutostartPreference(true);
      return startVoice();
    },
    setVoice,
    stopVoice() {
      setVoiceAutostartPreference(false);
      return stopVoice();
    },
    setVoiceMuted(muted) {
      if (state.voice.status !== "active") return;
      voiceConnection?.setMuted(muted);
      update({ voice: { ...state.voice, muted } });
    },
    async end() {
      setVoiceAutostartPreference(false);
      if (!access || disposed || ending) return;
      ending = true;
      closeVoiceLocally();
      const hadVoice = voiceId || state.voice.status === "starting";
      if (hadVoice)
        update({ voice: { status: "stopping", muted: true, error: null } });
      toolController?.abort();
      update({ pending: true, error: null });
      try {
        await api("/end", {});
        reset();
      } catch (error) {
        update({ error: "Roman could not end this chat. Please retry." });
        if (hadVoice)
          update({
            voice: {
              status: "error",
              muted: true,
              error:
                "Microphone stopped. Use End voice to confirm voice has ended.",
            },
          });
        throw error;
      } finally {
        ending = false;
        update({ pending: false });
      }
    },
    clearError() {
      pollFailures = 0;
      update({ error: null });
      if (access) void poll();
    },
    dispose() {
      onPageHide();
      disposed = true;
      toolController?.abort();
      lifetime.abort();
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(pollTimer);
      listeners.clear();
    },
  };
}
