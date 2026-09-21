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
  onKeepShopping,
}: {
  conversation: ConversationSnapshot | null;
  restoring: boolean;
  blocked: boolean;
  logoUrl: string;
  onViewCart: () => void;
  onKeepShopping: (message: string) => Promise<void>;
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
    continuation: string;
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
                continuation: `I'd like to keep shopping after adding the ${part.product.title} to my cart.`,
              },
            ]
          : part.type === "cart_sample_added"
            ? [
                {
                  id: part.invocationId,
                  title: `${part.sample.title} sample added to cart`,
                  continuation: `I'd like to keep shopping after adding a sample of the ${part.sample.title} to my cart.`,
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
    <CartAddedNotice
      key={notice.id}
      logoUrl={logoUrl}
      title={notice.title}
      onClose={() =>
        setNotice((current) => (current?.id === notice.id ? null : current))
      }
      onViewCart={onViewCart}
      onKeepShopping={() => onKeepShopping(notice.continuation)}
    />
  );
}

function CartAddedNotice({
  logoUrl,
  title,
  onClose,
  onViewCart,
  onKeepShopping,
}: {
  logoUrl: string;
  title: string;
  onClose: () => void;
  onViewCart: () => void;
  onKeepShopping: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  async function keepShopping() {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      await onKeepShopping();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your message could not be sent. Please try again.",
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <BrandedDialog
      logoUrl={logoUrl}
      title={title}
      pending={pending}
      error={error}
      onClose={onClose}
    >
      <button
        type="button"
        disabled={pending}
        className="roman-dialog-primary"
        onClick={() => {
          onClose();
          onViewCart();
        }}
      >
        View Cart
      </button>
      <button
        type="button"
        disabled={pending}
        className="roman-dialog-secondary"
        onClick={() => void keepShopping()}
      >
        Keep Shopping
      </button>
    </BrandedDialog>
  );
}
