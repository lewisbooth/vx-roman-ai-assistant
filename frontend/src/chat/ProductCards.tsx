import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CatalogResult, CatalogProduct } from "../../../shared/catalog";
import type { ConversationClient } from "../session/types";
import { ProductImage } from "./ProductImage";
import { ProductCarousel } from "./ProductCarousel";

function ProductCardsView({
  productIds,
  carouselId,
  session,
  onChoose,
  disabled,
  preload = false,
  onContentChange,
}: {
  productIds: readonly string[];
  carouselId: string;
  session: ConversationClient;
  onChoose?: (carouselId: string, product: CatalogProduct) => Promise<void>;
  disabled?: boolean;
  /** Load a fresh carousel while its surrounding reply text reveals. */
  preload?: boolean;
  onContentChange: () => void;
}) {
  const ids = productIds.join(",");
  const [loaded, setLoaded] = useState<{
    ids: string;
    session: ConversationClient;
    result?: CatalogResult;
    error?: string;
  }>();
  const currentResult = loaded?.ids === ids && loaded.session === session;
  const result = currentResult ? loaded.result : undefined;
  const error = currentResult ? loaded.error : undefined;
  const [resolvedImages, setResolvedImages] = useState<{
    ids: string;
    session: ConversationClient;
    urls: Set<string>;
  }>();
  const imageLimit =
    2 +
    (resolvedImages?.ids === ids && resolvedImages.session === session
      ? resolvedImages.urls.size
      : 0);
  const imageResolved = useCallback(
    (url: string) => {
      setResolvedImages((previous) => {
        const current = previous?.ids === ids && previous.session === session;
        if (current && previous.urls.has(url)) return previous;
        return {
          ids,
          session,
          urls: new Set([...(current ? previous.urls : []), url]),
        };
      });
    },
    [ids, session],
  );
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [choiceError, setChoiceError] = useState<string>();
  const choosingRef = useRef(false);

  async function choose(product: CatalogProduct) {
    if (!onChoose || disabled || choosingRef.current) return;
    choosingRef.current = true;
    setChoosing(true);
    setChoiceError(undefined);
    try {
      await onChoose(carouselId, product);
    } catch (cause) {
      setChoiceError(
        cause instanceof Error
          ? cause.message
          : "Please try choosing this blind again.",
      );
    } finally {
      choosingRef.current = false;
      setChoosing(false);
    }
  }
  const target = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(
    () => preload || !window.IntersectionObserver,
  );
  useLayoutEffect(() => {
    if (preload) setNearby(true);
  }, [preload]);
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    const ancestors: Element[] = [];
    let parent =
      target.current?.closest(".roman-chat-history") ??
      target.current?.parentElement;
    while (parent) {
      ancestors.push(parent);
      parent = parent.parentElement;
    }
    // Hidden Chat, Settings or the assistant shell still cancel optional work.
    const update = () =>
      setVisible(
        !document.hidden &&
          !ancestors.some((element) => element.hasAttribute("hidden")),
      );
    update();
    const observer = new MutationObserver(update);
    ancestors.forEach((element) =>
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["hidden"],
      }),
    );
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const active = visible && (nearby || preload);

  useEffect(() => {
    if (preload || !window.IntersectionObserver || !target.current) return;
    let current = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (current) setNearby(entry.isIntersecting);
      },
      {
        root: target.current.closest(".roman-chat-scroll"),
        rootMargin: "200px 0px",
      },
    );
    observer.observe(target.current);
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [preload]);

  useLayoutEffect(onContentChange, [ids, result, error, onContentChange]);

  useEffect(() => {
    if (!active || result) return;
    let current = true;
    const controller = new AbortController();
    setLoaded({ ids, session });
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
          setLoaded({
            ids,
            session,
            result: {
              ...value,
              products: selectedIds.flatMap((id) => productsById.get(id) ?? []),
            },
          });
      } catch (cause) {
        if (current)
          setLoaded({
            ids,
            session,
            error:
              cause instanceof Error
                ? cause.message
                : "Products could not be loaded. Please retry.",
          });
      }
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [ids, session, attempt, active, result]);

  const frame = (content: ReactNode) => (
    <div ref={target}>
      {content}
    </div>
  );

  if (error)
    return frame(
      <div className="roman-products-status" role="status">
        <p>{error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry products
        </button>
      </div>,
    );
  if (!result) {
    const titles = new Map(
      session.getCachedProducts(productIds).map(({ id, title }) => [id, title]),
    );
    return frame(
      <div className="roman-products">
        <p className="sr-only" role="status">
          Loading products…
        </p>
        <ProductCarousel>
          <ul className="roman-product-list" aria-hidden="true">
            {productIds.map((id) => (
              <li key={id}>
                <div className="roman-product-card roman-product-skeleton">
                  <span className="roman-product-image" />
                  <span className="roman-product-title">
                    {titles.get(id) ?? (
                      <>
                        <span />
                        <span />
                      </>
                    )}
                  </span>
                  <span className="roman-product-price">
                    <span />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </ProductCarousel>
      </div>,
    );
  }
  return frame(
    <div className="roman-products">
      {result.products.length > 0 ? (
        <ProductCarousel>
          <ul className="roman-product-list">
            {result.products.map((product, index) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="roman-product-card roman-choose-blind"
                  disabled={!onChoose || disabled || choosing}
                  aria-label={`Choose ${product.title}`}
                  onClick={() => void choose(product)}
                >
                  <span className="roman-product-image">
                    <ProductImage
                      productUrl={product.url}
                      fallback={product.imageUrl}
                      session={session}
                      active={active}
                      admitted={index < imageLimit}
                      onResolved={imageResolved}
                    />
                    <span
                      className="roman-choose-blind-label"
                      aria-hidden="true"
                    >
                      Choose this blind <span>→</span>
                    </span>
                  </span>
                  <span className="roman-product-title">{product.title}</span>
                  <span className="roman-product-price">
                    {product.priceLabel}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ProductCarousel>
      ) : (
        <p className="roman-products-status">
          These products are no longer available.
        </p>
      )}
      {choiceError && (
        <p role="alert" className="roman-chat-error">
          {choiceError}
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

// The transcript's reveal clock must not repeatedly measure historical carousels.
export const ProductCards = memo(ProductCardsView);
