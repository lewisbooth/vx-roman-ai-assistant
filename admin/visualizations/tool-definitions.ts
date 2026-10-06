import { photoPresentationSchema } from "../../shared/visualizations";

const nullableText = { type: ["string", "null"] } as const;
export const presentPhotosToolDefinition = {
  type: "function",
  name: "present_photos",
  strict: true,
  description:
    "Finish this reply with one photo picker: an Upload a room photo card followed by saved window photos. Use upload to offer a new photo with the current saved photos, or windows for one to ten saved IDs verified this turn or the current selected window. Include a short message inviting that selection. This picker is the complete next action: no quick answers, numeric field, product cards or extra question. Offering or selecting a photo does not itself authorize a preview.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string", minLength: 1, maxLength: 1000 },
      photoPresentation: { anyOf: photoPresentationSchema.anyOf.slice(1) },
    },
    required: ["message", "photoPresentation"],
  },
} as const;

export const visualizationToolDefinitions = [
  {
    type: "function",
    name: "list_windows",
    strict: true,
    description:
      "List this customer's saved window photos by optional title query and page cursor. Returns photo IDs, names, revision, dimensions and cleanup preference, a total and the next cursor; no image pixels or file URLs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { ...nullableText, maxLength: 100 },
        cursor: nullableText,
      },
      required: ["query", "cursor"],
    },
  },
  {
    type: "function",
    name: "rename_window",
    strict: true,
    description:
      "Rename a known saved window photo. Requires its verified ID and the customer's requested title. Returns the authoritative photo metadata; associated visualizations retain their generation-time titles.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        windowId: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["windowId", "title"],
    },
  },
  {
    type: "function",
    name: "create_visualization",
    strict: true,
    description:
      "Start an asynchronous preview only for a current explicit or unresolved unpaused customer preview request, with active selected product and a known consented window photo. Neutral list/select/rename, a photo name answer and picker purpose alone do not request generation; newer pause/cancellation wins. Requires verified photo ID and active product path; cleanup null reuses the photo preference. Optional targetDescription identifies the requested opening in a photo with several windows. Returns accepted job ID/status, not a completed image.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        windowId: { type: "string" },
        productPath: { type: "string" },
        cleanup: { type: ["boolean", "null"] },
        targetDescription: { ...nullableText, maxLength: 300 },
      },
      required: ["windowId", "productPath", "cleanup", "targetDescription"],
    },
  },
] as const;

export function isVisualizationTool(name: string) {
  return visualizationToolDefinitions.some((tool) => tool.name === name);
}
