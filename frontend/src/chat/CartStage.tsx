import { useState } from "react";
import { CHECKOUT_PATH } from "../../../shared/checkout";
import type { CartDiscountAllocation } from "../../../shared/cart-tools";
import type { CartDisplayState } from "./useCart";

function CartPrice({
  amount,
  original,
  format,
}: {
  amount: number;
  original?: number;
  format: (amount: number) => string;
}) {
  return (
    <span className="roman-cart-price">
      {original !== undefined && original > amount && (
        <del aria-label={`Original price ${format(original)}`}>
          {format(original)}
        </del>
      )}
      <strong>{format(amount)}</strong>
    </span>
  );
}

function CartDiscounts({
  discounts,
  label,
  format,
}: {
  discounts?: CartDiscountAllocation[];
  label: string;
  format: (amount: number) => string;
}) {
  const applied = discounts?.filter(
    (discount) => discount.amountMinorUnits > 0,
  );
  if (!applied?.length) return null;
  return (
    <ul className="roman-cart-discounts" aria-label={label}>
      {applied.map((discount, index) => (
        <li key={`${discount.title}-${index}`}>
          <span>{discount.title}</span>
          <span>−{format(discount.amountMinorUnits)}</span>
        </li>
      ))}
    </ul>
  );
}

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
          <div className={cart.items.length ? "roman-cart-layout" : undefined}>
            {cart.items.length ? (
              <ul className="roman-cart-items">
                {cart.items.map((item) => (
                  <li key={item.lineKey} className="roman-cart-item">
                    <CartImage
                      key={item.imageUrl ?? "missing"}
                      url={item.imageUrl}
                    />
                    <div className="roman-cart-item-content">
                      <h3>{item.title}</h3>
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
                        <CartPrice
                          amount={item.linePriceMinorUnits}
                          original={item.originalLinePriceMinorUnits}
                          format={price}
                        />
                      </div>
                      <CartDiscounts
                        discounts={item.lineDiscounts}
                        label="Applied item discounts"
                        format={price}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Your cart is empty. Let’s find something you love.</p>
            )}
            {cart.items.length > 0 && (
              <section className="roman-cart-summary" aria-label="Cart summary">
                <div className="roman-cart-total">
                  <span>Subtotal</span>
                  <CartPrice
                    amount={cart.totalPriceMinorUnits}
                    original={cart.originalTotalPriceMinorUnits}
                    format={price}
                  />
                </div>
                <CartDiscounts
                  discounts={cart.cartDiscounts}
                  label="Applied cart discounts"
                  format={price}
                />
                {!!cart.totalDiscountMinorUnits && (
                  <p className="roman-cart-savings">
                    <span>Total savings</span>
                    <span>{price(cart.totalDiscountMinorUnits)}</span>
                  </p>
                )}
                <a
                  className="roman-checkout"
                  href={CHECKOUT_PATH}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-roman-native-navigation
                >
                  Continue to checkout <span aria-hidden="true">↗</span>
                </a>
              </section>
            )}
          </div>
        )
      )}
    </aside>
  );
}
