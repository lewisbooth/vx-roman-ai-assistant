const cartModalId = "cart-drawer-dialog";
const openEvent = "modal-dialog::open";

type ThemeCartModal = HTMLElement & {
  readonly modalIsOpen?: boolean;
  closeModal?: () => void;
};

/** Roman owns confirmations while visible; the theme still owns cart updates. */
export function createStorefrontCartNotification() {
  let open = false;
  let disposed = false;

  function intercept(event: Event) {
    if (!(event instanceof CustomEvent) || event.detail !== cartModalId) return;
    const provider =
      event.target instanceof Element
        ? event.target.closest("app-provider")
        : null;
    if (!provider?.querySelector(`modal-dialog#${cartModalId}`)) return;
    // The HD theme promotes this notification to the native dialog top layer.
    // Stop only its open request before app-provider updates modal state; never
    // patch showModal or interfere with cart sections, errors or other dialogs.
    event.stopPropagation();
  }

  return {
    setOpen(value: boolean) {
      if (disposed || open === value) return;
      open = value;
      if (open) {
        document.addEventListener(openEvent, intercept, true);
        const modal = document.querySelector<ThemeCartModal>(
          `app-provider modal-dialog#${cartModalId}`,
        );
        // Use the theme's own close contract so its modal context, auto-close
        // timer and native top-layer state stay in sync if it was already open.
        if (modal?.modalIsOpen) modal.closeModal?.();
      } else document.removeEventListener(openEvent, intercept, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      open = false;
      document.removeEventListener(openEvent, intercept, true);
    },
  };
}
