import { useId, useLayoutEffect, useRef } from "react";

export function EndChatDialog({
  logoUrl,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  logoUrl: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    // Close before React removes the dialog so the browser can restore focus
    // to the End chat trigger on cancellation.
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="roman-action-panel roman-end-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={pending}
      onKeyDown={(event) => {
        // The native dialog owns focus trapping and Escape while open. Keep
        // those keys away from the surrounding assistant panel's handlers.
        if (event.key === "Escape" || event.key === "Tab")
          event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <img src={logoUrl} alt="Roman by SelectBlinds" width={121} height={50} />
      <h2 id={`${id}-title`}>End this chat?</h2>
      <p id={`${id}-description`}>
        Your chat will be cleared. Items in your Cart and Gallery will remain.
      </p>
      <div className="roman-action-buttons">
        <button
          ref={cancel}
          type="button"
          disabled={pending}
          onClick={onCancel}
        >
          Keep chatting
        </button>
        <button
          type="button"
          className="roman-end-confirm"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Ending chat…" : "End chat"}
        </button>
      </div>
      {error && (
        <p role="alert" className="roman-chat-error">
          {error}
        </p>
      )}
    </dialog>
  );
}
