import { useEffect, useState } from "react";
import type { VisualizationJobDto, VisualizationStatus } from "../../../shared/visualizations";
import type { ImageSource } from "../../../shared/visualizations/ImageComparison";
import { PrivateImage } from "./PrivateImage";

const statusCopy: Record<VisualizationStatus, string> = {
  awaiting_product: "Preparing your visualization",
  preparing_assets: "Preparing your visualization",
  generating: "Reimagining your room",
  saving: "Saving your visualization",
  completed: "Your visualization is ready",
  failed: "We could not create this visualization",
  unknown: "Checking your visualization",
  cancelled: "Visualization cancelled",
};

/** Estimated progress deliberately stops at 95%; only a saved result completes it. */
export function estimatedGenerationProgress(startedAt: number, now = Date.now()): number {
  return Number.isFinite(startedAt) && startedAt > 0 ? Math.min(95, Math.max(0, (now - startedAt) / 20_000 * 95)) : 0;
}

export function VisualizationCard({ job, source, result, uploadProgress, onOpen, onRetry, onCheck, onDelete }: {
  job: VisualizationJobDto;
  source?: ImageSource | (() => ImageSource);
  result?: ImageSource | (() => ImageSource);
  uploadProgress?: number;
  onOpen?: (job: VisualizationJobDto) => void;
  onRetry?: (job: VisualizationJobDto) => void;
  onCheck?: (job: VisualizationJobDto) => void;
  onDelete?: (job: VisualizationJobDto) => Promise<void> | void;
}) {
  const pending = ["awaiting_product", "preparing_assets", "generating", "saving"].includes(job.status);
  const [tick, setTick] = useState(Date.now());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => {
    if (!pending || uploadProgress !== undefined) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearInterval(timer);
      if (!document.hidden) { setTick(Date.now()); timer = window.setInterval(() => setTick(Date.now()), 200); }
    };
    refresh(); document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [pending, uploadProgress]);
  const progress = uploadProgress === undefined ? estimatedGenerationProgress(Date.parse(job.startedAt ?? job.createdAt), tick) : Math.min(100, Math.max(0, uploadProgress));
  const label = uploadProgress !== undefined ? "Uploading your room photo" : statusCopy[job.status];
  const complete = job.status === "completed" && job.resultAvailable;
  const image = complete ? result : source;
  const preview = <div className="roman-visualization-card-image" style={{ aspectRatio: `${job.width || 1} / ${job.height || 1}` }}>
    {image && <PrivateImage source={image} sourceKey={`${job.id}/${complete ? "result" : "source"}`} alt={complete ? `${job.productTitle} in ${job.windowTitle}` : ""} />}
    {!complete && <div className="roman-generation-content">
      <p role="status" aria-live="polite">{label}</p>
      {pending && <div className="roman-generation-progress" role="progressbar" aria-label={uploadProgress === undefined ? "Estimated generation progress" : "Upload progress"}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}
        aria-valuetext={uploadProgress === undefined ? `${Math.round(progress)}%. Estimated progress.` : `${Math.round(progress)}% uploaded.`}>
        <span style={{ width: `${progress}%` }} />
      </div>}
      {pending && <small>You can keep chatting while your image is prepared.</small>}
      {!pending && job.error && <small>{job.error}</small>}
    </div>}
    {complete && <span className="roman-window-use" aria-hidden="true">View visualization →</span>}
  </div>;
  const remove = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true); setDeleteError(null);
    try { await onDelete(job); }
    catch (reason) { setDeleteError(reason instanceof Error ? reason.message : "We could not delete this visualization."); }
    finally { setDeleting(false); }
  };
  return <article className="roman-media-card roman-visualization-card" data-pending={pending} aria-busy={deleting}>
    {complete && onOpen ? <button type="button" className="roman-window-choice" onClick={() => onOpen(job)} aria-label={`View ${job.productTitle} in ${job.windowTitle}`}>{preview}</button> : preview}
    <div className="roman-visualization-card-copy"><h3 className="roman-media-card-title">{job.windowTitle}</h3><p>{job.productTitle}</p>
      <p className="roman-media-disclaimer">AI preview only. Colour, fit and scale may differ from the finished product.</p>
      {job.status === "failed" && onRetry && <button type="button" className="roman-media-button" onClick={() => onRetry(job)}>Try again</button>}
      {job.status === "unknown" && onCheck && <button type="button" className="roman-media-button" onClick={() => onCheck(job)}>Check status</button>}
      {onDelete && <button type="button" className="roman-media-delete" disabled={deleting} onClick={() => { void remove(); }}>Delete visualization</button>}
      {deleteError && <p role="alert" className="roman-media-error">{deleteError}</p>}
    </div>
  </article>;
}
