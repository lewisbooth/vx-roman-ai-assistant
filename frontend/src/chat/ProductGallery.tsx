import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProductGalleryImage } from "../tools/product-image";

import { GalleryViewport } from "./GalleryViewport";

function Arrow({ next = false }: { next?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={next ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"} />
    </svg>
  );
}

function GalleryZoom({
  items,
  title,
  index,
  move,
  close,
}: {
  items: readonly ProductGalleryImage[];
  title: string;
  index: number;
  move: (direction: number) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const count = items.length;
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
      <GalleryViewport
        items={items}
        index={index}
        title={title}
        move={move}
        zoom
      />
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

/** Selected media and its immediate neighbours; high-resolution media is opt-in. */
export function ProductGallery({
  items,
  title,
  pending = false,
  hidden = false,
  allowZoom = true,
}: {
  items: readonly ProductGalleryImage[];
  title: string;
  pending?: boolean;
  hidden?: boolean;
  allowZoom?: boolean;
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
    if (hidden || !image || !allowZoom) setZoom(false);
  }, [hidden, image, allowZoom]);
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
          <>
            <GalleryViewport
              items={items}
              index={index}
              title={title}
              move={move}
            />
            {allowZoom && (
              <button
                type="button"
                className="roman-gallery-enlarge"
                aria-label={`Enlarge image ${index + 1} of ${items.length}: ${image.alt || title}`}
                onKeyDown={keys}
                onClick={() => setZoom(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
                </svg>
              </button>
            )}
          </>
        ) : (
          <span
            className="roman-product-stage-placeholder"
            role="img"
            aria-label="Product image unavailable"
          />
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
      {zoom && allowZoom && !hidden && image && (
        <GalleryZoom
          items={items}
          title={title}
          index={index}
          move={move}
          close={() => setZoom(false)}
        />
      )}
    </div>
  );
}
