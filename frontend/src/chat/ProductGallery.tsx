import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProductGalleryImage } from "../tools/product-image";

/** Shared by the compact and enlarged image; vertical page gestures stay native. */
function useGallerySwipe<T extends HTMLElement>(
  enabled: boolean,
  move: (direction: number) => void,
) {
  const ref = useRef<T>(null);
  const advance = useRef(move);
  advance.current = move;
  const suppressClick = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let gesture:
      { id: number; x: number; y: number; moved: boolean } | undefined;
    let animation: Animation | undefined;
    const release = () => {
      const id = gesture?.id;
      gesture = undefined;
      delete element.dataset.dragging;
      element.style.removeProperty("--roman-gallery-drag");
      if (id !== undefined && element.hasPointerCapture?.(id))
        element.releasePointerCapture(id);
    };
    const cancel = () => {
      release();
      suppressClick.current = false;
    };
    const down = (event: PointerEvent) => {
      cancel();
      if (
        event.isPrimary === false ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      animation?.cancel();
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
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
      const width = element.clientWidth || 320;
      element.style.setProperty(
        "--roman-gallery-drag",
        `${Math.max(-width, Math.min(width, dx))}px`,
      );
    };
    const up = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const moved = gesture.moved;
      const threshold = Math.min(64, Math.max(18, element.clientWidth * 0.18));
      release();
      suppressClick.current = moved;
      if (!moved || Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy))
        return;
      advance.current(dx < 0 ? 1 : -1);
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        animation = element
          .querySelector<HTMLElement>(".roman-gallery-slide")
          ?.animate?.(
            [
              { transform: `translateX(${dx < 0 ? 18 : -18}%)`, opacity: 0.7 },
              { transform: "translateX(0)", opacity: 1 },
            ],
            { duration: 180, easing: "ease-out" },
          );
      }
    };
    const leave = () => {
      if (!gesture?.moved) cancel();
    };
    const lost = (event: PointerEvent) => {
      // Touch implicitly captures its initial image target. Taking capture on
      // the viewport bubbles that image's lost event here; our drag still owns it.
      if (event.target === element && gesture) cancel();
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const preventDrag = (event: DragEvent) => event.preventDefault();
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", drag);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", lost);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("dragstart", preventDrag);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel();
      animation?.cancel();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", drag);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", lost);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("dragstart", preventDrag);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled]);
  return {
    ref,
    consumeClick: (detail: number) => {
      const suppress = suppressClick.current && detail !== 0;
      suppressClick.current = false;
      return suppress;
    },
  };
}

