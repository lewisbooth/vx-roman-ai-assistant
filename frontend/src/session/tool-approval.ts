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
  "The cart changed after review. Ask Roman to prepare a new action before confirming it.";

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
