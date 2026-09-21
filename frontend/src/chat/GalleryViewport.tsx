import { useLayoutEffect, useRef, useState } from "react";
import type { ProductGalleryImage } from "../tools/product-image";

/** A bounded image track shared by the product pane and its enlarged view. */
export function GalleryViewport({
  items,
  index,
  title,
  zoom = false,
  move,
}: {
  items: readonly ProductGalleryImage[];
  index: number;
  title: string;
  zoom?: boolean;
  move: (direction: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const advance = useRef(move);
  const reset = useRef(() => {});
  advance.current = move;
  const enabled = items.length > 1;
  const signature = JSON.stringify([
    index,
    zoom,
    items.map(({ id, src, zoomSrc }) => [id, src, zoomSrc]),
  ]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const track = element.firstElementChild as HTMLElement;
    if (!enabled) return;
    let gesture:
      | { id: number; x: number; y: number; offset: number; moved: boolean }
      | undefined;
    let animation: Animation | undefined;
    const stopAnimation = () => {
      if (!animation) return;
      animation.onfinish = null;
      animation.cancel();
      animation = undefined;
    };
    const release = () => {
      const id = gesture?.id;
      gesture = undefined;
      delete element.dataset.dragging;
      if (id !== undefined && element.hasPointerCapture?.(id))
        element.releasePointerCapture(id);
    };
    const cancel = () => {
      release();
      stopAnimation();
      track.style.removeProperty("--roman-gallery-drag");
    };
    const width = () =>
      element.getBoundingClientRect().width || element.clientWidth;
    const offset = (x: number) => Math.max(-width(), Math.min(width(), x));
    const position = (value: number) =>
      `translate3d(calc(-100% + ${value}px), 0, 0)`;
    const settle = (direction: number, from: number) => {
      stopAnimation();
      const to = -direction * width();
      if (
        !track.animate ||
        Math.abs(to - from) < 1 ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        cancel();
        if (direction) advance.current(direction);
        return;
      }
      animation = track.animate(
        [{ transform: position(from) }, { transform: position(to) }],
        { duration: 180, easing: "ease-out", fill: "forwards" },
      );
      animation.onfinish = () => {
        // Keep the terminal position until React commits the new centre image.
        // The layout effect below then recentres the same loaded image nodes.
        if (direction) advance.current(direction);
        else cancel();
      };
    };
    const down = (event: PointerEvent) => {
      if (event.isPrimary === false) {
        cancel();
        return;
      }
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !width()
      )
        return;
      // A new drag can reverse an in-flight snap from its visible position.
      const start = animation
        ? offset(
            track.getBoundingClientRect().left -
              element.getBoundingClientRect().left +
              width(),
          )
        : 0;
      cancel();
      track.style.setProperty("--roman-gallery-drag", `${start}px`);
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offset: start,
        moved: false,
      };
    };
    const drag = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (event.pointerType === "mouse" && !event.buttons) {
        cancel();
        return;
      }
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.moved) {
        if (Math.abs(dy) > Math.max(8, Math.abs(dx))) {
          cancel();
          return;
        }
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
        gesture.moved = true;
        element.setPointerCapture?.(event.pointerId);
        element.dataset.dragging = "true";
      }
      event.preventDefault();
      track.style.setProperty(
        "--roman-gallery-drag",
        `${offset(gesture.offset + dx)}px`,
      );
    };
    const up = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (!gesture.moved && gesture.offset === 0) {
        cancel();
        return;
      }
      const dx = offset(gesture.offset + event.clientX - gesture.x);
      const dy = event.clientY - gesture.y;
      const threshold = Math.min(64, Math.max(18, width() * 0.18));
      const direction =
        (gesture.moved || gesture.offset !== 0) &&
        Math.abs(dx) >= threshold &&
        Math.abs(dx) > Math.abs(dy)
          ? dx < 0
            ? 1
            : -1
          : 0;
      release();
      settle(direction, dx);
    };
    const leave = () => {
      if (gesture && !gesture.moved) cancel();
    };
    const lost = (event: PointerEvent) => {
      // Ignore loss of the image's implicit touch capture when the viewport takes it.
      if (event.target === element && gesture) cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const preventDrag = (event: DragEvent) => event.preventDefault();
    const resize = window.ResizeObserver
      ? new ResizeObserver(cancel)
      : undefined;
    resize?.observe(element);
    reset.current = cancel;
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", drag);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", lost);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("dragstart", preventDrag);
    window.addEventListener("resize", cancel);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel();
      reset.current = () => {};
      resize?.disconnect();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", drag);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", lost);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("dragstart", preventDrag);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled]);
  useLayoutEffect(() => reset.current(), [signature]);

  return (
    <div
      ref={viewport}
      className={zoom ? "roman-gallery-zoom-image" : "roman-gallery-viewport"}
    >
      <div className="roman-gallery-track" data-single={!enabled || undefined}>
        {(enabled ? [-1, 0, 1] : [0]).map((position) => {
          const image = items[(index + position + items.length) % items.length];
          return (
            <div
              key={`${image.id}:${image.src}:${zoom ? image.zoomSrc : ""}${items.length === 2 && position === -1 ? ":copy" : ""}`}
              className="roman-gallery-slide"
              data-current={position === 0 || undefined}
              aria-hidden={position !== 0 || undefined}
            >
              <GalleryImage image={image} title={title} zoom={zoom} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GalleryImage({
  image,
  title,
  zoom,
}: {
  image: ProductGalleryImage;
  title: string;
  zoom: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [zoomFailed, setZoomFailed] = useState(false);
  if (failed)
    return (
      <span className="roman-product-stage-placeholder">Image unavailable</span>
    );
  return (
    <img
      src={zoom && !zoomFailed ? image.zoomSrc : image.src}
      alt={image.alt || title}
      width={image.width}
      height={image.height}
      decoding="async"
      draggable={false}
      onError={() => {
        if (zoom && !zoomFailed && image.zoomSrc !== image.src)
          setZoomFailed(true);
        else setFailed(true);
      }}
    />
  );
}
