import type { VisualizationJobDto, WindowPhotoDto } from "../../../shared/visualizations";
import type { ImageSource } from "../../../shared/visualizations/ImageComparison";
import { LoadMoreSentinel } from "./LoadMoreSentinel";
import { VisualizationCard } from "./VisualizationCard";
import { WindowCard } from "./WindowCard";

export function VisualizationGallery({ windows, visualizations, windowSource, resultSource, selectedWindowId,
  onUpload, onSelectWindow, onRenameWindow, onDeleteWindow, onOpenVisualization, onDeleteVisualization, onRetry, onCheck,
  enabled = true, loading = false, error, hasMoreWindows = false, hasMoreVisualizations = false, onLoadMoreWindows, onLoadMoreVisualizations }: {
  windows: readonly WindowPhotoDto[];
  visualizations: readonly VisualizationJobDto[];
  windowSource: (photo: WindowPhotoDto) => ImageSource;
  resultSource: (job: VisualizationJobDto) => ImageSource;
  selectedWindowId?: string | null;
  onUpload: () => void;
  onSelectWindow: (photo: WindowPhotoDto) => void;
  onRenameWindow: (photo: WindowPhotoDto, title: string) => Promise<void> | void;
  onDeleteWindow: (photo: WindowPhotoDto) => Promise<void> | void;
  onOpenVisualization: (job: VisualizationJobDto) => void;
  onDeleteVisualization: (job: VisualizationJobDto) => Promise<void> | void;
  onRetry?: (job: VisualizationJobDto) => void;
  onCheck?: (job: VisualizationJobDto) => void;
  loading?: boolean;
  enabled?: boolean;
  error?: string | null;
  hasMoreWindows?: boolean;
  hasMoreVisualizations?: boolean;
  onLoadMoreWindows?: () => void;
  onLoadMoreVisualizations?: () => void;
}) {
  return <div className="roman-gallery roman-visualization-gallery" aria-label="Your gallery" aria-busy={loading}>
    {error && <p role="alert" className="roman-media-error">{error}</p>}
    <section aria-labelledby="roman-gallery-uploads">
      <div className="roman-gallery-section-heading"><h2 id="roman-gallery-uploads">Your Uploads</h2>
        <button type="button" className="roman-media-button" disabled={!enabled} onClick={onUpload}>Upload a room photo or mood board</button></div>
      {windows.length ? <ul className="roman-media-grid">{windows.map((photo) => <li key={photo.id}><WindowCard photo={photo} source={() => windowSource(photo)} selected={selectedWindowId === photo.id}
        onSelect={() => onSelectWindow(photo)} onRename={onRenameWindow} onDelete={onDeleteWindow} /></li>)}</ul>
        : <p className="roman-media-empty">{loading ? "Loading your uploads…" : "Save a room photo or mood board to help Roman understand your space and style."}</p>}
      <LoadMoreSentinel key={windows.at(-1)?.id} enabled={hasMoreWindows && !loading} onLoadMore={onLoadMoreWindows} />
    </section>
    <section aria-labelledby="roman-gallery-visualizations">
      <div className="roman-gallery-section-heading"><h2 id="roman-gallery-visualizations">Your Visualizations</h2></div>
      {visualizations.length ? <ul className="roman-media-grid">{visualizations.map((job) => <li key={job.id}><VisualizationCard job={job}
        source={() => { const photo = windows.find((item) => item.id === job.windowId); return photo ? windowSource(photo) : null; }}
        result={() => resultSource(job)} onOpen={onOpenVisualization} onRetry={onRetry} onCheck={onCheck} onDelete={onDeleteVisualization} /></li>)}</ul>
        : <p className="roman-media-empty">{loading ? "Loading your visualizations…" : "Your room previews will appear here."}</p>}
      <LoadMoreSentinel key={visualizations.at(-1)?.id} enabled={hasMoreVisualizations && !loading} onLoadMore={onLoadMoreVisualizations} />
    </section>
  </div>;
}
