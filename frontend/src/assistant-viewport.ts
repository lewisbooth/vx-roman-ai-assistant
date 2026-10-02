/** Keep the mobile page stable while its composer follows the keyboard. */
export function createAssistantViewport(host: HTMLElement) {
  const viewport = window.visualViewport;
  const focusRoot = host.shadowRoot ?? host;
  let open = false;
  let frame: number | undefined;
  let layoutHeight = 0;
  let layoutWidth = 0;
  let editing = false;
  let focusing = false;
  let touch:
    | { input: HTMLTextAreaElement; x: number; y: number; started: number }
    | undefined;
  const compact = () =>
    window.matchMedia?.("(max-width: 1023px)").matches ?? false;
  const preventFocusPan = () =>
    compact() && (!viewport || Math.abs(viewport.scale - 1) <= 0.01);
  const composer = (
    target: EventTarget | null,
  ): target is HTMLTextAreaElement =>
    target instanceof HTMLTextAreaElement &&
    target.matches("[data-roman-composer]:not(:disabled)") &&
    focusRoot.contains(target);
  const focusWithoutPan = (input: HTMLTextAreaElement) => {
    if (focusing) return;
    focusing = true;
    try {
      input.focus({ preventScroll: true });
    } finally {
      focusing = false;
    }
  };
  const onBlur = (event: Event) => {
    const next = (event as FocusEvent).relatedTarget;
    // Pre-empt Safari's native focus reveal, before its keyboard animation.
    // Doing this in focusin is too late: the viewport pan is already queued.
    // Listen inside the shadow root so relatedTarget is the actual field.
    // https://github.com/adobe/react-spectrum/pull/8888
    if (preventFocusPan() && composer(next)) focusWithoutPan(next);
  };
  const cancelTouch = () => {
    touch = undefined;
  };
  const onTouchStart = (event: TouchEvent) => {
    const target = event.composedPath()[0];
    touch =
      preventFocusPan() &&
      event.touches.length === 1 &&
      composer(target) &&
      !host.shadowRoot?.activeElement
        ? {
            input: target,
            x: event.touches[0].clientX,
            y: event.touches[0].clientY,
            started: event.timeStamp,
          }
        : undefined;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (
      touch &&
      (event.touches.length !== 1 ||
        Math.hypot(
          event.touches[0].clientX - touch.x,
          event.touches[0].clientY - touch.y,
        ) > 8)
    )
      cancelTouch();
  };
  const onTouchEnd = (event: TouchEvent) => {
    const pending = touch;
    cancelTouch();
    // First focus may come from the document body, which emits no blur. Own
    // only an unmoved tap; scrolling, long-press, pinch and caret gestures stay
    // native. No hidden field, transform, focus timer or global focus override.
    if (
      !pending ||
      !preventFocusPan() ||
      event.defaultPrevented ||
      !event.cancelable ||
      event.touches.length ||
      event.timeStamp - pending.started >= 500 ||
      event.composedPath()[0] !== pending.input ||
      !composer(pending.input) ||
      host.shadowRoot?.activeElement
    )
      return;
    event.preventDefault();
    focusWithoutPan(pending.input);
  };
  const clear = () => {
    host.style.removeProperty("--roman-visible-top");
    host.style.removeProperty("--roman-visible-height");
    host.style.removeProperty("--roman-layout-height");
    host.style.removeProperty("--roman-keyboard-inset");
  };
  const update = () => {
    frame = undefined;
    if (!open) return;
    // Pinch zoom remains native; do not mistake magnification for a keyboard.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) {
      clear();
      return;
    }
    const height = viewport?.height ?? window.innerHeight;
    if (height <= 0) return;
    host.style.setProperty(
      "--roman-visible-top",
      `${Math.max(0, viewport?.offsetTop ?? 0)}px`,
    );
    host.style.setProperty("--roman-visible-height", `${height}px`);
    const isCompact = compact();
    const focused = host.shadowRoot?.activeElement;
    const composerFocused =
      focused?.matches("textarea[data-roman-composer]") ?? false;
    const resized = layoutWidth !== window.innerWidth;
    if (isCompact && composerFocused) editing = true;
    // Capture before Safari starts its keyboard animation. Keep this height
    // through blur until the visible area recovers, not just until focus leaves.
    // The frame compensates visual-viewport panning separately. Including its
    // offset here would lift the composer twice or resize the page during pan.
    if (
      !isCompact ||
      resized ||
      !layoutHeight ||
      !editing ||
      height >= layoutHeight - 1
    )
      layoutHeight = height;
    if (
      !isCompact ||
      (!composerFocused && (resized || height >= layoutHeight - 1))
    )
      editing = false;
    layoutWidth = window.innerWidth;
    host.style.setProperty("--roman-layout-height", `${layoutHeight}px`);
    host.style.setProperty(
      "--roman-keyboard-inset",
      `${isCompact ? Math.max(0, layoutHeight - height) : 0}px`,
    );
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  const onFocus = () => {
    // focusin runs before the first viewport resize; do not defer its snapshot.
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    update();
  };
  const setOpen = (value: boolean) => {
    if (open === value) return;
    open = value;
    if (open) {
      viewport?.addEventListener("resize", schedule);
      viewport?.addEventListener("scroll", schedule);
      window.addEventListener("resize", schedule);
      focusRoot.addEventListener("blur", onBlur, true);
      focusRoot.addEventListener("focusin", onFocus);
      focusRoot.addEventListener("focusout", schedule);
      host.addEventListener("touchstart", onTouchStart, { passive: true });
      host.addEventListener("touchmove", onTouchMove, { passive: true });
      host.addEventListener("touchend", onTouchEnd, { passive: false });
      host.addEventListener("touchcancel", cancelTouch);
      host.addEventListener("contextmenu", cancelTouch);
      update();
    } else {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      focusRoot.removeEventListener("blur", onBlur, true);
      focusRoot.removeEventListener("focusin", onFocus);
      focusRoot.removeEventListener("focusout", schedule);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", cancelTouch);
      host.removeEventListener("contextmenu", cancelTouch);
      cancelTouch();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      clear();
      layoutHeight = 0;
      layoutWidth = 0;
      editing = false;
    }
  };
  return { setOpen, dispose: () => setOpen(false) };
}
