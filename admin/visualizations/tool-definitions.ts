import { photoPresentationSchema } from "../../shared/visualizations";
import { askQuestionToolDefinition } from "../../shared/questions";

const nullableText = { type: ["string", "null"] } as const;
export const presentPhotosToolDefinition = {
  type: "function",
  name: "present_photos",
  strict: true,
  description:
    "Finish with image cards when the customer must choose/upload an image, requests to review one, or needs an image-based clarification such as a suspected measurement swap. Windows/purpose reference shows read-only images and may include clarification with the sole question and its quick answers; keep context in message without repeating the question. These cards do not select images or start previews. A clearly inferred photo needs no reference carousel before generation. For upload/selection, show one upload-first picker and set clarification to null: no question or quick answers. Use only saved IDs verified this turn or the current selected upload. No numeric field, product cards or duplicate question. Uploading or selecting an image does not supply workflow intent.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string", minLength: 1, maxLength: 1000 },
      photoPresentation: { anyOf: photoPresentationSchema.anyOf.slice(1) },
      clarification: {
        description: "A single question with quick answers only beside windows/purpose reference; null for upload, selection or a photo review needing no answer.",
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              question: askQuestionToolDefinition.parameters.properties.question,
              answers: askQuestionToolDefinition.parameters.properties.answers,
            },
            required: ["question", "answers"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["message", "photoPresentation", "clarification"],
  },
} as const;

export const visualizationToolDefinitions = [
  {
    type: "function",
    name: "list_windows",
    strict: true,
    description:
      "List this customer's saved uploads by optional title query and page cursor. Returns image IDs, names, pixel dimensions and cached analysis (when available), plus total and next cursor. Images can be room photos, mood boards or other references; not all contain real windows. Pixel dimensions are not window measurements. Analysis contains uncertain visual observations and per-opening width/height aspect ratios; use its confidence, visibility and the customer's context. No image bytes or file URLs.",
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
      "Rename a known saved upload using its verified image ID and metadata revision, with the customer's requested title or a short context-aware title when the new upload's application uploadSummary.suggestName is true. Use the observed revision unchanged; a newer edit conflicts. Never overwrite a customer's title without their request or retry an inferred name after a conflict. Returns authoritative image metadata; associated visualizations retain their generation-time titles.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        windowId: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 100 },
        revision: {
          type: "integer",
          minimum: 1,
          description: "The revision from this image's current application metadata or list_windows result. Do not invent or increment it.",
        },
      },
      required: ["windowId", "title", "revision"],
    },
  },
  {
    type: "function",
    name: "create_visualization",
    strict: true,
    description:
      "Start one asynchronous preview for a current explicit request or an unpaused unresolved request whose missing inputs are now supplied, with active selected product and a known consented room photo. An accepted job (including explicit upload-interface visualization submission) consumes that request; pending completion or a later product/photo selection does not request another. Neutral upload/list/select/rename and picker purpose do not authorize generation; newer pause/cancellation wins. A later explicit preview is a new request. Requires verified photo ID and active product path. Room cleanup is included automatically. Optional targetDescription identifies the requested opening. Returns accepted job ID/status, not a completed image.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        windowId: { type: "string" },
        productPath: { type: "string" },
        targetDescription: { ...nullableText, maxLength: 300 },
      },
      required: ["windowId", "productPath", "targetDescription"],
    },
  },
] as const;

export function isVisualizationTool(name: string) {
  return visualizationToolDefinitions.some((tool) => tool.name === name);
}
