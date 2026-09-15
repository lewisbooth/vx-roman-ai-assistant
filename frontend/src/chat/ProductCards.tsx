import { useEffect, useLayoutEffect, useState } from "react";
import type { CatalogResult } from "../../../shared/catalog";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { StorefrontLink } from "./StorefrontLink";

export function ProductCards({
  productIds,
  session,
  navigation,
  onContentChange,
}: {
  productIds: readonly string[];
  session: ConversationClient;
  navigation: StorefrontNavigation;
  onContentChange: () => void;
}) {
  const ids = productIds.join(",");
  const [result, setResult] = useState<CatalogResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(onContentChange, [result, error, onContentChange]);

  useEffect(() => {
    let current = true;
    setResult(null);
    setError(null);
    // A discarded StrictMode setup must not enqueue a duplicate catalog call.
    void Promise.resolve().then(async () => {
      if (!current) return;
      try {
        const selectedIds = ids.split(",");
        const value = await session.loadProducts(selectedIds);
        const productsById = new Map(
          value.products.map((product) => [product.id, product]),
        );
        if (current)
          setResult({
            ...value,
            products: selectedIds.flatMap((id) => productsById.get(id) ?? []),
          });
      } catch (cause) {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Products could not be loaded. Please retry.",
          );
      }
    });
    // The session owns network cancellation when the runtime is disposed.
    return () => {
      current = false;
    };
  }, [ids, session, attempt]);

  if (error)
    return (
      <div className="roman-products-status" role="status">
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry products
        </button>
      </div>
    );
  if (!result)
    return (
      <p className="roman-products-status" role="status">
        Loading products…
      </p>
    );
  return (
    <div className="roman-products">
      {result.products.length > 0 ? (
        <div
          className="roman-product-scroll"
          role="region"
          aria-label="Recommended products"
        >
          <ul className="roman-product-list">
            {result.products.map((product) => (
              <li key={product.id}>
                <StorefrontLink
                  url={product.url}
                  navigation={navigation}
                  className="roman-product-card"
                >
                  {product.imageUrl && (
                    <img
                      src={product.imageUrl}
                      alt=""
                      width={176}
                      height={140}
                      loading="lazy"
                    />
                  )}
                  <span className="roman-product-title">{product.title}</span>
                  {product.priceLabel && (
                    <span className="roman-product-price">
                      {product.priceLabel}
                    </span>
                  )}
                </StorefrontLink>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="roman-products-status">
          These products are no longer available.
        </p>
      )}
      {result.products.some((product) => product.priceLabel) && (
        <p className="roman-products-note">
          Final price depends on options and measurements.
        </p>
      )}
      {result.messages.map((message, index) => (
        <p key={index} className="roman-products-note">
          {message.text}
        </p>
      ))}
    </div>
  );
}
