import { parseCartResult, type CartSnapshot } from "../../../shared/cart-tools";

export interface ToolApprovalReview {
  title: string;
  details: string[];
}

export interface PendingToolApproval extends ToolApprovalReview {
  invocationId: string;
  unavailable?: string;
}

const changed =
  "The product or cart changed after review. Ask Roman to prepare a new action before confirming it.";

/** This fingerprint stays in this browser's memory; it is never a model/API value. */
export function inspectConfiguredProduct(productPath: string) {
  if (
    window.location.pathname.replace(/\/$/, "") !== productPath ||
    new URL(window.location.href).searchParams.has("line") ||
    !document.body.classList.contains("template-product")
  )
    throw new Error(
      "Open the requested product and configure it before reviewing an add to cart.",
    );
  const forms = document.querySelectorAll<HTMLFormElement>(
    "app-provider > main#main dynamic-pricing > form[data-dynamic-pricing-form]",
  );
  if (forms.length !== 1)
    throw new Error("Review this product using its own add to cart controls.");
  const form = forms[0];
  const controls = [
    ...form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,select,textarea"),
  ];
  if (controls.length > 1000)
    throw new Error("Review this product using its own add to cart controls.");
  // This is the theme's observed dynamic price output, including its subtotal.
  const prices = [...form.querySelectorAll("[data-dynamic-price]")];
  if (prices.length > 20)
    throw new Error("Review this product using its own add to cart controls.");
  const fingerprint = JSON.stringify([
    controls.map((input) => [
      input.localName,
      input.name,
      input.type,
      input.value,
      input.disabled,
      "checked" in input ? input.checked : null,
      input instanceof HTMLSelectElement
        ? [...input.selectedOptions].map((option) => option.value)
        : null,
    ]),
    prices.map((price) =>
      price.textContent?.replace(/\s+/g, " ").trim().slice(0, 300),
    ),
  ]);
  if (fingerprint.length > 64_000)
    throw new Error("Review this product using its own add to cart controls.");
  const title =
    document
      .querySelector("main#main h1")
      ?.textContent?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 300) || "The product currently open";
  const quantities = form.querySelectorAll<HTMLSelectElement>(
    'select[data-quantity-select][name="quantity"]',
  );
  const quantity =
    quantities.length === 1 && /^[1-9]\d{0,2}$/.test(quantities[0].value)
      ? Number(quantities[0].value)
      : undefined;
  return { form, fingerprint, title, quantity };
}

export function recheckConfiguredProduct(
  productPath: string,
  expected: ReturnType<typeof inspectConfiguredProduct>,
) {
  const current = inspectConfiguredProduct(productPath);
  if (
    current.form !== expected.form ||
    current.fingerprint !== expected.fingerprint
  )
    throw new Error(changed);
}

export function publicCart(value: unknown): CartSnapshot {
  return parseCartResult("get_cart", value) as CartSnapshot;
}

export function cartReview(
  name: string,
  args: Record<string, unknown>,
  cart: CartSnapshot,
): ToolApprovalReview {
  if (name === "clear_cart") {
    if (!cart.items.length) throw new Error("Your cart is already empty.");
    return {
      title: "Empty your cart?",
      details: cart.items.map(
        (item) => `${item.title} — quantity ${item.quantity}`,
      ),
    };
  }
  const item = cart.items.find((item) => item.lineKey === args.lineKey);
  if (!item)
    throw new Error(
      "This item is no longer in your cart. Ask Roman to check the cart again.",
    );
  return {
    title:
      name === "remove_from_cart"
        ? "Remove this item?"
        : "Change this quantity?",
    details: [
      item.title,
      name === "remove_from_cart"
        ? `Remove all ${item.quantity} from this line. The store may also remove linked items.`
        : `Change quantity from ${item.quantity} to ${args.quantity}. The store controls any linked items.`,
    ],
  };
}

export function recheckCart(expected: CartSnapshot, current: CartSnapshot) {
  if (JSON.stringify(expected) !== JSON.stringify(current))
    throw new Error(changed);
}
