export interface VisualizationAsset {
  url: string;
  blob: Blob;
}

/** Call with already loaded bytes during the customer's click for native sharing. */
export async function saveVisualization(asset: VisualizationAsset, filename: string, mobile = window.matchMedia("(max-width: 767px)").matches): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([asset.blob], filename, { type: asset.blob.type || "image/jpeg" });
  let canShare = false;
  try { canShare = mobile && typeof navigator.share === "function" && !!navigator.canShare?.({ files: [file] }); }
  catch { /* Capability rejection falls through to ordinary download. */ }
  if (canShare) {
    try { await navigator.share({ files: [file] }); return "shared"; }
    catch (error) {
      // Dismissing the native sheet is an intentional end to this action.
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  const link = document.createElement("a");
  link.href = asset.url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); }
  return "downloaded";
}
