import type {
  ConversationSnapshot,
  SendMessageInput,
} from "../../shared/conversation";
import { ConversationError } from "./errors.server";
import { requestBrowserTool } from "./browser-tools.server";
import { generateReply, TEXT_MODEL, type ModelReply } from "./model.server";
import { recordModelUsage } from "../usage/repository.server";
import {
  beginTurn,
  failPending,
  finishTurn,
  getSnapshot,
  endConversation,
} from "./repository.server";

interface ActiveTurn {
  requestId: string;
  assistantId: string | null;
  text: string;
  ready: Promise<void>;
  controller: AbortController;
  voiceId?: string;
}

// One process owns generation in the single-VM deployment. A durable pending row
// survives disconnects; the bounded map only holds live partial text.
const active = new Map<string, ActiveTurn>();
const ending = new Set<string>();
const MAX_CONCURRENT_TURNS = 4;

export async function readConversation(
  id: string,
): Promise<ConversationSnapshot> {
  await active.get(id)?.ready;
  if (!active.has(id)) await failPending(id);
  const snapshot = await getSnapshot(id);
  const turn = active.get(id);
  if (turn?.assistantId && !turn.voiceId) {
    snapshot.messages = snapshot.messages.map((message) =>
      message.id === turn.assistantId && message.status === "pending"
        ? {
            ...message,
            parts: [
              { type: "text", text: turn.text },
              ...message.parts.filter((part) => part.type !== "text"),
            ],
          }
        : message,
    );
  }
  return snapshot;
}

export async function startTurn(
  id: string,
  input: SendMessageInput,
): Promise<ConversationSnapshot> {
  if (ending.has(id))
    throw new ConversationError(409, "This conversation is ending.");
  const existing = active.get(id);
  if (existing) {
    if (existing.requestId !== input.requestId) {
      throw new ConversationError(
        409,
        "Roman is still replying. Wait for that reply before sending another message.",
      );
    }
    await existing.ready;
    if (!active.has(id)) return startTurn(id, input);
    // The repository checks the idempotency key before reporting a busy turn.
    const replay = await beginTurn(id, input);
    return replay.snapshot;
  }
  if (active.size >= MAX_CONCURRENT_TURNS) {
    throw new ConversationError(
      429,
      "Roman is helping other customers. Please try again shortly.",
    );
  }
  let initialized!: () => void;
  const turn: ActiveTurn = {
    requestId: input.requestId,
    assistantId: null,
    text: "",
    controller: new AbortController(),
    ready: new Promise<void>((resolve) => {
      initialized = resolve;
    }),
  };
  active.set(id, turn);
  try {
    await failPending(id);
    const started = await beginTurn(id, input);
    if (!started.assistantId) {
      active.delete(id);
      return started.snapshot;
    }
    turn.assistantId = started.assistantId;
    // Generation belongs to the server, not to the lifetime of the HTTP request.
    void completeTurn(id, started.assistantId, started.history, turn);
    return started.snapshot;
  } catch (error) {
    active.delete(id);
    throw error;
  } finally {
    initialized();
  }
}

async function completeTurn(
  id: string,
  assistantId: string,
  history: Parameters<typeof generateReply>[0],
  turn: ActiveTurn,
): Promise<ModelReply | undefined> {
  try {
    const signal = AbortSignal.any([
      turn.controller.signal,
      AbortSignal.timeout(90_000),
    ]);
    const reply = await generateReply(
      history,
      (text) => {
        turn.text = text;
      },
      signal,
      (callId, name, input) =>
        requestBrowserTool(id, assistantId, callId, name, input, signal),
      turn.voiceId ? "voice" : "text",
      (usage) => recordModelUsage(id, assistantId, usage),
    );
    signal.throwIfAborted();
    await finishTurn(id, assistantId, { ...reply, status: "complete" });
    return reply;
  } catch (error) {
    if (turn.controller.signal.aborted) return;
    // Provider messages can include request data. Keep diagnostics categorical.
    console.error("[Roman] Text reply failed.", {
      conversationId: id,
      category: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      await finishTurn(id, assistantId, {
        text: turn.text,
        status: "failed",
        error:
          "Roman could not finish this reply. Please send another message to continue.",
        model: TEXT_MODEL,
      });
    } catch {
      console.error("[Roman] Could not save the failed reply.", {
        conversationId: id,
      });
    }
  } finally {
    if (active.get(id) === turn) active.delete(id);
  }
}

/** Uses the same bounded runner and browser executor without duplicating spoken text. */
export async function runVoiceDelegation(
  id: string,
  voiceId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<ModelReply | undefined> {
  signal.throwIfAborted();
  if (ending.has(id) || active.has(id))
    throw new ConversationError(
      409,
      "Roman is already working on this conversation.",
    );
  if (active.size >= MAX_CONCURRENT_TURNS)
    throw new ConversationError(
      429,
      "Roman is helping other customers. Please try again shortly.",
    );
  let initialized!: () => void;
  const turn: ActiveTurn = {
    requestId,
    assistantId: null,
    text: "",
    voiceId,
    ready: new Promise<void>((resolve) => {
      initialized = resolve;
    }),
    controller: new AbortController(),
  };
  const abort = () => turn.controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  active.set(id, turn);
  try {
    const started = await beginTurn(id, { requestId, text: "" }, voiceId);
    turn.assistantId = started.assistantId;
    initialized();
    if (!started.assistantId) return;
    if (signal.aborted) {
      await finishTurn(id, started.assistantId, {
        text: "",
        status: "failed",
        error: "Voice work was interrupted.",
      });
      return;
    }
    return await completeTurn(id, started.assistantId, started.history, turn);
  } finally {
    initialized();
    signal.removeEventListener("abort", abort);
    if (active.get(id) === turn) active.delete(id);
  }
}

export async function cancelVoiceDelegation(id: string, voiceId: string) {
  const turn = active.get(id);
  if (!turn || turn.voiceId !== voiceId) return;
  turn.controller.abort();
  await turn.ready;
  if (turn.assistantId)
    await finishTurn(id, turn.assistantId, {
      text: "",
      status: "failed",
      error:
        "Voice work was interrupted. Check the page before repeating an action.",
    });
  if (active.get(id) === turn) active.delete(id);
}

export async function endTurn(id: string): Promise<ConversationSnapshot> {
  ending.add(id);
  try {
    const turn = active.get(id);
    turn?.controller.abort();
    await turn?.ready;
    return await endConversation(id);
  } finally {
    ending.delete(id);
  }
}
