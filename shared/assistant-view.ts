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
    "Select Roman Chat, Cart or Gallery. Changes only the visible Roman view, not background navigation, active product or cart contents. shown confirms the selected view, not loaded content or an upload.",
  strict: true,
  parameters: {
    type: "object",
    properties: { view: { type: "string", enum: [...ASSISTANT_VIEWS] } },
    required: ["view"],
    additionalProperties: false,
  },
};
