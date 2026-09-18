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
    "When the customer asks to proceed to checkout, show Roman's Cart and attempt to open this storefront's fixed /checkout in a new tab. This never places an order, submits payment, changes the cart or ends Roman. Complete any necessary cart checks first. Call once, never retry automatically. An opened result confirms only that a new tab was created and navigation requested, not that checkout loaded or payment completed. A blocked result means direct the customer to Continue to checkout in Roman's Cart; that visible link opens a new tab on their click. After a verified result, finish with a brief warm sign-off, not another answer widget.",
  strict: true,
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};
