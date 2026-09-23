import { useEffect, useLayoutEffect, useState } from "react";
import type { ConversationMessage } from "../../../shared/conversation";
import { prepareRichText, type PreparedRichText } from "./RichText";

type TextPart = Extract<ConversationMessage["parts"][number], { type: "text" }>;
type RevealedPart = {
  key: string;
  part: TextPart;
  source: string;
  pending: boolean;
  prepared: PreparedRichText;
  visible: number;
  fresh: boolean;
};
type ReplyReveal = {
  messages: readonly ConversationMessage[];
  parts: RevealedPart[];
};

function lastCustomerIndex(messages: readonly ConversationMessage[]) {
  let index = -1;
  messages.forEach((message, position) => {
    if (message.role === "user") index = position;
  });
  return index;
}

/** Display state only: snapshots, tool execution and question ownership stay unchanged. */
export function reconcileReplyReveal(
  previous: ReplyReveal | undefined,
  messages: readonly ConversationMessage[],
): ReplyReveal {
  const existing = new Map(previous?.parts.map((part) => [part.key, part]));
  const lastCustomer = lastCustomerIndex(messages);
  const parts = messages.flatMap((message, messageIndex) => {
    if (message.role !== "assistant") return [];
    const voice = message.parts.some((part) => part.type === "voice");
    return message.parts.flatMap((part, partIndex) => {
      if (part.type !== "text") return [];
      const key = `${message.id}:${partIndex}`;
      const old = existing.get(key);
      const pending = message.status === "pending";
      const prepared =
        old?.source === part.text && old.pending === pending
          ? old.prepared
          : prepareRichText(part.text, pending);
      const fresh = old?.fresh ?? (!!previous || pending);
      const animate =
        fresh &&
        !voice &&
        messageIndex > lastCustomer &&
        message.status !== "failed";
      // Final replies can replace a streamed draft under the same ID. Keep the
      // displayed extent, clamped to the new safe text, rather than replaying it.
      const visible = animate
        ? Math.min(old?.visible ?? 0, prepared.length)
        : prepared.length;
      return [
        {
          key,
          part,
          source: part.text,
          pending,
          prepared,
          visible,
          fresh,
        },
      ];
    });
  });
  return { messages, parts };
}

/** One budget across text parts preserves their order when a whole turn arrives. */
export function advanceReplyReveal(
  state: ReplyReveal,
  elapsedMs: number,
): ReplyReveal {
  let budget = Math.max(0, elapsedMs) * 0.12;
  let changed = false;
  const parts = state.parts.map((part) => {
    const remaining = part.prepared.length - part.visible;
    if (!remaining || budget <= 0) return part;
    const amount = Math.min(remaining, budget);
    budget -= amount;
    changed = true;
    return { ...part, visible: part.visible + amount };
  });
  return changed ? { ...state, parts } : state;
}

export function useReplyReveal(
  messages: readonly ConversationMessage[],
  onContentChange: () => void,
) {
  const [state, setState] = useState(() =>
    reconcileReplyReveal(undefined, messages),
  );
  // Reconcile before committing the new snapshot so complete blocks and their
  // questions cannot flash at full length for a frame before an effect runs.
  let current = state;
  if (state.messages !== messages) {
    current = reconcileReplyReveal(state, messages);
    setState(current);
  }
  const revealing = current.parts.some(
    (part) => part.visible < part.prepared.length,
  );
  useEffect(() => {
    if (!revealing) return;
    const started = performance.now();
    const timer = window.setTimeout(() => {
      setState((value) =>
        advanceReplyReveal(value, performance.now() - started),
      );
    }, 32);
    return () => window.clearTimeout(timer);
  }, [current, revealing]);

  const visibleCharacters = current.parts.reduce(
    (total, part) => total + Math.floor(part.visible),
    0,
  );
  useLayoutEffect(onContentChange, [onContentChange, visibleCharacters]);

  return {
    parts: new Map(current.parts.map((part) => [part.part, part])),
  };
}
