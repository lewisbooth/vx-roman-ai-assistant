import prisma from "../db.server";
import { ROOM_ANALYSIS_WAIT_MS } from "../../shared/room-analysis";
import { DEFAULT_UPLOAD_TITLE } from "../../shared/visualizations";
import { waitForWindowAnalysis } from "../visualizations/analysis.server";
import { getCurrentContext } from "./repository.server";
import type { ModelMessage } from "./history.server";

/** Only the first reply to a new upload joins its existing background job. */
export async function prepareUploadAnalysis(conversationId: string, assistantId: string, signal: AbortSignal) {
  const conversation = await prisma.conversation.findFirst({ where: {
    id: conversationId, status: "active", galleryOwner: { revokedAt: null },
  }, select: { galleryOwnerId: true, selectedWindowPhotoId: true } });
  if (!conversation?.galleryOwnerId || !conversation.selectedWindowPhotoId) return;
  const photo = await prisma.windowPhoto.findFirst({ where: {
    id: conversation.selectedWindowPhotoId, ownerId: conversation.galleryOwnerId,
    conversationId, uploadStatus: "ready", deletedAt: null,
  }, select: { id: true, analysisQueuedAt: true } });
  if (!photo?.analysisQueuedAt) return;
  const [upload, reply] = await Promise.all([
    prisma.conversationMessage.findFirst({ where: { id: photo.id, conversationId, role: "context", status: "complete" }, select: { sequence: true } }),
    prisma.conversationMessage.findFirst({ where: { id: assistantId, conversationId }, select: { sequence: true } }),
  ]);
  if (!upload || !reply || reply.sequence <= upload.sequence) return;
  const answered = await prisma.conversationMessage.findFirst({ where: {
    conversationId, sequence: { gt: upload.sequence, lt: reply.sequence },
    role: { in: ["assistant", "context"] }, status: "complete", model: { not: null },
  }, select: { id: true } });
  if (answered) return;
  const deadline = photo.analysisQueuedAt.getTime() + ROOM_ANALYSIS_WAIT_MS;
  try {
    await waitForWindowAnalysis(conversation.galleryOwnerId, photo.id, Math.max(0, deadline - Date.now()), signal);
  } catch (error) {
    signal.throwIfAborted();
    // Deletion while waiting is normal; other storage errors still surface.
    if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
  }
  signal.throwIfAborted();
  const context = await getCurrentContext(conversationId);
  const gallery = context.galleryFacts;
  const analysis = gallery?.selectedWindowAnalysis;
  return { ...gallery, ...(gallery?.selectedWindow?.id === photo.id ? {
    uploadSummary: { windowId: photo.id, suggestName: gallery.selectedWindow.title === DEFAULT_UPLOAD_TITLE &&
      gallery.selectedWindow.revision === 1, includeSummary: analysis?.status === "completed" &&
      !!analysis.observations && !!analysis.completedAt && Date.parse(analysis.completedAt) <= deadline },
  } : {}) };
}

/** Refresh only ephemeral Gallery facts, for both primary and fallback histories. */
export function withUploadAnalysis(history: ModelMessage[], gallery: NonNullable<Awaited<ReturnType<typeof prepareUploadAnalysis>>>) {
  return history.map((message) => {
    if (message.source !== "application_state" || !message.text.startsWith("Application state: ")) return message;
    const state = JSON.parse(message.text.slice("Application state: ".length));
    return { ...message, text: `Application state: ${JSON.stringify({ ...state, gallery })}` };
  });
}
