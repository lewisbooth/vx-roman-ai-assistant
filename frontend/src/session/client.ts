import {
  MAX_MESSAGE_LENGTH,
  CONVERSATION_STORAGE_KEY,
  type ConversationBootstrap,
  type ConversationCredential,
  type ConversationSnapshot,
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
import type { ConversationClient, ConversationClientState } from "./types";

const STORAGE_KEY = CONVERSATION_STORAGE_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    value.messages.length <= 280 &&
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
  };
  let access: ConversationCredential | null = null;
  let resumeAccess: ConversationCredential | null = null;
  let disposed = false;
  let pollTimer: number | undefined;
  let pollFailures = 0;
  let polling = false;
  let apiSequence = 0;
  let appliedSequence = 0;
  let epoch = 0;
  let ending = false;
  let journeyQueue: Promise<unknown> = Promise.resolve();
  let processingTool = false;
  let toolController: AbortController | undefined;
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
    if (disposed) return;
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
    const result = await request(
      new URL("/apps/roman/bootstrap", window.location.origin).href,
      {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resume
            ? { conversationId: resume.conversationId, token: resume.token }
            : {},
        ),
      },
    );
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
    const result = await rawApi(path, body);
    if (!snapshot(result) || result.id !== access?.conversationId)
      throw new SessionRequestError(
        "Roman received an invalid conversation response.",
      );
    const revision = state.conversation?.revision ?? -1;
    if (
      result.revision > revision ||
      (result.revision === revision && sequence >= appliedSequence)
    ) {
      appliedSequence = Math.max(sequence, appliedSequence);
      update({ conversation: result });
      if (result.status === "ended") reset();
      else void executePendingTool();
    }
  }

  function reset() {
    toolController?.abort();
    epoch++;
    access = null;
    resumeAccess = null;
    uncertainSubmission = null;
    toolAttempts.clear();
    window.clearTimeout(pollTimer);
    persist();
    update({
      conversation: null,
      pending: false,
      restoring: false,
      error: null,
    });
  }

  async function executePendingTool() {
    if (
      disposed ||
      ending ||
      processingTool ||
      !executor ||
      state.conversation?.status !== "active"
    )
      return;
    const tool = state.conversation.tools.find(
      (item) => item.status === "pending" || toolAttempts.has(item.id),
    );
    if (!tool) return;
    processingTool = true;
    const startedEpoch = epoch;
    const controller = new AbortController();
    toolController = controller;
    try {
      await executeTool(tool, startedEpoch, controller.signal);
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
      if (toolController === controller) toolController = undefined;
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
      if (disposed || ending || startedEpoch !== epoch) return;
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
    if (disposed || ending || startedEpoch !== epoch) return;
    await api(`/tools/${tool.id}/result`, {
      ...attempt.claim,
      ...attempt.outcome,
    });
    toolAttempts.delete(tool.id);
  }

  function schedulePoll(delay = 500) {
    window.clearTimeout(pollTimer);
    if (!disposed && state.conversation?.busy)
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
    }
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
  restore();
  function onPageShow(event: PageTransitionEvent) {
    if (event.persisted) restore();
  }
  window.addEventListener("pageshow", onPageShow);

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
        state.pending ||
        state.restoring ||
        state.conversation?.busy
      )
        throw new Error("Wait for Roman's current reply.");
      if (!window.location.hostname.endsWith(".myshopify.com")) {
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
    loadProducts(ids) {
      if (
        !executor ||
        disposed ||
        ending ||
        state.conversation?.status !== "active"
      )
        return Promise.reject(
          new Error("Start a chat to load these products."),
        );
      return executor.execute("lookup_catalog", { ids });
    },
    async end() {
      if (!access || disposed || ending) return;
      ending = true;
      toolController?.abort();
      update({ pending: true, error: null });
      try {
        await api("/end", {});
        reset();
      } catch (error) {
        update({ error: "Roman could not end this chat. Please retry." });
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
      disposed = true;
      toolController?.abort();
      lifetime.abort();
      window.removeEventListener("pageshow", onPageShow);
      window.clearTimeout(pollTimer);
      listeners.clear();
    },
  };
}
