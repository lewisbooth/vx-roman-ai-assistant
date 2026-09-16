import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Native touch/keyboard scrolling, with mouse dragging as a progressive aid. */
export function ProductCarousel({ children }: { children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const measure = useRef<() => void>(() => {});
  const [edges, setEdges] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const element = scroll.current!;
    let drag:
      | { id: number; x: number; y: number; left: number; moved: boolean }
      | undefined;
    let suppressClick = false;
    let clickTimer = 0;
    const clearClick = () => {
      suppressClick = false;
      window.clearTimeout(clickTimer);
    };
    const finish = (completed = false) => {
      const previous = drag;
      drag = undefined;
      delete element.dataset.dragging;
      if (previous && element.hasPointerCapture?.(previous.id))
        element.releasePointerCapture(previous.id);
      if (completed && previous?.moved) {
        suppressClick = true;
        clickTimer = window.setTimeout(clearClick, 500);
      }
    };
    const cancel = () => {
      finish();
      clearClick();
    };
    const update = () => {
      const visible = element.clientWidth > 0;
      if (!visible) cancel();
      const left = visible && element.scrollLeft > 1;
      const right =
        visible &&
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((current) =>
        current.left === left && current.right === right
          ? current
          : { left, right },
      );
    };
    const down = (event: PointerEvent) => {
      cancel();
      if (
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        element.scrollWidth <= element.clientWidth + 1
      )
        return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        moved: false,
      };
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!event.buttons) {
        cancel();
        return;
      }
      const dx = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 6) return;
        if (Math.abs(event.clientY - drag.y) > Math.abs(dx)) {
          cancel();
          return;
        }
        drag.moved = true;
        element.dataset.dragging = "true";
        element.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
      element.scrollLeft = drag.left - dx;
      update();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === drag?.id) finish(true);
    };
    const click = (event: MouseEvent) => {
      if (
        !suppressClick ||
        event.detail === 0 ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      clearClick();
      event.preventDefault();
      event.stopPropagation();
    };
    const preventDrag = (event: DragEvent) => event.preventDefault();
    const lostCapture = () => {
      if (drag) cancel();
    };
    const leave = () => {
      if (!drag?.moved) cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const resize = window.ResizeObserver
      ? new ResizeObserver(update)
      : undefined;
    resize?.observe(element);
    if (element.firstElementChild) resize?.observe(element.firstElementChild);
    element.addEventListener("scroll", update, { passive: true });
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", lostCapture);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("click", click, true);
    element.addEventListener("dragstart", preventDrag);
    window.addEventListener("resize", update);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    measure.current = update;
    update();
    return () => {
      cancel();
      resize?.disconnect();
      element.removeEventListener("scroll", update);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", lostCapture);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("click", click, true);
      element.removeEventListener("dragstart", preventDrag);
      window.removeEventListener("resize", update);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useLayoutEffect(() => measure.current(), [children]);

  const advance = (direction: number) => {
    const element = scroll.current!;
    element.scrollBy({
      left: direction * Math.max(176, element.clientWidth * 0.8),
      behavior: "smooth",
    });
  };
  return (
    <div
      className="roman-product-carousel"
      data-left={edges.left}
      data-right={edges.right}
    >
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Focus enables native keyboard scrolling in this labelled region. */}
      <div
        ref={scroll}
        className="roman-product-scroll"
        role="region"
        aria-label="Recommended products"
        tabIndex={0}
      >
        {children}
      </div>
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      {(edges.left || edges.right) && (
        <>
          <button
            type="button"
            className="roman-carousel-previous"
            aria-label="Previous products"
            disabled={!edges.left}
            onClick={() => advance(-1)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m12 4-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="roman-carousel-next"
            aria-label="Next products"
            disabled={!edges.right}
            onClick={() => advance(1)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m8 4 6 6-6 6" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
