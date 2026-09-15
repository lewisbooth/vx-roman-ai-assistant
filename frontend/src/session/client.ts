import {
  MAX_MESSAGE_LENGTH,
  MAX_CONVERSATION_MESSAGES,
  CONVERSATION_STORAGE_KEY,
  type ConversationBootstrap,
  type ConversationCredential,
  type ConversationSnapshot,
  type ConversationReadVersion,
  type BrowserToolInvocation,
  type ToolClaim,
} from "../../../shared/conversation";
import { parseCatalogCall } from "../../../shared/catalog-tools";
import type { CatalogResult } from "../../../shared/catalog";
import {
  parseNavigationCall,
  type NavigationResult,
} from "../../../shared/navigation-tool";
import type { createStorefrontExecutor } from "./storefront-executor";
import { isConversationStorefront } from "../../../shared/storefronts";
import type { ConversationClient, ConversationClientState } from "./types";
import { createVoiceConnection } from "./voice-connection";
import {
  DEFAULT_LIVE_VOICE,
  isLiveVoice,
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
        if (tool.name === "navigate") parseNavigationCall(tool.arguments);
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
        (message.error === undefined || typeof message.error === "string") &&
        Array.isArray(message.parts) &&
        message.parts.every(
          (part) =>
            record(part) &&
            ((part.type === "text" && typeof part.text === "string") ||
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
                part.productIds.length <= 10 &&
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

export function createConversationClient(
  executor?: ReturnType<typeof createStorefrontExecutor>,
): ConversationClient {
  let state: ConversationClientState = {
    conversation: null,
    pending: false,
    restoring: false,
    error: null,
    voice: idleVoice,
    selectedVoice: DEFAULT_LIVE_VOICE,
  };
  let access: ConversationCredential | null = null;
  let resumeAccess: ConversationCredential | null = null;
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
  let voiceStorageWarned = false;
  let journeyQueue: Promise<unknown> = Promise.resolve();
  let processingTool = false;
  let toolController: AbortController | undefined;
  let activeToolId: string | undefined;
  const clientId = window.crypto.randomUUID();
  const toolAttempts = new Map<
    string,
    {
      claim: ToolClaim;
      attempts: number;
      outcome?:
        { result: CatalogResult | NavigationResult } | { error: string };
    }
  >();
  let uncertainSubmission: { requestId: string; text: string } | null = null;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();

  function update(change: Partial<ConversationClientState>) {
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
      throw new Error("Switch to text before changing the voice.");
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
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
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

  async function bootstrap(resume: ConversationCredential | null) {
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

  async function rawApi(path = "", body?: unknown) {
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
      update({ conversation: result });
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
    toolAttempts.clear();
    pollAfterCurrent = false;
    window.clearTimeout(pollTimer);
    persist();
    update({
      conversation: null,
      pending: false,
      restoring: false,
      error: null,
      voice: idleVoice,
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
      if (!disposed && startedEpoch === epoch && !ending)
        update({
          error:
            error instanceof Error
              ? error.message
              : "The storefront tool could not finish.",
        });
    } finally {
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
    if (attempt.attempts++ >= 5) return;
    if (!attempt.outcome) {
      const claimed = await rawApi(`/tools/${tool.id}/claim`, attempt.claim);
      if (!record(claimed) || claimed.claimed !== true) return;
      if (disposed || ending || signal.aborted || startedEpoch !== epoch)
        return;
      try {
        attempt.outcome = {
          result:
            tool.name === "navigate"
              ? await executor!.execute("navigate", tool.arguments, signal)
              : await executor!.execute(tool.name, tool.arguments, signal),
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

  async function stopVoice() {
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
        await api(`/voice/${id}/stop`, { clientId: ownerClientId });
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

  function failVoice(message: string) {
    const failureEpoch = epoch;
    const stopping = stopVoice();
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

  async function startVoice() {
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
      const sdp = await connection.prepare();
      if (!current()) return;
      if (!access) await bootstrap(resumeAccess);
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
        const ready = await rawApi(`/voice/${id}/ready`, { clientId });
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
      update({ voice: { status: "error", muted: false, error: message } });
      throw new Error(message);
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
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async sendMessage(value) {
      const text = value.trim();
      if (disposed) throw new Error("Roman has been removed.");
      if (!text || text.length > MAX_MESSAGE_LENGTH)
        throw new Error(
          `Enter a message of up to ${MAX_MESSAGE_LENGTH} characters.`,
        );
      if (
        ending ||
        voiceId ||
        state.voice.status === "starting" ||
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
      update({ pending: true, error: null });
      try {
        if (!access) await bootstrap(resumeAccess);
        await journeyQueue;
        uncertainSubmission =
          uncertainSubmission?.text === text
            ? uncertainSubmission
            : { requestId: window.crypto.randomUUID(), text };
        await api("/messages", uncertainSubmission);
        uncertainSubmission = null;
        pollFailures = 0;
        schedulePoll();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Roman could not send your message.";
        update({ error: message });
        // A lost POST response may still have started a turn. Reconcile without replaying it.
        if (access && !disposed) {
          try {
            await api();
            schedulePoll();
          } catch {
            /* Preserve the original actionable error. */
          }
        }
        throw new Error(message);
      } finally {
        update({ pending: false });
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
    startVoice,
    setVoice,
    stopVoice,
    setVoiceMuted(muted) {
      if (state.voice.status !== "active") return;
      voiceConnection?.setMuted(muted);
      update({ voice: { ...state.voice, muted } });
    },
    async end() {
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
                "Microphone stopped. Switch to text to confirm voice has ended.",
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
