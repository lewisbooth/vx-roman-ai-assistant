import { useEffect, useState } from "react";
import { ROOM_ANALYSIS_WAIT_MS, type PhotoAnalysisStatusDto } from "../../../shared/room-analysis";

export function photoAnalysisPending(analysis?: PhotoAnalysisStatusDto): boolean {
  return analysis?.status === "queued" || analysis?.status === "analyzing";
}

/** Waiting is bounded by the saved upload time, including across reloads. */
export function photoAnalysisProgress(analysis: PhotoAnalysisStatusDto | undefined, now = Date.now()): number | null {
  if (!photoAnalysisPending(analysis)) return null;
  const uploadedAt = Date.parse(analysis!.queuedAt);
  const elapsed = now - uploadedAt;
  if (!Number.isFinite(uploadedAt) || elapsed >= ROOM_ANALYSIS_WAIT_MS) return null;
  return Math.min(95, Math.max(0, elapsed) / 3000 * 95);
}

/** This clock only paints pending work; it never starts a reply or an analysis. */
export function usePhotoAnalysisClock(analyses: readonly (PhotoAnalysisStatusDto | undefined)[]) {
  const [now, setNow] = useState(Date.now);
  const deadline = Math.max(0, ...analyses.filter(photoAnalysisPending).map((analysis) => Date.parse(analysis!.queuedAt) + ROOM_ANALYSIS_WAIT_MS));
  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 100);
    const expiry = window.setTimeout(() => { refresh(); window.clearInterval(timer); }, Math.max(0, deadline - Date.now()));
    return () => { window.clearInterval(timer); window.clearTimeout(expiry); };
  }, [deadline]);
  return now;
}
