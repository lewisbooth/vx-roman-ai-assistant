import { useEffect, useRef, useState } from "react";
import { ImageComparison, type ImageResolver } from "./ImageComparison";
import { VisualizationDialog } from "./VisualizationDialog";
import { saveVisualization, type VisualizationAsset } from "./save-visualization";

/** Customer and admin share one result viewer; the caller owns authorized media. */
export function VisualizationViewer({ title, before, after, width, height, resultAsset, filename, onClose }: {
  title: string;
  before: ImageResolver;
  after: ImageResolver;
  width: number;
  height: number;
  resultAsset: Promise<VisualizationAsset | null> | (() => Promise<VisualizationAsset | null>);
  filename: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ request: typeof resultAsset; asset: VisualizationAsset } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setLoaded(null); setError(null);
    let disposed = false;
    let held: VisualizationAsset | null = null;
    void (typeof resultAsset === "function" ? resultAsset() : resultAsset).then((value) => {
      if (disposed) { value?.release?.(); return; }
      held = value;
      setLoaded(value ? { request: resultAsset, asset: value } : null);
      if (!value) setError("The image is unavailable. Please close and try again.");
    }).catch(() => { if (!disposed) setError("The image is unavailable. Please close and try again."); });
    return () => { disposed = true; mounted.current = false; held?.release?.(); };
  }, [resultAsset]);
  const asset = loaded?.request === resultAsset ? loaded.asset : null;
  const download = async () => {
    if (!asset || saving) return;
    setSaving(true); setError(null);
    try { await saveVisualization(asset, filename); }
    catch { if (mounted.current) setError("Unable to save this image. Please try again."); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <VisualizationDialog title={title} fullscreen onClose={onClose}>
    <div className="roman-visualization-viewer-image"><ImageComparison before={before} after={after} width={width} height={height} /></div>
    <footer className="roman-visualization-viewer-footer">
      <p>AI preview only. Colour, fit and scale may differ from the finished product.</p>
      <button type="button" className="roman-visualization-save" disabled={!asset || saving} onClick={() => { void download(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3" /></svg>
        <span className="roman-visualization-save-desktop">Download</span><span className="roman-visualization-save-mobile">Save Image</span>
      </button>
      {error && <p role="status" className="roman-visualization-viewer-error">{error}</p>}
    </footer>
  </VisualizationDialog>;
}
