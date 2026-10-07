import { useId, useRef, useState, type FormEvent } from "react";
import { windowTitle, type WindowPhotoDto } from "../../../shared/visualizations";
import type { ImageSource } from "../../../shared/visualizations/ImageComparison";
import { ProductCarousel } from "../chat/ProductCarousel";
import { PrivateImage } from "./PrivateImage";
import { PhotoAnalysisProgress } from "./PhotoAnalysisProgress";

export function WindowCard({ photo, source, compact = false, selected = false, disabled = false, visualizationCount, analysisProgress,
  onSelect, onRename, onDelete }: {
  photo: WindowPhotoDto;
  source: ImageSource | (() => ImageSource);
  compact?: boolean;
  selected?: boolean;
  disabled?: boolean;
  visualizationCount?: number;
  analysisProgress?: number | null;
  onSelect?: () => void;
  onRename?: (photo: WindowPhotoDto, title: string) => Promise<void> | void;
  onDelete?: (photo: WindowPhotoDto) => Promise<void> | void;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(photo.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!onRename || pending) return;
    try {
      const valid = windowTitle(title);
      setError(null); setPending(true);
      if (valid !== photo.title) await onRename(photo, valid);
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "We could not rename this window."); }
    finally { setPending(false); }
  };
  const remove = async () => {
    if (!onDelete || pending) return;
    setPending(true); setError(null);
    try { await onDelete(photo); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "We could not delete this window."); }
    finally { setPending(false); }
  };
  const analyzing = analysisProgress !== undefined && analysisProgress !== null;
  const image = <><PrivateImage source={source} sourceKey={photo.id} alt={photo.title} />{analyzing && <PhotoAnalysisProgress progress={analysisProgress} />}</>;
  return <article className={`roman-media-card roman-window-card${compact ? " roman-window-compact" : ""}`} data-selected={selected} aria-busy={pending}>
    {onSelect ? <button type="button" className="roman-window-choice" disabled={disabled || pending} onClick={onSelect} aria-label={`Use ${photo.title}`}>
      <span className="roman-window-image">{image}{!analyzing && <span className="roman-window-use" aria-hidden="true">Use this window →</span>}</span>
      {!editing && <span className="roman-media-card-title">{photo.title}</span>}
    </button> : <><span className="roman-window-image">{image}</span>{!editing && <h3 className="roman-media-card-title">{photo.title}</h3>}</>}
    {editing && <form className="roman-window-rename" onSubmit={(event) => { void rename(event); }}>
      <label htmlFor={id}>Window name</label>
      <input ref={field} id={id} type="text" className="roman-media-input" maxLength={100} required value={title} disabled={pending}
        onChange={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setTitle(photo.title); setEditing(false); setError(null); }
        }} />
      <div className="roman-media-actions"><button type="submit" className="roman-media-button" disabled={pending || !title.trim()}>Save</button>
        <button type="button" className="roman-media-button" disabled={pending} onClick={() => { setTitle(photo.title); setEditing(false); setError(null); }}>Cancel</button></div>
    </form>}
    {!compact && !editing && (onRename || onDelete) && <details className="roman-window-actions">
      <summary aria-label={`Actions for ${photo.title}`}>•••</summary>
      <div>{onRename && <button type="button" disabled={disabled || pending} onClick={() => { setTitle(photo.title); setError(null); setEditing(true); }}>Rename window</button>}
        {onDelete && <button type="button" disabled={disabled || pending} onClick={() => { void remove(); }}>
          {visualizationCount === undefined ? "Delete window and its visualizations" : visualizationCount ? `Delete window and its ${visualizationCount} visualization${visualizationCount === 1 ? "" : "s"}` : "Delete window"}
        </button>}</div>
    </details>}
    {error && <p role="alert" className="roman-media-error">{error}</p>}
  </article>;
}

export function WindowCarousel({ windows, windowSource, onUpload, uploadDisabled = false, onSelect, referenceOnly = false }: {
  windows: readonly WindowPhotoDto[];
  windowSource: (photo: WindowPhotoDto) => ImageSource;
  onUpload: () => void;
  uploadDisabled?: boolean;
  onSelect: (photo: WindowPhotoDto) => void;
  referenceOnly?: boolean;
}) {
  return <ProductCarousel itemLabel="window photos"><ul className="roman-product-list roman-window-carousel">
    {!referenceOnly && <li><article className="roman-media-card roman-window-card roman-window-upload-card">
      <button type="button" className="roman-window-choice" disabled={uploadDisabled} onClick={onUpload}>
        <span className="roman-window-image roman-window-upload-image" aria-hidden="true">
          <svg viewBox="0 0 48 48"><path d="M8 29v9a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-9M24 32V7m-9 9 9-9 9 9" /></svg>
        </span>
        <span className="roman-media-card-title">Upload a room photo</span>
      </button>
    </article></li>}
    {windows.map((photo) => <li key={photo.id}><WindowCard photo={photo} source={() => windowSource(photo)} onSelect={referenceOnly ? undefined : () => onSelect(photo)} /></li>)}
  </ul></ProductCarousel>;
}
