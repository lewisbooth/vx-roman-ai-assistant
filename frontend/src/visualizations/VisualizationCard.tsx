import { useEffect, useState } from "react";
import type { VisualizationJobDto, VisualizationStatus } from "../../../shared/visualizations";
import type { ImageSource } from "../../../shared/visualizations/ImageComparison";
import { PrivateImage } from "./PrivateImage";
import { BrandedDialog } from "../chat/BrandedDialog";

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

/** Match VX Visualizer's elapsed-time estimate and wait for a saved result. */
export function estimatedGenerationProgress(startedAt: number, now = Date.now()): number {
  return Number.isFinite(startedAt) ? Math.min(95, Math.max(0, (now - startedAt) / 15_000 * 95)) : 0;
}

export function VisualizationCard({ job, source, result, uploadProgress, analysisProgress, onOpen, onRetry, onCheck, onDelete }: {
  job: VisualizationJobDto;
  source?: ImageSource | (() => ImageSource);
  result?: ImageSource | (() => ImageSource);
  uploadProgress?: number;
  analysisProgress?: number | null;
  onOpen?: (job: VisualizationJobDto) => void;
  onRetry?: (job: VisualizationJobDto) => void;
  onCheck?: (job: VisualizationJobDto) => void;
  onDelete?: (job: VisualizationJobDto) => Promise<void> | void;
}) {
  const pending = ["awaiting_product", "preparing_assets", "generating", "saving"].includes(job.status);
  const [tick, setTick] = useState(Date.now);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const analyzing = analysisProgress !== undefined && analysisProgress !== null;
  const hasProduct = !!job.productPath;
  const estimating = (job.status === "generating" || job.status === "saving") && uploadProgress === undefined && !analyzing;
  useEffect(() => {
    if (!estimating) return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearInterval(timer);
      if (!document.hidden) { setTick(Date.now()); timer = window.setInterval(() => setTick(Date.now()), 200); }
    };
    refresh(); document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [estimating]);
  let progress: { value: number; label: string; text: string } | undefined;
  if (analyzing) {
    progress = { value: analysisProgress, label: "Estimated room analysis progress", text: `${Math.round(analysisProgress)}%. Estimated progress.` };
  } else if (uploadProgress !== undefined) {
    const value = Math.min(100, Math.max(0, uploadProgress));
    progress = { value, label: "Upload progress", text: `${Math.round(value)}% uploaded.` };
  } else if (estimating) {
    const value = estimatedGenerationProgress(Date.parse(job.startedAt ?? job.createdAt), tick);
    progress = { value, label: "Estimated generation progress", text: value >= 95 ? "Still generating. Estimated progress." : `${Math.round(value)}%. Estimated progress.` };
  } else if (pending && hasProduct) {
    progress = { value: 100, label: "Room photo preparation", text: "Room photo ready. Preparing your visualization." };
  }
  const label = analyzing ? "Analyzing your room" : uploadProgress !== undefined ? "Uploading your image" : hasProduct ? statusCopy[job.status] : pending ? "Saving your image" : "Checking your upload";
  const complete = job.status === "completed" && job.resultAvailable;
  const image = complete ? result : source;
  const preview = <div className="roman-visualization-card-image" style={{ aspectRatio: `${job.width || 1} / ${job.height || 1}` }}>
    {image && <PrivateImage source={image} sourceKey={`${job.id}/${complete ? "result" : "source"}`} alt={complete ? `${job.productTitle} in ${job.windowTitle}` : ""} />}
    {!complete && <div className="roman-generation-content">
      <p role="status" aria-live="polite">{label}</p>
      {pending && progress && <div className="roman-generation-progress" role="progressbar" aria-label={progress.label}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.value)}
        aria-valuetext={progress.text}>
        <span style={{ width: `${progress.value}%` }} />
      </div>}
      {pending && <small>You can keep chatting while your image is prepared.</small>}
      {!pending && job.error && <small>{job.error}</small>}
    </div>}
    {complete && <span className="roman-window-use" aria-hidden="true">View visualization →</span>}
  </div>;
  const remove = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true); setDeleteError(null);
    try { await onDelete(job); setConfirmingDelete(false); }
    catch (reason) { setDeleteError(reason instanceof Error ? reason.message : "We could not delete this visualization."); }
    finally { setDeleting(false); }
  };
  return <article className="roman-media-card roman-visualization-card" data-pending={pending} aria-busy={deleting}>
    {complete && onOpen ? <button type="button" className="roman-window-choice" onClick={() => onOpen(job)} aria-label={`View ${job.productTitle} in ${job.windowTitle}`}>{preview}</button> : preview}
    <div className="roman-visualization-card-copy"><h3 className="roman-media-card-title">{job.windowTitle}</h3><p>{job.productTitle}</p>
      {hasProduct && <p className="roman-media-disclaimer">AI preview only. Colour, fit and scale may differ from the finished product.</p>}
      {job.status === "failed" && onRetry && <button type="button" className="roman-media-button" onClick={() => onRetry(job)}>Try again</button>}
      {job.status === "unknown" && onCheck && <button type="button" className="roman-media-button" onClick={() => onCheck(job)}>Check status</button>}
      {onDelete && <button type="button" className="roman-media-delete" disabled={deleting} onClick={() => { setDeleteError(null); setConfirmingDelete(true); }}>Delete visualization</button>}
    </div>
    {confirmingDelete && <BrandedDialog title="Delete this visualization?"
      description={`The preview of ${job.productTitle} in “${job.windowTitle}” will be permanently deleted. Your uploaded image will remain.`}
      pending={deleting} error={deleteError} onClose={() => setConfirmingDelete(false)}>
      <button type="button" className="roman-dialog-secondary" disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</button>
      <button type="button" className="roman-dialog-primary" data-roman-confirm-delete-visualization disabled={deleting} onClick={() => { void remove(); }}>{deleting ? "Deleting…" : "Delete visualization"}</button>
    </BrandedDialog>}
  </article>;
}
