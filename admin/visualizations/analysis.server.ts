import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { WindowPhoto } from "@prisma/client";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";
import { ROOM_ANALYSIS_VERSION } from "../prompts/room-analysis.server";
import { ROOM_ANALYSIS_WAIT_MS } from "../../shared/room-analysis";
import { isMediaId } from "../../shared/visualizations";
import { recordModelUsage } from "../usage/repository.server";
import { MEDIA_CONSENT_VERSION } from "./config.server";
import { readAsset } from "./storage.server";
import { analyzeRoomPhoto, analysisUsage, ROOM_ANALYSIS_TIMEOUT_MS } from "./analysis-provider.server";
import { photoAnalysisFacts, type WindowAnalysisRead } from "./photo-metadata.server";

const MAX_CONCURRENT = 2;
const MAX_ATTEMPTS = 2;
const tasks = new Map<string, Promise<void>>();
let recovery: Promise<void> | undefined;
let pumping: Promise<void> | undefined;
let pumpAgain = false;
let timer: ReturnType<typeof setInterval> | undefined;

async function availablePhoto(ownerId: string, windowId: string) {
  const photo = isMediaId(windowId) ? await prisma.windowPhoto.findFirst({ where: {
    id: windowId, ownerId, uploadStatus: "ready", deletedAt: null, owner: { revokedAt: null },
  } }) : null;
  if (!photo) throw new ConversationError(404, "This image is no longer available.");
  return photo;
}
export async function readWindowAnalysis(ownerId: string, windowId: string): Promise<WindowAnalysisRead | null> {
  return photoAnalysisFacts(await availablePhoto(ownerId, windowId));
}
/** Cancelling the waiter or ending chat never cancels background analysis. */
export async function waitForWindowAnalysis(ownerId: string, windowId: string, timeoutMs = ROOM_ANALYSIS_WAIT_MS, signal?: AbortSignal) {
  const deadline = Date.now() + Math.max(0, Math.min(ROOM_ANALYSIS_WAIT_MS, timeoutMs));
  kickRoomAnalysis();
  for (;;) {
    signal?.throwIfAborted();
    const result = await readWindowAnalysis(ownerId, windowId);
    if (!result || !["queued", "analyzing"].includes(result.status) || Date.now() >= deadline) return result;
    await pause(Math.min(100, deadline - Date.now()), undefined, { signal });
  }
}

async function recoverAnalyses() {
  recovery ??= (async () => {
    const interrupted = await prisma.windowPhoto.findMany({ where: { analysisStatus: "analyzing" } });
    for (const photo of interrupted) {
      if (photo.analysisUsageId) await recordModelUsage(photo.conversationId, photo.id, analysisUsage(photo.analysisUsageId, "failed"));
      const retry = !photo.deletedAt && photo.analysisAttempts < MAX_ATTEMPTS;
      await prisma.windowPhoto.updateMany({ where: { id: photo.id, analysisStatus: "analyzing" }, data: {
        analysisStatus: retry ? "queued" : "failed",
        analysisCompletedAt: retry ? null : new Date(),
        analysisJson: null,
      } });
    }
  })().catch((error) => { recovery = undefined; throw error; });
  await recovery;
}
async function runAnalysis(photo: WindowPhoto, usageId: string) {
  const signal = AbortSignal.timeout(ROOM_ANALYSIS_TIMEOUT_MS);
  let dispatched = false;
  try {
    const live = await availablePhoto(photo.ownerId, photo.id);
    if (live.consentVersion !== MEDIA_CONSENT_VERSION || live.analysisVersion !== ROOM_ANALYSIS_VERSION || !process.env.OPENAI_API_KEY?.trim()) throw new Error("Room analysis is unavailable.");
    const bytes = await readAsset(photo.assetKey);
    if (createHash("sha256").update(bytes).digest("hex") !== photo.sha256) throw new Error("The saved image changed.");
    await availablePhoto(photo.ownerId, photo.id);
    signal.throwIfAborted();
    await recordModelUsage(photo.conversationId, photo.id, analysisUsage(usageId, "pending"));
    dispatched = true;
    const observations = await analyzeRoomPhoto(bytes, {
      usageId, signal,
      onUsage: (usage) => recordModelUsage(photo.conversationId, photo.id, usage),
    });
    // A deleted/revoked photo must never receive newly completed metadata.
    const published = await prisma.windowPhoto.updateMany({ where: {
      id: photo.id, ownerId: photo.ownerId, deletedAt: null, uploadStatus: "ready",
      owner: { revokedAt: null }, analysisStatus: "analyzing", analysisUsageId: usageId,
      sha256: photo.sha256, analysisVersion: ROOM_ANALYSIS_VERSION,
    }, data: { analysisStatus: "completed", analysisJson: JSON.stringify(observations), analysisCompletedAt: new Date() } });
    if (!published.count) await prisma.windowPhoto.updateMany({ where: { id: photo.id, analysisStatus: "analyzing", analysisUsageId: usageId }, data: { analysisStatus: "failed", analysisJson: null, analysisCompletedAt: new Date() } });
  } catch {
    // No remote response text, image data or personal observations enter logs.
    try { if (dispatched) await recordModelUsage(photo.conversationId, photo.id, analysisUsage(usageId, "failed")); }
    catch { console.error("[Roman] Room-analysis usage could not be saved."); }
    await prisma.windowPhoto.updateMany({ where: { id: photo.id, analysisStatus: "analyzing", analysisUsageId: usageId }, data: {
      analysisStatus: "failed", analysisJson: null, analysisCompletedAt: new Date(),
    } });
  }
}
async function pump() {
  await recoverAnalyses();
  while (tasks.size < MAX_CONCURRENT) {
    const photo = await prisma.windowPhoto.findFirst({ where: {
      analysisStatus: "queued", analysisVersion: ROOM_ANALYSIS_VERSION,
      analysisAttempts: { lt: MAX_ATTEMPTS }, uploadStatus: "ready", deletedAt: null,
      owner: { revokedAt: null },
    }, orderBy: [{ analysisQueuedAt: "asc" }, { id: "asc" }] });
    if (!photo) break;
    const usageId = randomUUID();
    const claimed = await prisma.windowPhoto.updateMany({ where: { id: photo.id, analysisStatus: "queued", deletedAt: null }, data: {
      analysisStatus: "analyzing", analysisAttempts: { increment: 1 }, analysisStartedAt: new Date(), analysisUsageId: usageId,
    } });
    if (!claimed.count) continue;
    const task = runAnalysis(photo, usageId).catch(() => {
      console.error("[Roman] Room analysis could not be saved.");
    }).finally(() => { tasks.delete(photo.id); kickRoomAnalysis(); });
    tasks.set(photo.id, task);
  }
}
/** The single server process owns a small durable queue, separate from generation. */
export function kickRoomAnalysis(): void {
  if (pumping) { pumpAgain = true; return; }
  pumping = pump().catch(() => {
    console.error("[Roman] Room-analysis queue is temporarily unavailable.");
  }).finally(() => {
    pumping = undefined;
    if (pumpAgain) { pumpAgain = false; kickRoomAnalysis(); }
  });
}
export function startRoomAnalysisWorker(): void {
  if (timer) return;
  kickRoomAnalysis();
  timer = setInterval(kickRoomAnalysis, 10_000);
  timer.unref();
}
