import { useState } from "react";
import { productImageWidth } from "../tools/product-image";

export function ProductImage({
  imageUrl,
  active,
}: {
  imageUrl?: string;
  active: boolean;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const [loadedImage, setLoadedImage] = useState<string>();
  const image = imageUrl ? productImageWidth(imageUrl, 480) : undefined;
  const candidate = image !== failedImage ? image : undefined;
  const src = active || loadedImage === candidate ? candidate : undefined;

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
