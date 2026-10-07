import { photoPresentationSchema } from "../../shared/visualizations";

const nullableText = { type: ["string", "null"] } as const;
export const presentPhotosToolDefinition = {
  type: "function",
  name: "present_photos",
  strict: true,
  description:
    "Finish with photo cards when the customer must choose/upload a photo, requests to review one, or needs a photo-based clarification such as a suspected measurement swap. Use windows/purpose reference with the sole clarification in message; these cards do not select photos or start previews. A clearly inferred photo needs no reference carousel before generation. For upload/selection, show one upload-first picker. Use only saved IDs verified this turn or the current selected window. No separate quick answers, numeric field, product cards or duplicate question. Photo selection alone does not authorize a preview.",
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
      "List this customer's saved window photos by optional title query and page cursor. Returns IDs, names, pixel dimensions, cleanup preference and cached room analysis (when available), plus total and next cursor. Pixel dimensions are not window measurements. Analysis contains uncertain room observations and per-opening width/height aspect ratios; use its confidence, visibility and the customer's context. No image bytes or file URLs.",
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
      "Start one asynchronous preview for a current explicit request or an unpaused unresolved request whose missing inputs are now supplied, with active selected product and a known consented window photo. An accepted job (including upload-interface submission) consumes that request; pending completion or a later product/photo selection does not request another. Neutral list/select/rename and picker purpose do not authorize generation; newer pause/cancellation wins. A later explicit preview is a new request. Requires verified photo ID and active product path; cleanup null reuses the photo preference. Optional targetDescription identifies the requested opening. Returns accepted job ID/status, not a completed image.",
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
