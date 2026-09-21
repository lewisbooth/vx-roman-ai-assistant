import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

/** Shared native modal: the browser owns focus trapping and focus restoration. */
export function BrandedDialog({
  logoUrl,
  title,
  description,
  pending = false,
  error,
  onClose,
  returnFocus,
  children,
}: {
  logoUrl: string;
  title: string;
  description: ReactNode;
  pending?: boolean;
  error?: string | null;
  onClose: () => void;
  /** Root-scoped target when an asynchronous action has remounted its trigger. */
  returnFocus?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = dialog.current!;
    const scope = element.getRootNode() as Document | ShadowRoot;
    element.showModal();
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      element.close();
      if (returnFocus)
        scope
          .querySelector<HTMLElement>(returnFocus)
          ?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  return (
    <dialog
      ref={dialog}
      className="roman-action-panel roman-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={pending}
      onKeyDown={(event) => {
        // Let the native dialog, rather than the enclosing assistant, own keys.
        if (event.key === "Escape" || event.key === "Tab")
          event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <img src={logoUrl} alt="Roman by SelectBlinds" width={121} height={50} />
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-description`}>{description}</p>
      <div className="roman-action-buttons">{children}</div>
      {error && (
        <p role="alert" className="roman-chat-error">
          {error}
        </p>
      )}
    </dialog>
  );
}
