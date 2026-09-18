export const ASSISTANT_VIEWS = ["chat", "cart", "gallery"] as const;
export type AssistantView = (typeof ASSISTANT_VIEWS)[number];
export interface ViewResult {
  status: "shown";
  view: AssistantView;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseViewCall(input: unknown): { view: AssistantView } {
  if (
    !record(input) ||
    Object.keys(input).length !== 1 ||
    !ASSISTANT_VIEWS.includes(input.view as AssistantView)
  )
    throw new Error("Choose Roman's chat, cart or gallery view.");
  return { view: input.view as AssistantView };
}

export function parseViewResult(input: unknown): ViewResult {
  if (
    !record(input) ||
    Object.keys(input).length !== 2 ||
    input.status !== "shown"
  )
    throw new Error("Roman's requested view was not confirmed.");
  return { status: "shown", ...parseViewCall({ view: input.view }) };
}

export const showViewToolDefinition = {
  type: "function" as const,
  name: "show_view",
  description:
    "Show Roman's Chat, Cart or Gallery tab when the customer asks to see it. Return to Chat once when resuming product work from a known Cart or Gallery view; do not repeat this on every step. This changes only Roman's interface; it never navigates the storefront or alters the cart or active blind. Cart is not shown automatically after adding products or reading its contents. Gallery is for customer photos and future visualizations; uploads and generation are not available yet. A shown result confirms the selected view, not loaded cart contents or a completed upload.",
  strict: true,
  parameters: {
    type: "object",
    properties: { view: { type: "string", enum: [...ASSISTANT_VIEWS] } },
    required: ["view"],
    additionalProperties: false,
  },
};
