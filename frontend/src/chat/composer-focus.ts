/** The shell requests focus only on opening or revealing the lazy app. */
export function createComposerFocus(container: HTMLElement) {
  const focusOwner = container.getRootNode();
  let observer: MutationObserver | undefined;
  const cancel = () => observer?.disconnect();
  const focus = () => {
    cancel();
    if (!container.isConnected || container.closest("[hidden]")) return;
    const input = container.querySelector<HTMLTextAreaElement>(
      "textarea[data-roman-composer]:not(:disabled)",
    );
    if (input) input.focus({ preventScroll: true });
    else {
      // Restoration may temporarily disable the input. A customer's explicit
      // focus choice cancels this one opening request; later work never steals it.
      observer = new MutationObserver(focus);
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
    }
  };
  // The shell's Close control is a sibling of the lazy container. Listen at
  // their shared root so moving to any Roman control cancels pending focus.
  focusOwner.addEventListener("focusin", cancel);
  return {
    focus,
    cancel,
    dispose() {
      cancel();
      focusOwner.removeEventListener("focusin", cancel);
    },
  };
}
