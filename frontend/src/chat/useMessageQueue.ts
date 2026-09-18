import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MAX_MESSAGE_LENGTH } from "../../../shared/conversation";
import type {
  ConversationClient,
  ConversationClientState,
} from "../session/types";

export type QueuedMessage = {
  id: number;
  text: string;
  status: "queued" | "sending" | "failed";
  error?: string;
};

const MAX_QUEUED_MESSAGES = 5;

function transportBusy(state: ConversationClientState) {
  const voice = state.voice;
  const remoteVoice = state.conversation?.voice?.status;
  return (
    state.pending ||
    state.restoring ||
    !!state.conversation?.busy ||
    voice.status === "stopping" ||
    (voice.status === "error" && voice.muted) ||
    ((remoteVoice === "starting" || remoteVoice === "active") &&
      voice.status !== "starting" &&
      voice.status !== "active")
  );
}

/** Unsent free text belongs to this mounted conversation, never a server turn.
 * The existing client still owns acceptance, request identity and reconciliation.
 * Choices/approvals retain their immediate, provenance-checked submission paths.
 */
export function useMessageQueue(session: ConversationClient, paused: boolean) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const current = useRef(messages);
  const nextId = useRef(0);
  const active = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const conversationId = useRef(state.conversation?.id);
  const publish = useCallback((next: QueuedMessage[]) => {
    current.current = next;
    setMessages(next);
  }, []);
  const clear = useCallback(() => {
    epoch.current++;
    active.current = false;
    publish([]);
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // This is a generation counter, not a DOM ref: invalidate the current send.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      current.current = [];
    };
  }, []);

  useEffect(() => {
    const id = state.conversation?.id;
    if (
      (conversationId.current && conversationId.current !== id) ||
      state.conversation?.status === "ended"
    )
      clear();
    conversationId.current = id;
  }, [state.conversation?.id, state.conversation?.status, clear]);

  useEffect(() => {
    const head = current.current[0];
    if (
      !head ||
      head.status !== "queued" ||
      active.current ||
      paused ||
      state.error ||
      transportBusy(session.getSnapshot())
    )
      return;
    const startedEpoch = epoch.current;
    active.current = true;
    publish(
      current.current.map((item) =>
        item.id === head.id ? { ...item, status: "sending" } : item,
      ),
    );
    void session.sendMessage(head.text).then(
      () => {
        if (mounted.current && startedEpoch === epoch.current) {
          active.current = false;
          publish(current.current.filter((item) => item.id !== head.id));
        }
      },
      (cause: unknown) => {
        if (mounted.current && startedEpoch === epoch.current) {
          active.current = false;
          publish(
            current.current.map((item) =>
              item.id === head.id
                ? {
                    ...item,
                    status: "failed",
                    error:
                      cause instanceof Error
                        ? cause.message
                        : "Your message could not be sent.",
                  }
                : item,
            ),
          );
        }
      },
    );
  }, [messages, paused, publish, session, state]);

  const enqueue = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text || text.length > MAX_MESSAGE_LENGTH)
        throw new Error(
          `Enter a message of up to ${MAX_MESSAGE_LENGTH} characters.`,
        );
      if (current.current.length >= MAX_QUEUED_MESSAGES)
        throw new Error(
          "You can queue up to five messages. Wait for one to send or remove a queued message.",
        );
      publish([
        ...current.current,
        { id: ++nextId.current, text, status: "queued" },
      ]);
    },
    [publish],
  );

  return {
    messages,
    busy: transportBusy(state) || messages.length > 0,
    enqueue,
    clear,
    hasMessages: () => current.current.length > 0,
    remove(id: number) {
      publish(
        current.current.filter(
          (item) => item.id !== id || item.status === "sending",
        ),
      );
    },
    retry(id: number) {
      if (
        current.current[0]?.id !== id ||
        current.current[0]?.status !== "failed"
      )
        return;
      session.clearError();
      publish(
        current.current.map((item) =>
          item.id === id
            ? { ...item, status: "queued", error: undefined }
            : item,
        ),
      );
    },
  };
}