function GalleryImage({
  image,
  title,
  zoom = false,
}: {
  image: ProductGalleryImage;
  title: string;
  zoom?: boolean;
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

function Arrow({ next = false }: { next?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={next ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"} />
    </svg>
  );
}

function GalleryZoom({
  image,
  title,
  index,
  count,
  move,
  close,
}: {
  image: ProductGalleryImage;
  title: string;
  index: number;
  count: number;
  move: (direction: number) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const swipe = useGallerySwipe<HTMLDivElement>(count > 1, move);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    closeButton.current?.focus();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="roman-gallery-zoom"
      aria-label={`${title} image gallery`}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (["Escape", "Tab", "ArrowLeft", "ArrowRight"].includes(event.key))
          event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <header>
        <span>{title}</span>
        <button
          ref={closeButton}
          type="button"
          aria-label="Close enlarged image"
          onClick={close}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div ref={swipe.ref} className="roman-gallery-zoom-image">
        <span className="roman-gallery-slide">
          <GalleryImage
            key={`${image.src}:${image.zoomSrc}`}
            image={image}
            title={title}
            zoom
          />
        </span>
      </div>
      <div className="roman-gallery-controls">
        {count > 1 && (
          <button
            type="button"
            aria-label="Previous enlarged image"
            onClick={() => move(-1)}
          >
            <Arrow />
          </button>
        )}
        <span role="status" aria-live="polite">
          {index + 1} / {count}
        </span>
        {count > 1 && (
          <button
            type="button"
            aria-label="Next enlarged image"
            onClick={() => move(1)}
          >
            <Arrow next />
          </button>
        )}
      </div>
    </dialog>
  );
}

/** Only the selected regular image is mounted; high-resolution media is opt-in. */
export function ProductGallery({
  items,
  title,
  pending = false,
  hidden = false,
}: {
  items: readonly ProductGalleryImage[];
  title: string;
  pending?: boolean;
  hidden?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [zoom, setZoom] = useState(false);
  const thumbnails = useRef<HTMLDivElement>(null);
  const previousFeature = useRef<string>();
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const image = items[index];
  const move = (direction: number) => {
    if (items.length)
      setSelectedId(
        items[(index + direction + items.length) % items.length].id,
      );
  };
  const swipe = useGallerySwipe<HTMLButtonElement>(
    !hidden && items.length > 1,
    move,
  );
  useLayoutEffect(() => {
    const feature = items.find((item) => item.kind === "feature");
    const signature = feature && `${feature.id}:${feature.src}`;
    if (feature && signature && signature !== previousFeature.current)
      setSelectedId(feature.id);
    previousFeature.current = signature;
  }, [items]);
  useLayoutEffect(() => {
    // Native horizontal scrolling keeps the selected thumbnail reachable without
    // scrolling Roman's surrounding product panel or conversation.
    const strip = thumbnails.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !selected) return;
    const left = selected.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left + selected.offsetWidth - strip.clientWidth;
  }, [index, items]);
  useLayoutEffect(() => {
    if (hidden || !image) setZoom(false);
  }, [hidden, image]);
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!items.length) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") setSelectedId(items[0].id);
      else if (event.key === "End") setSelectedId(items[items.length - 1].id);
      else move(event.key === "ArrowRight" ? 1 : -1);
    }
  };
  if (hidden) return null;
  return (
    <div
      className="roman-product-gallery"
      role="region"
      aria-label={`${title} images`}
    >
      <div className="roman-product-stage-image">
        {image ? (
          <button
            ref={swipe.ref}
            type="button"
            className="roman-gallery-open"
            aria-label={`Enlarge image ${index + 1} of ${items.length}: ${image.alt || title}`}
            onKeyDown={keys}
            onClick={(event) => {
              if (swipe.consumeClick(event.detail)) return;
              setZoom(true);
            }}
          >
            <span className="roman-gallery-slide">
              <GalleryImage key={image.src} image={image} title={title} />
            </span>
            <span className="roman-gallery-enlarge" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
              </svg>
            </span>
          </button>
        ) : (
          <span className="roman-product-stage-placeholder">
            Your selection
          </span>
        )}
        {pending && (
          <p className="roman-product-stage-loading" role="status">
            Opening your next page…
          </p>
        )}
      </div>
      {items.length > 1 && (
        <>
          <div className="roman-gallery-controls">
            <button
              type="button"
              aria-label="Previous product image"
              onClick={() => move(-1)}
            >
              <Arrow />
            </button>
            <span role="status" aria-live="polite">
              {index + 1} / {items.length}
            </span>
            <button
              type="button"
              aria-label="Next product image"
              onClick={() => move(1)}
            >
              <Arrow next />
            </button>
          </div>
          <div
            ref={thumbnails}
            className="roman-gallery-thumbnails"
            role="group"
            aria-label="Choose a product image"
          >
            {items.map((item, position) => (
              <button
                key={item.id}
                type="button"
                aria-label={`Show image ${position + 1}: ${item.alt || title}`}
                aria-pressed={position === index}
                onClick={() => setSelectedId(item.id)}
              >
                <img
                  src={item.thumbnailSrc}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        </>
      )}
      {zoom && !hidden && image && (
        <GalleryZoom
          image={image}
          title={title}
          index={index}
          count={items.length}
          move={move}
          close={() => setZoom(false)}
        />
      )}
    </div>
  );
}
