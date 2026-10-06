import { useEffect, useRef, useState } from "react";
import { imageUrl, releaseImage, type ImageResolver, type ImageValue } from "../../../shared/visualizations/ImageComparison";

/** Lazy private URL resolution. Authentication, object URLs and eviction belong to the Gallery client. */
export function PrivateImage({ source, sourceKey, alt, className = "", lazy = true, onReady }: {
  source: ImageResolver;
  sourceKey: string | File;
  alt: string;
  className?: string;
  lazy?: boolean;
  onReady?: (readable: boolean) => void;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const resolver = useRef(source);
  const ready = useRef(onReady);
  resolver.current = source;
  ready.current = onReady;
  const [image, setImage] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    let disposed = false;
    let requested = false;
    let version = 0;
    let held: ImageValue = null;
    const release = () => { releaseImage(held); held = null; };
    setImage({ url: null, failed: false });
    const load = () => {
      if (requested) return;
      requested = true;
      const requestVersion = ++version;
      const resolve = resolver.current;
      void Promise.resolve().then(() => typeof resolve === "function" ? resolve() : resolve)
        .then((value) => {
          if (disposed || requestVersion !== version) { releaseImage(value); return; }
          release(); held = value;
          const url = imageUrl(value);
          setImage({ url, failed: !url });
          if (!url) ready.current?.(false);
        }).catch(() => {
          if (disposed || requestVersion !== version) return;
          setImage({ url: null, failed: true });
          ready.current?.(false);
        });
    };
    const observer = lazy && typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
        else if (requested) {
          // Release decoded pixels outside the visible band. A later entry
          // acquires a fresh URL through the owner's bounded Blob cache.
          version++; requested = false;
          release();
          setImage({ url: null, failed: false });
        }
      }, { rootMargin: "320px" }) : null;
    if (observer && element.current) observer.observe(element.current);
    else load();
    return () => { disposed = true; observer?.disconnect(); release(); };
  }, [sourceKey, lazy]);
  return <span ref={element} className={`roman-private-image ${className}`} aria-busy={!image.url && !image.failed}>
    {image.url && !image.failed ? <img src={image.url} alt={alt} decoding="async" draggable={false}
      onLoad={() => ready.current?.(true)} onError={() => { setImage({ url: null, failed: true }); ready.current?.(false); }} />
      : image.failed ? <span className="roman-media-unavailable">Image unavailable</span> : <span className="roman-media-placeholder" aria-hidden="true" />}
  </span>;
}
