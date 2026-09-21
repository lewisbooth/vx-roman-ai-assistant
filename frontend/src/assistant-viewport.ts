/** Keep the app within the visible screen while the shell covers the whole page. */
export function createAssistantViewport(host: HTMLElement) {
  const viewport = window.visualViewport;
  let open = false;
  let frame: number | undefined;
  const clear = () => {
    host.style.removeProperty("--roman-visible-top");
    host.style.removeProperty("--roman-visible-height");
  };
  const update = () => {
    frame = undefined;
    if (!open) return;
    // Let native pinch zoom magnify and pan the layout normally. Keyboard
    // resizing at normal scale changes the inner app, never its opaque cover.
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
  };
  const schedule = () => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  const setOpen = (value: boolean) => {
    if (open === value) return;
    open = value;
    if (open) {
      viewport?.addEventListener("resize", schedule);
      viewport?.addEventListener("scroll", schedule);
      window.addEventListener("resize", schedule);
      update();
    } else {
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      clear();
    }
  };
  return { setOpen, dispose: () => setOpen(false) };
}
