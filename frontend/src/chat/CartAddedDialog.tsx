import { useEffect, useRef, useState } from "react";
import type { ConversationSnapshot } from "../../../shared/conversation";
import { BrandedDialog } from "./BrandedDialog";

/** Confirmed additions only: native events and optimistic requests are not receipts. */
export function CartAddedDialog({
  conversation,
  restoring,
  blocked,
  logoUrl,
  onViewCart,
}: {
  conversation: ConversationSnapshot | null;
  restoring: boolean;
  blocked: boolean;
  logoUrl: string;
  onViewCart: () => void;
}) {
  const [open, setOpen] = useState(() =>
    document.documentElement.hasAttribute("data-roman-open"),
  );
  const seen = useRef<{ conversationId?: string; ids: Set<string> }>({
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
    const additions = (conversation?.messages ?? []).flatMap((message) =>
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
      ids: new Set(additions.map((addition) => addition.id)),
    };
    // First/restored snapshots establish the baseline. Additions received while
    // closed or another approval is active stay in history without later replay.
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
    const timer = window.setTimeout(() => setNotice(null), 2000);
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
    <BrandedDialog
      key={notice.id}
      logoUrl={logoUrl}
      title={notice.title}
      onClose={() => setNotice(null)}
    >
      <button
        type="button"
        className="roman-dialog-primary"
        onClick={() => {
          setNotice(null);
          onViewCart();
        }}
      >
        View Cart
      </button>
      <button
        type="button"
        className="roman-dialog-secondary"
        onClick={() => setNotice(null)}
      >
        Keep Shopping
      </button>
    </BrandedDialog>
  );
}
