import "../../shared/visualizations/image-comparison.css";
import "../../shared/visualizations/visualization-dialog.css";
import { useEffect, useState } from "react";
import type { MediaPart } from "../../shared/visualizations";
import { VisualizationViewer } from "../../shared/visualizations/VisualizationViewer";
import type { VisualizationAsset } from "../../shared/visualizations/save-visualization";
import type {
  ConversationInspection,
  InspectedVisualization,
} from "./contracts";

function mediaUrl(
  conversationId: string,
  type: "window" | "before" | "result",
  id: string,
) {
  return `/app/conversations/${encodeURIComponent(conversationId)}/media/${type}/${encodeURIComponent(id)}`;
}

function InspectedViewer({
  job,
  conversationId,
  onClose,
}: {
  job: InspectedVisualization;
  conversationId: string;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<{
    key: string;
    before: Promise<string | null>;
    after: Promise<string | null>;
    result: Promise<VisualizationAsset | null>;
  } | null>(null);
  const key = `${conversationId}:${job.id}`;
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    const load = async (
      type: "before" | "result",
    ): Promise<VisualizationAsset | null> => {
      try {
        const response = await fetch(mediaUrl(conversationId, type, job.id), {
          signal: abort.signal,
          credentials: "same-origin",
          cache: "no-store",
        });
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("image/")
        )
          return null;
        const blob = await response.blob();
        if (abort.signal.aborted) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return { url, blob };
      } catch {
        return null;
      }
    };
    const before = load("before"),
      result = load("result");
    setAssets({
      key,
      before: before.then((asset) => asset?.url ?? null),
      after: result.then((asset) => asset?.url ?? null),
      result,
    });
    return () => {
      abort.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [conversationId, job.id, key]);
  if (!assets || assets.key !== key) return null;
  return (
    <VisualizationViewer
      title={`${job.windowTitle} · ${job.productTitle}`}
      before={assets.before}
      after={assets.after}
      width={job.width}
      height={job.height}
      resultAsset={assets.result}
      filename={`roman-${job.id.slice(0, 8)}.jpg`}
      onClose={onClose}
    />
  );
}

function RemoveImage({
  conversationId,
  type,
  id,
  onRemoved,
}: {
  conversationId: string;
  type: "window" | "result";
  id: string;
  onRemoved?: () => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(mediaUrl(conversationId, type, id), {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok && response.status !== 404) throw new Error();
      onRemoved?.();
    } catch {
      setError("Unable to delete this image. Please try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      <s-button
        disabled={pending}
        loading={pending}
        onClick={() => {
          void remove();
        }}
      >
        {type === "window"
          ? "Delete photo and visualizations"
          : "Delete visualization"}
      </s-button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function InspectedMedia({
  part,
  media,
  conversationId,
  onRemoved,
}: {
  part: MediaPart;
  media: Pick<ConversationInspection, "windows" | "visualizations">;
  conversationId: string;
  onRemoved?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  if (part.kind === "renamed")
    return (
      <p>
        Renamed window: {part.previousTitle} → {part.title}
      </p>
    );
  if (part.kind === "upload")
    return (
      <p>
        Photo upload offered
        {part.suggestedTitle ? ` for ${part.suggestedTitle}` : ""}.
      </p>
    );
  if (part.kind === "windows")
    return (
      <div>
        <p className="text-sm font-semibold">Window photo choices</p>
        <ul className="list-inside list-disc text-sm">
          {part.windowIds.map((id) => (
            <li key={id}>
              {media.windows.find((window) => window.id === id)?.title ??
                "Unavailable window photo"}
            </li>
          ))}
        </ul>
      </div>
    );
  if (part.kind === "outcome") return <p>Visualization {part.status}.</p>;
  if (part.kind === "window") {
    const photo = media.windows.find((window) => window.id === part.windowId);
    return (
      <div className="max-w-sm space-y-2">
        <p className="font-semibold">
          Window photo: {photo?.title ?? part.title}
        </p>
        {photo?.available ? (
          <>
            <img
              src={mediaUrl(conversationId, "window", photo.id)}
              alt={photo.title}
              className="max-h-64 w-full rounded border border-gray-200 object-contain"
              loading="lazy"
              decoding="async"
            />
            {photo.deletable && (
              <RemoveImage
                conversationId={conversationId}
                type="window"
                id={photo.id}
                onRemoved={onRemoved}
              />
            )}
          </>
        ) : (
          <p className="text-sm text-gray-600">Photo deleted or unavailable.</p>
        )}
      </div>
    );
  }
  const job = media.visualizations.find((job) => job.id === part.jobId);
  return (
    <div className="max-w-sm space-y-2">
      <p className="font-semibold">
        {job ? `${job.windowTitle} · ${job.productTitle}` : "Visualization"}
      </p>
      {job?.available ? (
        <>
          <button
            type="button"
            onClick={() => setOpened(true)}
            className="block w-full overflow-hidden rounded border border-gray-200 text-left"
          >
            <img
              src={mediaUrl(conversationId, "result", job.id)}
              alt={`${job.productTitle} in ${job.windowTitle}`}
              className="max-h-64 w-full object-contain"
              loading="lazy"
              decoding="async"
            />
            <span className="block p-2 text-sm underline">
              Compare and download
            </span>
          </button>
          <RemoveImage
            conversationId={conversationId}
            type="result"
            id={job.id}
            onRemoved={onRemoved}
          />
        </>
      ) : (
        <p className="text-sm text-gray-600">
          {job?.deleted
            ? "Visualization deleted."
            : job
              ? job.error || `Visualization ${job.status.replaceAll("_", " ")}.`
              : "Visualization unavailable."}
        </p>
      )}
      {opened && job?.available && (
        <InspectedViewer
          job={job}
          conversationId={conversationId}
          onClose={() => setOpened(false)}
        />
      )}
    </div>
  );
}
