/** Keep the mobile page stable while its composer follows the keyboard. */
export function createAssistantViewport(host: HTMLElement) {
  const viewport = window.visualViewport;
  let open = false;
  let frame: number | undefined;
  let layoutHeight = 0;
  let layoutWidth = 0;
  let editing = false;
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
    const compact = window.matchMedia?.("(max-width: 1023px)").matches ?? false;
    const focused = host.shadowRoot?.activeElement;
    const composerFocused =
      focused?.matches("textarea[data-roman-composer]") ?? false;
    const bottom = height + Math.max(0, viewport?.offsetTop ?? 0);
    const resized = layoutWidth !== window.innerWidth;
    if (compact && composerFocused) editing = true;
    // Capture before Safari starts its keyboard animation. Keep this height
    // through blur until the visible area recovers, not just until focus leaves.
    if (!compact || resized || !layoutHeight || !editing || bottom >= layoutHeight - 1)
      layoutHeight = bottom;
    if (!compact || (!composerFocused && (resized || bottom >= layoutHeight - 1)))
      editing = false;
    layoutWidth = window.innerWidth;
    host.style.setProperty("--roman-layout-height", `${layoutHeight}px`);
    host.style.setProperty(
      "--roman-keyboard-inset",
      `${compact ? Math.max(0, layoutHeight - bottom) : 0}px`,
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
      host.addEventListener("focusin", onFocus);
      host.addEventListener("focusout", schedule);
      update();
    } else {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", schedule);
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
