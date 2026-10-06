import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { handleJsonRequest, readJsonObject } from "../conversations/http.server";
import { ConversationError } from "../conversations/errors.server";
import { authenticateGallery, linkGalleryConversation } from "../visualizations/auth.server";
import { deleteVisualization, deleteWindow, gallerySnapshot, jobDto, photoDto, ownedJob, renameWindow, saveWindow, selectWindow, uploadStatus } from "../visualizations/repository.server";
import { claimPreparation, completePreparation, recoverImageJobs, startVisualization } from "../visualizations/jobs.server";
import { isMediaId, type VisualizationPreparation } from "../../shared/visualizations";

const string = (body: Record<string, unknown>, key: string) => {
  if (typeof body[key] !== "string") throw new ConversationError(400, `A ${key} is required.`);
  return body[key] as string;
};
const uploadOwners = new Set<string>();
export function loader({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "GET", async () => {
    const owner = await authenticateGallery(request, params.ownerId);
    await recoverImageJobs();
    const query = new URL(request.url).searchParams;
    switch (params.operation) {
      case "list": return gallerySnapshot(owner.id, query.get("windowsCursor"), query.get("jobsCursor"));
      case "job": return jobDto(await ownedJob(owner.id, query.get("id") ?? ""));
      case "upload-status": return uploadStatus(owner.id, query.get("requestId") ?? "");
      case "request-status": {
        const job = await prisma.visualizationJob.findUnique({ where: { ownerId_requestId: { ownerId: owner.id, requestId: query.get("requestId") ?? "" } } });
        return { job: job && !job.deletedAt ? jobDto(job) : null };
      }
      default: throw new ConversationError(404, "Gallery operation not found.");
    }
  });
}
export function action({ request, params }: ActionFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const owner = await authenticateGallery(request, params.ownerId);
    await recoverImageJobs();
    if (params.operation === "upload") {
      if (uploadOwners.size >= 4 || uploadOwners.has(owner.id)) throw new ConversationError(429, "A photo is already uploading. Please try again in a moment.");
      uploadOwners.add(owner.id);
      try {
        const form = await readPhotoForm(request);
        const fields = ["conversationId", "conversationToken", "requestId", "title", "cleanup", "consent", "photo"];
        if ([...form.keys()].length !== fields.length || fields.some((key) => form.getAll(key).length !== 1) || [...form.keys()].some((key) => !fields.includes(key))) throw new ConversationError(400, "Send one photo and its window details.");
        const conversationId = await linkGalleryConversation(owner, String(form.get("conversationId") ?? ""), String(form.get("conversationToken") ?? ""));
        const photo = form.get("photo");
        if (!(photo instanceof File)) throw new ConversationError(400, "Choose a room photo.");
        return await saveWindow(owner, conversationId, { requestId: String(form.get("requestId") ?? ""), title: String(form.get("title") ?? ""), cleanup: form.get("cleanup") === "true", consent: form.get("consent") === "true", bytes: Buffer.from(await photo.arrayBuffer()), contentType: photo.type });
      } finally { uploadOwners.delete(owner.id); }
    }
    const body = await readJsonObject(request);
    switch (params.operation) {
      case "references": {
        const ids = (key: string) => {
          const value = body[key];
          if (!Array.isArray(value) || value.length > 24 || !value.every(isMediaId)) throw new ConversationError(400, "Send up to 24 private media IDs.");
          return value as string[];
        };
        const [windows, jobs] = await Promise.all([
          prisma.windowPhoto.findMany({ where: { ownerId: owner.id, id: { in: ids("windowIds") }, deletedAt: null, uploadStatus: "ready" } }),
          prisma.visualizationJob.findMany({ where: { ownerId: owner.id, id: { in: ids("jobIds") }, deletedAt: null, window: { deletedAt: null } } }),
        ]);
        return { windows: windows.map(photoDto), visualizations: jobs.map(jobDto) };
      }
      case "link": return { conversationId: await linkGalleryConversation(owner, string(body, "conversationId"), string(body, "conversationToken")) };
      case "select": {
        const conversationId = await linkGalleryConversation(owner, string(body, "conversationId"), string(body, "conversationToken"));
        return selectWindow(owner.id, conversationId, string(body, "windowId"));
      }
      case "rename": return renameWindow(owner.id, string(body, "windowId"), string(body, "title"), body.revision as number);
      case "delete-window": await deleteWindow(owner.id, string(body, "windowId")); return { deleted: true };
      case "delete-job": await deleteVisualization(owner.id, string(body, "jobId")); return { deleted: true };
      case "start": {
        const conversationId = await linkGalleryConversation(owner, string(body, "conversationId"), string(body, "conversationToken"));
        return startVisualization(owner, conversationId, { requestId: string(body, "requestId"), windowId: string(body, "windowId"), productPath: string(body, "productPath"), cleanup: body.cleanup as boolean, targetDescription: body.targetDescription as string | undefined });
      }
      case "claim": return claimPreparation(owner.id, string(body, "jobId"), string(body, "clientId"));
      case "prepare": return completePreparation(owner, string(body, "jobId"), string(body, "claimToken"), body.preparation as VisualizationPreparation | undefined, body.error as string | undefined);
      default: throw new ConversationError(404, "Gallery operation not found.");
    }
  });
}
async function readPhotoForm(request: Request) {
  const limit = 26 * 1024 * 1024;
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data;") || !request.body) throw new ConversationError(400, "A multipart room photo is required.");
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ConversationError(400, "This photo is too large.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  let rejectTimeout: (error: Error) => void = () => undefined;
  const timedOut = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const abort = () => rejectTimeout(new ConversationError(400, "The photo upload timed out."));
  deadline.addEventListener("abort", abort, { once: true });
  try {
    deadline.throwIfAborted();
    for (;;) {
      const chunk = await Promise.race([reader.read(), timedOut]);
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) throw new ConversationError(400, "This photo is too large.");
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks, length);
    try { return await new Response(body, { headers: { "Content-Type": type } }).formData(); }
    catch { throw new ConversationError(400, "The photo upload could not be read."); }
  } finally { deadline.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
