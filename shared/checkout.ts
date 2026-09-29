export const CHECKOUT_PATH = "/checkout";

export interface CheckoutResult {
  status: "opened" | "blocked";
}

export function parseCheckoutCall(input: unknown): Record<string, never> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length
  )
    throw new Error(
      "Checkout takes no URL, payment details or other arguments.",
    );
  return {};
}

export function parseCheckoutResult(input: unknown): CheckoutResult {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("status" in input) ||
    (input.status !== "opened" && input.status !== "blocked")
  )
    throw new Error("The checkout handoff was not confirmed.");
  return { status: input.status };
}

export const checkoutToolDefinition = {
  type: "function" as const,
  name: "open_checkout",
  description:
    "For requested checkout, show Roman Cart and attempt this store's fixed /checkout in a new tab. opened confirms a tab/navigation request only; blocked leaves Continue to checkout in Cart for the customer to click. No cart mutation, payment, order or session closure.",
  strict: true,
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};
