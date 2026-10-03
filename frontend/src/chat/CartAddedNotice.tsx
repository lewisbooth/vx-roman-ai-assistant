import { useEffect, useRef, useState } from "react";
import type { ConversationSnapshot } from "../../../shared/conversation";
import { liveSnapshotMessages } from "../session/live-messages";

/** Confirmed additions only: native events and optimistic requests are not receipts. */
export function CartAddedNotice({
  conversation,
  restoring,
  blocked,
}: {
  conversation: ConversationSnapshot | null;
  restoring: boolean;
  blocked: boolean;
}) {
  const [open, setOpen] = useState(() =>
    document.documentElement.hasAttribute("data-roman-open"),
  );
  const seen = useRef<{
    conversationId?: string;
    ids: Set<string>;
  }>({
    ids: new Set(),
  });
  const [notice, setNotice] = useState<{
    conversationId: string;
    id: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const visible = document.documentElement.hasAttribute("data-roman-open");
      setOpen(visible);
      if (!visible) setNotice(null);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-roman-open"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const additions = liveSnapshotMessages(conversation).flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "cart_added"
          ? [
              {
                id: part.invocationId,
                title: `${part.product.title} added to cart`,
              },
            ]
          : part.type === "cart_sample_added"
            ? [
                {
                  id: part.invocationId,
                  title: `${part.sample.title} sample added to cart`,
                },
              ]
            : [],
      ),
    );
    const previous = seen.current;
    seen.current = {
      conversationId: conversation?.id,
      ids: new Set([
        ...(previous.conversationId === conversation?.id ? previous.ids : []),
        ...additions.map((addition) => addition.id),
      ]),
    };
    // First/restored snapshots establish the baseline. Additions received while
    // closed or a blocking operation is active stay in history without later replay.
    if (
      !conversation ||
      conversation.status !== "active" ||
      previous.conversationId !== conversation.id ||
      restoring ||
      blocked ||
      !document.documentElement.hasAttribute("data-roman-open")
    ) {
      setNotice(null);
      return;
    }
    const latest = additions
      .filter((addition) => !previous.ids.has(addition.id))
      .at(-1);
    if (latest) setNotice({ ...latest, conversationId: conversation.id });
  }, [conversation, restoring, blocked, open]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (
    !notice ||
    !open ||
    blocked ||
    restoring ||
    conversation?.status !== "active" ||
    notice.conversationId !== conversation.id
  )
    return null;

  return (
    <div
      key={notice.id}
      className="roman-cart-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{notice.title}</span>
    </div>
  );
}
