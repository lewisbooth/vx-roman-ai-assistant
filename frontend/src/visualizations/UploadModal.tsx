import { useId, useRef, useState, type FormEvent } from "react";
import { windowTitle, type WindowPhotoDto } from "../../../shared/visualizations";
import type { ImageSource, ImageResolver } from "../../../shared/visualizations/ImageComparison";
import { PrivateImage } from "./PrivateImage";
import { VisualizationDialog } from "../../../shared/visualizations/VisualizationDialog";
import { WindowCard } from "./WindowCard";
import { LoadMoreSentinel } from "./LoadMoreSentinel";

export interface UploadDraft {
  file: File | null;
  window: WindowPhotoDto | null;
  preview: ImageResolver;
  title: string;
  cleanup: boolean;
  consent: boolean;
  width?: number;
  height?: number;
}

export function UploadModal({ draft, windows, productTitle, windowSource, onDraftChange, onFile, onSelectWindow,
  onSubmit, onClose, error, busy = false, awaitingProduct = false, hasMoreWindows = false, onLoadMoreWindows }: {
  draft: UploadDraft;
  windows: readonly WindowPhotoDto[];
  productTitle?: string | null;
  windowSource: (photo: WindowPhotoDto) => ImageSource;
  onDraftChange: (patch: Partial<UploadDraft>) => void;
  onFile: (file: File) => void;
  onSelectWindow: (photo: WindowPhotoDto) => void;
  onSubmit: (draft: UploadDraft) => void;
  onClose: () => void;
  error?: string | null;
  busy?: boolean;
  awaitingProduct?: boolean;
  hasMoreWindows?: boolean;
  onLoadMoreWindows?: () => void;
}) {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [readableKey, setReadableKey] = useState<string | File | null>(null);
  const reviewing = !!draft.file || !!draft.window;
  const previewKey = draft.window?.id ?? draft.file ?? "empty";
  const readable = readableKey === previewKey;
  const selectFile = (file: File) => { setValidation(null); setReadableKey(null); onFile(file); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const title = windowTitle(draft.title);
      if (!readable || !reviewing) throw new Error("Choose a readable room photo.");
      if (!draft.consent) throw new Error("Please consent to processing and storing this image.");
      if (awaitingProduct) throw new Error("The selected blind must be open in Roman before starting this preview.");
      setValidation(null);
      onSubmit({ ...draft, title });
    } catch (reason) { setValidation(reason instanceof Error ? reason.message : "Check your photo and window name."); }
  };
  return <VisualizationDialog title="See your room in a new light" pending={busy} onClose={onClose}>
    <form className="roman-photo-form" onSubmit={submit}>
      <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" className="roman-photo-input" aria-label="Room photo" disabled={busy}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) selectFile(file); event.currentTarget.value = ""; }} />
      {reviewing ? <div className="roman-photo-setup">
        <div className="roman-photo-preview">
          <PrivateImage source={draft.preview} sourceKey={previewKey} alt="Your selected room photo" lazy={false}
            onReady={(valid) => {
              setReadableKey(valid ? previewKey : null);
              if (!valid) {
                setValidation("Choose a readable room photo.");
                if (draft.file) onDraftChange({ file: null, window: null, preview: null, consent: false });
              }
            }} />
          <div className="roman-photo-picker-actions">
            <button type="button" className="roman-media-button" disabled={busy} onClick={() => picker.current?.click()}>Change Image</button>
            <button type="button" className="roman-media-button" disabled={busy} onClick={() => { setValidation(null); setReadableKey(null); onDraftChange({ file: null, window: null, preview: null, consent: false }); }}>Clear image</button>
          </div>
        </div>
        <div className="roman-photo-options">
          <label className="roman-photo-name" htmlFor={`${id}-name`}>What should we name your window?</label>
          <input id={`${id}-name`} className="roman-media-input" type="text" required maxLength={100} value={draft.title} disabled={busy}
            placeholder="e.g. Kitchen window" onChange={(event) => onDraftChange({ title: event.currentTarget.value })} />
          <label className="roman-photo-option">
            <input type="checkbox" checked={draft.cleanup} disabled={busy} onChange={(event) => onDraftChange({ cleanup: event.currentTarget.checked })} />
            <span>Clean up my room<small>Remove clutter and enhance the lighting.</small></span>
          </label>
          {!draft.window && <label className="roman-photo-option">
            <input type="checkbox" checked={draft.consent} disabled={busy} required onChange={(event) => onDraftChange({ consent: event.currentTarget.checked })} />
            <span>I consent to processing and storing this image <small>(required)</small><small>We will only use your image for the purpose of visualizing our products. Your image will not be shared publicly.</small></span>
          </label>}
          {productTitle && <p className="roman-photo-product">Visualizing {productTitle}</p>}
          {awaitingProduct && <p role="status" className="roman-photo-product">Open the selected blind in Roman to start its preview. You can prepare your photo now.</p>}
          <button type="submit" className="roman-media-button roman-media-primary" disabled={busy || awaitingProduct || !draft.title.trim() || !draft.consent || !readable}>
            {productTitle ? "Visualize in your room" : draft.window ? "Use this window" : "Save window"}
          </button>
          <p className="roman-media-disclaimer">AI preview only. Colour, fit and scale may differ from the finished product.</p>
        </div>
      </div> : <div className="roman-photo-picker" data-dragging={dragging}
        onDragOver={(event) => { if (busy || !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); if (busy) return; const file = event.dataTransfer.files[0]; if (file) selectFile(file); }}>
        <button type="button" className="roman-media-button roman-photo-upload" disabled={busy} onClick={() => picker.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>Upload a room photo
        </button>
        <p>Add a well-lit photo facing your windows, with the whole window in view. There&apos;s no need to remove existing blinds and curtains.</p>
        <small>JPEG, PNG or WebP · up to 25 MB</small>
      </div>}
      {(error || validation) && <p role="alert" className="roman-media-error">{error || validation}</p>}
    </form>
    {windows.length > 0 && <section className="roman-upload-windows" aria-label="Your Windows">
      <h3>Your Windows</h3>
      <ul className="roman-window-thumbnails">{windows.map((photo) => <li key={photo.id}><WindowCard photo={photo} source={() => windowSource(photo)} compact selected={draft.window?.id === photo.id}
        onSelect={() => { setValidation(null); setReadableKey(null); onSelectWindow(photo); }} disabled={busy} /></li>)}</ul>
      <LoadMoreSentinel key={windows.at(-1)?.id} enabled={hasMoreWindows && !busy} onLoadMore={onLoadMoreWindows} />
    </section>}
  </VisualizationDialog>;
}
