import { useEffect, useState } from "react";
import type { ConversationClient } from "../session/types";

export function ProductImage({
  productUrl,
  fallback,
  session,
  active,
  admitted = true,
  onResolved,
}: {
  productUrl: string;
  fallback?: string;
  session: ConversationClient;
  active: boolean;
  admitted?: boolean;
  onResolved?: (productUrl: string) => void;
}) {
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
  const candidate = settled
    ? image && image !== failedImage
      ? image
      : fallback
    : undefined;
  const src = active || loadedImage === candidate ? candidate : undefined;

  useEffect(() => {
    if (settled) onResolved?.(productUrl);
  }, [settled, productUrl, onResolved]);

  useEffect(() => {
    if (!active || !admitted || resolved?.productUrl === productUrl) return;
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
  }, [active, admitted, productUrl, resolved?.productUrl, session]);

  return (
    <img
      src={src}
      alt=""
      width={176}
      height={140}
      loading={active ? "eager" : "lazy"}
      decoding="async"
      style={{ visibility: src && loadedImage === src ? undefined : "hidden" }}
      onLoad={() => setLoadedImage(src)}
      onError={() => {
        setLoadedImage(undefined);
        if (image) setFailedImage(image);
      }}
    />
  );
}
