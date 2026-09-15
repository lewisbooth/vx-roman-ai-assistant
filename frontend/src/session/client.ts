import {
  MAX_MESSAGE_LENGTH,
  type ConversationBootstrap,
  type ConversationCredential,
  type ConversationSnapshot,
} from "../../../shared/conversation";
import type { ConversationClient, ConversationClientState } from "./types";

const STORAGE_KEY = "roman:conversation";
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
    Array.isArray(value.messages) &&
    value.messages.length <= 80 &&
    value.messages.every(
      (message) =>
        record(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        ["pending", "complete", "failed"].includes(String(message.status)) &&
        typeof message.createdAt === "string" &&
        (message.error === undefined || typeof message.error === "string") &&
        Array.isArray(message.parts) &&
        message.parts.every(
          (part) =>
            record(part) &&
            part.type === "text" &&
            typeof part.text === "string",
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

export function createConversationClient(): ConversationClient {
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

  async function api(path = "", body?: unknown) {
    if (!access) throw new SessionRequestError("Start a conversation first.");
    const sequence = ++apiSequence;
    const result = await request(
      `${access.apiBaseUrl}/${access.conversationId}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        mode: "cors",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${access.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!snapshot(result) || result.id !== access.conversationId)
      throw new SessionRequestError(
        "Roman received an invalid conversation response.",
      );
    if (sequence >= appliedSequence) {
      appliedSequence = sequence;
      update({ conversation: result });
    }
  }

  function schedulePoll(delay = 500) {
    window.clearTimeout(pollTimer);
    if (!disposed && state.conversation?.busy)
      pollTimer = window.setTimeout(() => {
        void poll();
      }, delay);
  }

  async function poll() {
    if (disposed || polling || state.pending) return;
    polling = true;
    try {
      await api();
      pollFailures = 0;
      update({ error: null });
      schedulePoll();
    } catch (error) {
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

  let saved: unknown;
  try {
    saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (credential(saved) && Date.parse(saved.expiresAt) > Date.now()) {
    resumeAccess = saved;
    update({ restoring: true });
    // The signed proxy supplies the current backend origin, including tunnel changes.
    void bootstrap(saved)
      .then(async () => {
        await api();
        schedulePoll();
      })
      .catch((error: unknown) => {
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
        update({ restoring: false });
      });
  }

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
      if (state.pending || state.restoring || state.conversation?.busy)
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
    clearError() {
      pollFailures = 0;
      update({ error: null });
      if (access) void poll();
    },
    dispose() {
      disposed = true;
      lifetime.abort();
      window.clearTimeout(pollTimer);
      listeners.clear();
    },
  };
}
