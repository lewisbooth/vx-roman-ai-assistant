import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProductGalleryImage } from "../tools/product-image";
import { PrivateImage } from "../visualizations/PrivateImage";

import { GalleryViewport } from "./GalleryViewport";
import type { ProductGalleryMedia } from "./product-gallery-media";

export function ProductPreviewStar() {
  return (
    <svg className="roman-gallery-preview-star" viewBox="108.5 1.9 10.9 10.8" aria-hidden="true">
      <path d="M113.709 12.5805C113.607 11.9816 113.34 11.3366 112.907 10.6456C112.474 9.94534 111.857 9.29577 111.055 8.69688C110.263 8.09798 109.47 7.71561 108.678 7.54977V6.9693C109.461 6.78503 110.212 6.44412 110.931 5.94658C111.659 5.43982 112.267 4.83171 112.755 4.12226C113.253 3.39437 113.57 2.6757 113.709 1.96624H114.289C114.372 2.42693 114.538 2.90144 114.787 3.38977C115.035 3.86888 115.353 4.32957 115.74 4.77183C116.137 5.20487 116.579 5.59645 117.067 5.94658C117.795 6.46255 118.537 6.80345 119.292 6.9693V7.54977C118.785 7.65112 118.26 7.85843 117.717 8.17169C117.182 8.48496 116.685 8.85812 116.224 9.29116C115.763 9.71499 115.386 10.1619 115.091 10.6318C114.658 11.3228 114.391 11.9724 114.289 12.5805H113.709Z" />
    </svg>
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
  items: readonly ProductGalleryMedia[];
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
  const nativeImages = items.filter((item): item is ProductGalleryImage => item.kind !== "visualization");
  const nativeIndex = Math.max(0, nativeImages.findIndex((item) => item.id === image?.id));
  const move = (direction: number) => {
    if (items.length)
      setSelectedId(
        items[(index + direction + items.length) % items.length].id,
      );
  };
  useLayoutEffect(() => {
    const feature = items.find((item): item is ProductGalleryImage => item.kind === "feature");
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
    if (hidden || !image || !allowZoom || image.kind === "visualization") setZoom(false);
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
            {(allowZoom || image.kind === "visualization") && (
              <button
                type="button"
                className="roman-gallery-enlarge"
                aria-label={`Enlarge image ${index + 1} of ${items.length}: ${image.alt || title}`}
                onKeyDown={keys}
                onClick={() => image.kind === "visualization" ? image.onOpen() : setZoom(true)}
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
      )}
      {(items.length > 1 || image?.kind === "visualization") && (
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
                {item.kind === "visualization" ? (
                  <>
                    <PrivateImage source={item.source} sourceKey={item.sourceKey} alt="" />
                    <ProductPreviewStar />
                  </>
                ) : (
                  <img src={item.thumbnailSrc} alt="" loading="lazy" decoding="async" draggable={false} />
                )}
              </button>
            ))}
          </div>
      )}
      {zoom && allowZoom && !hidden && image && image.kind !== "visualization" && (
        <GalleryZoom
          items={nativeImages}
          title={title}
          index={nativeIndex}
          move={(direction) => setSelectedId(nativeImages[(nativeIndex + direction + nativeImages.length) % nativeImages.length].id)}
          close={() => setZoom(false)}
        />
      )}
    </div>
  );
}
