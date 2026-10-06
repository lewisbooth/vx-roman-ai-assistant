import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

/** Native focus containment; viewport and storefront locks retain their owners. */
export function VisualizationDialog({ title, fullscreen = false, pending = false, onClose, children }: {
  title: string;
  fullscreen?: boolean;
  pending?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    const scope = element.getRootNode() as Document | ShadowRoot;
    const trigger = scope.activeElement as HTMLElement | null;
    const returnTarget = trigger?.isConnected && !trigger.matches("input, textarea")
      ? trigger : scope.querySelector<HTMLElement>("[data-roman-upload]");
    // Establish a non-input restoration target before showModal captures it.
    // Safari may leave the textarea focused after a tap on an icon button.
    returnTarget?.focus({ preventScroll: true });
    element.showModal();
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      element.close();
      // Never focus a name/composer input automatically when closing on mobile.
      const target = returnTarget?.isConnected ? returnTarget
        : scope.querySelector<HTMLElement>("[data-roman-upload]");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={dialog} className={`roman-visualization-dialog${fullscreen ? " roman-visualization-fullscreen" : ""}`}
      aria-labelledby={id} aria-busy={pending}
      onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Tab") event.stopPropagation(); }}
      onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <header className="roman-visualization-dialog-header">
        <h2 id={id}>{title}</h2>
        <button type="button" className="roman-visualization-close" aria-label="Close" disabled={pending} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      {children}
    </dialog>
  );
}
