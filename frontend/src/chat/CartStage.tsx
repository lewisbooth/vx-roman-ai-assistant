import { useState } from "react";
import { CHECKOUT_PATH } from "../../../shared/checkout";
import type { CartDisplayState } from "./useCart";

function CartImage({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="roman-cart-image" aria-hidden="true">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>Image unavailable</span>
      )}
    </div>
  );
}

/** Cart presentation shares its read state with Roman's navigation badge. */
export function CartStage({ cart, error, loading, retry }: CartDisplayState) {
  const price = (minor: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: cart!.currency,
    }).format(minor / 100);
  return (
    <aside
      className="roman-cart-stage"
      aria-label="Your Shopify cart"
      aria-busy={loading}
    >
      <span className="roman-stage-eyebrow">Your selection</span>
      <h2>Your cart</h2>
      {loading ? (
        <p role="status">Updating your cart…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={retry}>
            Retry cart
          </button>
        </div>
      ) : (
        cart && (
          <>
            {cart.items.length ? (
              <ul className="roman-cart-items">
                {cart.items.map((item) => (
                  <li
                    key={item.lineKey}
                    className="roman-product-card roman-cart-card"
                  >
                    <CartImage
                      key={item.imageUrl ?? "missing"}
                      url={item.imageUrl}
                    />
                    <h3 className="roman-product-title">{item.title}</h3>
                    {item.configuration.length > 0 && (
                      <dl className="roman-cart-configuration">
                        {item.configuration.map(({ name, value }) => (
                          <div key={JSON.stringify([name, value])}>
                            <dt>{name}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    <div className="roman-cart-item-details">
                      <span>Quantity {item.quantity}</span>
                      <strong>{price(item.linePriceMinorUnits)}</strong>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Your cart is empty. Let’s find something you love.</p>
            )}
            {cart.items.length > 0 && (
              <div className="roman-cart-summary">
                <div className="roman-cart-total">
                  <span>Subtotal</span>
                  <strong>{price(cart.totalPriceMinorUnits)}</strong>
                </div>
                <a
                  className="roman-checkout"
                  href={CHECKOUT_PATH}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-roman-native-navigation
                >
                  Continue to checkout <span aria-hidden="true">↗</span>
                </a>
              </div>
            )}
          </>
        )
      )}
    </aside>
  );
}
