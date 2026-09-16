import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CatalogResult } from "../../../shared/catalog";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { StorefrontLink } from "./StorefrontLink";
import { ProductImage } from "./ProductImage";
import { ProductCarousel } from "./ProductCarousel";

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
  const target = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(() => !window.IntersectionObserver);

  useEffect(() => {
    if (!window.IntersectionObserver || !target.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearby(entry.isIntersecting),
      {
        root: target.current.closest(".roman-chat-scroll"),
        rootMargin: "200px 0px",
      },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(onContentChange, [result, error, onContentChange]);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [ids, session]);

  useEffect(() => {
    if (!nearby || result) return;
    let current = true;
    const controller = new AbortController();
    setError(null);
    // A discarded StrictMode setup must not enqueue a duplicate catalog call.
    void Promise.resolve().then(async () => {
      if (!current) return;
      try {
        const selectedIds = ids.split(",");
        const value = await session.loadProducts(
          selectedIds,
          controller.signal,
        );
        const productsById = new Map(
          value.products.map((product) => [product.id, product]),
        );
        if (current && !controller.signal.aborted)
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
    return () => {
      current = false;
      controller.abort();
    };
  }, [ids, session, attempt, nearby, result]);

  const frame = (content: ReactNode) => <div ref={target}>{content}</div>;

  if (error)
    return frame(
      <div className="roman-products-status" role="status">
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry products
        </button>
      </div>,
    );
  if (!result)
    return frame(
      <p className="roman-products-status" role="status">
        Loading products…
      </p>,
    );
  return frame(
    <div className="roman-products">
      {result.products.length > 0 ? (
        <ProductCarousel>
          <ul className="roman-product-list">
            {result.products.map((product) => (
              <li key={product.id}>
                <StorefrontLink
                  url={product.url}
                  navigation={navigation}
                  className="roman-product-card"
                >
                  <ProductImage
                    productUrl={product.url}
                    fallback={product.imageUrl}
                    session={session}
                    active={nearby}
                  />
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
        </ProductCarousel>
      ) : (
        <p className="roman-products-status">
          These products are no longer available.
        </p>
      )}
      {result.messages.map((message, index) => (
        <p key={index} className="roman-products-note">
          {message.text}
        </p>
      ))}
    </div>,
  );
}
