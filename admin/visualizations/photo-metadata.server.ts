import type { WindowPhoto } from "@prisma/client";
import { parseRoomAnalysis, type PhotoAnalysisStatusDto, type RoomAnalysis } from "../../shared/room-analysis";
import type { WindowPhotoDto } from "../../shared/visualizations";

export function photoDto(photo: WindowPhoto): WindowPhotoDto {
  const analysis = photoAnalysisStatus(photo);
  return {
    id: photo.id, title: photo.title, revision: photo.revision,
    width: photo.width, height: photo.height, cleanup: photo.cleanup,
    createdAt: photo.createdAt.toISOString(),
    ...(analysis ? { analysis } : {}),
  };
}

export interface WindowAnalysisRead extends PhotoAnalysisStatusDto {
  version: string;
  observations: RoomAnalysis | null;
}
export function photoAnalysisStatus(photo: WindowPhoto): PhotoAnalysisStatusDto | undefined {
  if (!photo.analysisStatus || !photo.analysisQueuedAt) return undefined;
  return {
    status: photo.analysisStatus as PhotoAnalysisStatusDto["status"],
    queuedAt: photo.analysisQueuedAt.toISOString(),
    startedAt: photo.analysisStartedAt?.toISOString() ?? null,
    completedAt: photo.analysisCompletedAt?.toISOString() ?? null,
  };
}
/** Only call with a freshly owner-scoped, live photo. No private pixels are read. */
export function photoAnalysisFacts(photo: WindowPhoto): WindowAnalysisRead | null {
  const status = photoAnalysisStatus(photo);
  if (!status || !photo.analysisVersion) return null;
  let observations: RoomAnalysis | null = null;
  if (status.status === "completed" && photo.analysisJson) {
    try { observations = parseRoomAnalysis(JSON.parse(photo.analysisJson)); }
    catch { console.error("[Roman] Cached room analysis is invalid."); }
  }
  return { ...status, version: photo.analysisVersion, observations };
}
