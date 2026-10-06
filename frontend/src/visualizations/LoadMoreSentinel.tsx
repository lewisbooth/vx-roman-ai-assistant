import { useEffect, useRef } from "react";

/** Pagination belongs to the caller; this only requests the next visible page. */
export function LoadMoreSentinel({ enabled, onLoadMore }: { enabled: boolean; onLoadMore?: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useRef(onLoadMore);
  load.current = onLoadMore;
  useEffect(() => {
    if (!enabled || !load.current || !sentinel.current) return;
    let requested = false;
    const observer = new IntersectionObserver((entries) => {
      if (!requested && entries.some((entry) => entry.isIntersecting)) { requested = true; load.current?.(); }
    }, { rootMargin: "320px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled]);
  return <div ref={sentinel} className="roman-media-more" aria-hidden="true" />;
}
