import { useEffect, useRef, useState } from "react";
import type { ConversationClient } from "../session/types";

export function ProductImage({
  productUrl,
  fallback,
  session,
  active,
}: {
  productUrl: string;
  fallback?: string;
  session: ConversationClient;
  active: boolean;
}) {
  const target = useRef<HTMLImageElement>(null);
  const [nearby, setNearby] = useState(() => !window.IntersectionObserver);
  const [resolved, setResolved] = useState<{
    productUrl: string;
    image?: string;
  }>();
  const [failedImage, setFailedImage] = useState<string>();
  const [loadedImage, setLoadedImage] = useState<string>();
  const settled = resolved?.productUrl === productUrl;
  const image = settled ? resolved.image : undefined;
  // The catalog image may be a swatch. Do not paint it as a temporary preview
  // and then visibly replace it with the main product photo.
  const src = settled
    ? image && image !== failedImage
      ? image
      : fallback
    : undefined;

  useEffect(() => {
    if (!window.IntersectionObserver || !target.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearby(entry.isIntersecting),
      {
        root: target.current.closest(".roman-product-scroll"),
        rootMargin: "0px 80px",
      },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !nearby || resolved?.productUrl === productUrl) return;
    let current = true;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (!current) return;
      try {
        const image = await session.loadProductImage(
          productUrl,
          controller.signal,
        );
        if (current && !controller.signal.aborted)
          setResolved({ productUrl, image });
      } catch {
        // Settle on the safe catalog fallback without retrying on every render.
        if (current && !controller.signal.aborted) setResolved({ productUrl });
      }
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [active, nearby, productUrl, resolved?.productUrl, session]);

  return (
    <img
      ref={target}
      src={src}
      alt=""
      width={176}
      height={140}
      loading="lazy"
      style={{ visibility: src && loadedImage === src ? undefined : "hidden" }}
      onLoad={() => setLoadedImage(src)}
      onError={() => {
        setLoadedImage(undefined);
        if (image) setFailedImage(image);
      }}
    />
  );
}
