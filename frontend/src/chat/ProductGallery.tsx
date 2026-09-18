import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ProductGalleryImage } from "../tools/product-image";

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
      <div className="roman-gallery-zoom-image">
        <GalleryImage
          key={`${image.src}:${image.zoomSrc}`}
          image={image}
          title={title}
          zoom
        />
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
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  }>();
  const suppressClick = useRef(false);
  const imageButton = useRef<HTMLButtonElement>(null);
  const thumbnails = useRef<HTMLDivElement>(null);
  const previousFeature = useRef<string>();
  const index = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const image = items[index];
  const hasImage = !!image;
  const move = (direction: number) => {
    if (items.length)
      setSelectedId(
        items[(index + direction + items.length) % items.length].id,
      );
  };
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
  useLayoutEffect(() => {
    const element = imageButton.current;
    return () => {
      const id = gesture.current?.id;
      gesture.current = undefined;
      suppressClick.current = false;
      if (id !== undefined && element?.hasPointerCapture?.(id))
        element.releasePointerCapture(id);
    };
  }, [hidden, hasImage]);
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!items.length) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") setSelectedId(items[0].id);
      else if (event.key === "End") setSelectedId(items[items.length - 1].id);
      else move(event.key === "ArrowRight" ? 1 : -1);
    }
  };
  const cancelGesture = (event: PointerEvent<HTMLButtonElement>) => {
    const id = gesture.current?.id;
    gesture.current = undefined;
    if (id !== undefined && event.currentTarget.hasPointerCapture?.(id))
      event.currentTarget.releasePointerCapture(id);
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
            ref={imageButton}
            type="button"
            className="roman-gallery-open"
            aria-label={`Enlarge image ${index + 1} of ${items.length}: ${image.alt || title}`}
            onKeyDown={keys}
            onPointerDown={(event) => {
              suppressClick.current = false;
              if (
                event.button !== 0 ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey
              )
                return;
              gesture.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                moved: false,
              };
            }}
            onPointerMove={(event) => {
              const start = gesture.current;
              if (!start || start.id !== event.pointerId || items.length < 2)
                return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (!start.moved && Math.abs(dy) > Math.max(8, Math.abs(dx))) {
                cancelGesture(event);
                return;
              }
              if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
              start.moved = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              event.preventDefault();
            }}
            onPointerUp={(event) => {
              const start = gesture.current;
              if (!start || start.id !== event.pointerId) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              suppressClick.current = start.moved;
              cancelGesture(event);
              if (
                start.moved &&
                Math.abs(dx) >= 32 &&
                Math.abs(dx) > Math.abs(dy)
              )
                move(dx < 0 ? 1 : -1);
            }}
            onPointerCancel={(event) => {
              cancelGesture(event);
              suppressClick.current = false;
            }}
            onLostPointerCapture={(event) => cancelGesture(event)}
            onClick={(event) => {
              if (suppressClick.current && event.detail !== 0) {
                suppressClick.current = false;
                return;
              }
              setZoom(true);
            }}
          >
            <GalleryImage key={image.src} image={image} title={title} />
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
