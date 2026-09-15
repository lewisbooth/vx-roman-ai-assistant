import type {
  ConversationSnapshot,
  SendMessageInput,
} from "../../shared/conversation";
import { ConversationError } from "./errors.server";
import { requestBrowserTool } from "./browser-tools.server";
import { generateReply, TEXT_MODEL } from "./model.server";
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
  if (turn?.assistantId) {
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
) {
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
    );
    await finishTurn(id, assistantId, { ...reply, status: "complete" });
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
    active.delete(id);
  }
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
