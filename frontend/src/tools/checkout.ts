import { CHECKOUT_PATH, type CheckoutResult } from "../../../shared/checkout";

/** Separate the new tab from Roman before checkout can load or redirect. */
export function openCheckout(): CheckoutResult {
  const url = new URL(CHECKOUT_PATH, window.location.origin);
  if (url.protocol !== "https:")
    throw new Error("Checkout is available on the installed HTTPS storefront.");
  const tab = window.open("about:blank", "_blank");
  if (!tab) return { status: "blocked" };
  try {
    tab.opener = null;
    tab.location.replace(url.href);
  } catch (error) {
    tab.close();
    throw error;
  }
  // COOP may sever the handle after navigation; closed is not a load receipt.
  return { status: "opened" };
}
