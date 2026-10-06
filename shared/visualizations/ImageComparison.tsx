import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

/** Private consumers own a lease with idempotent release; public/admin URLs remain borrowed. */
export interface ImageLease { url: string; release: () => void }
export type ImageValue = string | ImageLease | null;
export type ImageSource = ImageValue | Promise<ImageValue>;
export type ImageResolver = ImageSource | (() => ImageSource);
export const imageUrl = (value: ImageValue) => typeof value === "string" ? value : value?.url ?? null;
export const releaseImage = (value: ImageValue) => { if (value && typeof value !== "string") value.release(); };

/** The resolver supplies authorized media; presentation only decodes and owns its lease. */
export async function preloadImage(source: ImageResolver, signal: AbortSignal): Promise<ImageValue> {
  let image: HTMLImageElement | undefined;
  let value: ImageValue = null;
  let retained = false;
  const cancel = () => { image?.removeAttribute("src"); releaseImage(value); signal.removeEventListener("abort", cancel); };
  try {
    value = await (typeof source === "function" ? source() : source);
    const url = imageUrl(value);
    if (!url || signal.aborted) return null;
    image = new Image();
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    signal.addEventListener("abort", cancel, { once: true });
    image.src = url;
    await image.decode();
    retained = !signal.aborted && image.naturalWidth > 0;
    return retained ? value : null;
  } catch {
    return null;
  } finally {
    image = undefined;
    // A decoded half must still release promptly if the other half is pending.
    if (!retained) { signal.removeEventListener("abort", cancel); releaseImage(value); }
  }
}

/** Shared customer/admin comparison, preserving source framing and touch scroll. */
export function ImageComparison({ before, after, width = 1, height = 1 }: {
  before: ImageResolver;
  after: ImageResolver;
  width?: number;
  height?: number;
}) {
  const [images, setImages] = useState<{ before: string | null; after: string | null; beforeSource: ImageResolver; afterSource: ImageResolver } | null>(null);
  const [split, setSplit] = useState(50);
  const drag = useRef<{ id: number; x: number; y: number; touch: boolean } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let held: ImageValue[] = [];
    setImages(null);
    setSplit(50);
    void Promise.all([preloadImage(before, abort.signal), preloadImage(after, abort.signal)])
      .then(([original, result]) => {
        if (abort.signal.aborted) { releaseImage(original); releaseImage(result); return; }
        held = [original, result];
        setImages({ before: imageUrl(original), after: imageUrl(result), beforeSource: before, afterSource: after });
      });
    return () => { abort.abort(); held.forEach(releaseImage); };
  }, [before, after]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width) setSplit(Math.max(0, Math.min(100, Math.round((event.clientX - bounds.left) / bounds.width * 100))));
  };
  const release = (element: HTMLDivElement) => {
    const pointer = drag.current;
    if (pointer && element.hasPointerCapture?.(pointer.id)) element.releasePointerCapture(pointer.id);
    drag.current = null;
  };
  const current = images?.beforeSource === before && images.afterSource === after;
  const complete = current && !!images?.before && !!images.after;
  return (
    <div className="roman-image-comparison" data-ready={complete} aria-busy={!current}
      style={{ aspectRatio: `${width > 0 ? width : 1} / ${height > 0 ? height : 1}`, "--roman-comparison-ratio": width > 0 && height > 0 ? width / height : 1, "--roman-comparison-split": `${split}%` } as CSSProperties}>
      {complete ? <>
        <div className="roman-comparison-layer roman-comparison-after"><img src={images.after!} alt="After visualization" draggable={false} /></div>
        <div className="roman-comparison-layer roman-comparison-before"><img src={images.before!} alt="Original window" draggable={false} /></div>
        <div className="roman-comparison-labels" aria-hidden="true"><span>Before</span><span>After</span></div>
        <div className="roman-comparison-handle" aria-hidden="true"><span>↔</span></div>
        <div className="roman-comparison-slider" tabIndex={0} role="slider" aria-label="Before and after split"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={split} aria-valuetext={`${split}% before, ${100 - split}% after`} aria-orientation="horizontal"
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === "touch" };
            if (event.pointerType !== "touch") {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              event.currentTarget.focus({ preventScroll: true });
              move(event);
            }
          }}
          onPointerMove={(event) => {
            const pointer = drag.current;
            if (pointer?.id !== event.pointerId) return;
            if (pointer.touch) {
              const horizontal = Math.abs(event.clientX - pointer.x);
              if (horizontal < 8 || horizontal <= Math.abs(event.clientY - pointer.y)) return;
              pointer.touch = false;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              event.currentTarget.focus({ preventScroll: true });
            }
            move(event);
          }}
          onPointerUp={(event) => release(event.currentTarget)}
          onPointerCancel={(event) => release(event.currentTarget)}
          onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? 100
              : event.key === "ArrowLeft" || event.key === "ArrowDown" ? split - 1
                : event.key === "ArrowRight" || event.key === "ArrowUp" ? split + 1
                  : event.key === "PageDown" ? split - 10 : event.key === "PageUp" ? split + 10 : null;
            if (next !== null) { event.preventDefault(); setSplit(Math.max(0, Math.min(100, next))); }
          }} />
      </> : <p className="roman-comparison-missing" role="status">{current ? "The comparison images are unavailable. Please close and try again." : "Loading your visualization…"}</p>}
    </div>
  );
}
