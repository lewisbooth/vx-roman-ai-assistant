import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ConversationSnapshot } from "../../../shared/conversation";
import { activeProduct } from "../../../shared/active-product";
import { isCustomerMediaIntent, windowTitle, type MediaPart, type VisualizationJobDto, type WindowPhotoDto } from "../../../shared/visualizations";
import { imageCanvasForPhoto } from "../../../shared/visualizations/image-canvas";
import { VisualizationViewer } from "../../../shared/visualizations/VisualizationViewer";
import type { ConversationClient } from "../session/types";
import { createGalleryClient } from "./client";
import { UploadModal, type UploadDraft } from "./UploadModal";
import { VisualizationGallery } from "./VisualizationGallery";
import { VisualizationCard } from "./VisualizationCard";
import { WindowCard, WindowCarousel } from "./WindowCard";
import type { ProductGalleryPreview } from "../chat/product-gallery-media";
import type { QuestionPart } from "../../../shared/questions";
import { isCurrentProduct } from "../tools/product-controls";

const emptyDraft = (): UploadDraft => ({file: null, window: null, preview: null, title: "", cleanup: true, consent: false});
type UploadAttempt = {
  requestId: string;
  generationId: string;
  createdAt: string;
  jobId: string | null;
  conversationId: string | null;
  draft: UploadDraft;
  product: {path: string; title: string} | undefined;
  photo: WindowPhotoDto | null;
  progress: number;
  stage: "uploading" | "preparing" | "failed";
  error: string | null;
};

/** Gallery resources survive chat clearing; conversation and media keep separate lifetimes. */
export function useVisualizations({ session, conversation, view, onCustomerIntent, sendMessage, showChat }: {
  session: ConversationClient;
  conversation: ConversationSnapshot | null;
  view: "chat" | "cart" | "gallery";
  onCustomerIntent: () => void;
  sendMessage: (message: string) => Promise<void>;
  showChat: () => void;
}) {
  const client = useMemo(() => createGalleryClient(session), [session]);
  const gallery = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [modal, setModal] = useState(false);
  const [modalProduct, setModalProduct] = useState<{path: string; title: string} | undefined>();
  const [draft, setDraft] = useState<UploadDraft>(emptyDraft);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<UploadAttempt[]>([]);
  const [viewer, setViewer] = useState<VisualizationJobDto | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const currentWindowId = conversation?.current?.selectedWindow?.id ?? null;
  const selectedProductPath = activeProduct(conversation)?.path ?? null;
  const urls = useRef(new Set<string>());
  const mounted = useRef(false);
  const fileVersion = useRef(0);
  const running = useRef(new Set<string>());
  const previousConversation = useRef(conversation?.id);
  const advisorStarted = useRef(new Set<string>());
  const failedProductRead = useRef<string | null>(null);
  const sourceVersion = JSON.stringify(conversation?.messages.flatMap((message) => message.parts.filter((part) => part.type === "media")) ?? []);
  const [loadedReferences, setLoadedReferences] = useState("[]");
  const [referenceError, setReferenceError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    void client.initialize().catch(() => undefined);
    const ownedUrls = urls.current;
    return () => {
      mounted.current = false;
      // StrictMode immediately re-establishes this owner. True removal disposes
      // the client and its URLs after that synchronous lifecycle has finished.
      queueMicrotask(() => {
        if (mounted.current) return;
        // This is an async selection generation counter, not a DOM ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        fileVersion.current++;
        client.dispose();
        for (const url of ownedUrls) URL.revokeObjectURL(url);
        ownedUrls.clear();
      });
    };
  }, [client]);
  useEffect(() => {
    const previous = previousConversation.current;
    previousConversation.current = conversation?.id;
    if (previous && previous !== conversation?.id) {
      setAttempts([]); setModal(false); fileVersion.current++;
      setDraft((current) => {
        if (typeof current.preview === "string" && urls.current.delete(current.preview)) URL.revokeObjectURL(current.preview);
        return emptyDraft();
      });
    }
    if (!conversation?.id) { setSelectedWindow(null); return; }
    void client.initialize().then(() => client.link()).catch(() => undefined);
  }, [client, conversation?.id]);
  useEffect(() => {
    let disposed = false;
    const parts = JSON.parse(sourceVersion) as MediaPart[];
    setReferenceError(null);
    if (parts.length) void Promise.all([client.refresh(), client.loadReferences(parts)]).then(() => {
      if (!disposed) setLoadedReferences(sourceVersion);
    }).catch(() => { if (!disposed) setReferenceError(sourceVersion); });
    else setLoadedReferences(sourceVersion);
    return () => { disposed = true; };
  }, [client, sourceVersion]);
  useEffect(() => {
    if (view !== "gallery") return;
    let disposed = false;
    const parts = JSON.parse(sourceVersion) as MediaPart[];
    void Promise.all([client.refresh(), parts.length ? client.loadReferences(parts) : Promise.resolve()]).then(async () => {
      if (!disposed) { setLoadedReferences(sourceVersion); setReferenceError(null); }
      if (!disposed && selectedProductPath && failedProductRead.current === selectedProductPath) {
        await client.loadProductVisualizations(selectedProductPath);
        if (!disposed) failedProductRead.current = null;
      }
    }).catch(() => { if (!disposed) setReferenceError(sourceVersion); });
    return () => { disposed = true; };
  }, [client, view, sourceVersion, selectedProductPath]);
  useEffect(() => { setSelectedWindow(currentWindowId); }, [currentWindowId]);
  useEffect(() => {
    if (!selectedProductPath) return;
    let disposed = false;
    // Existing previews stay readable when generation is disabled. This
    // optional lookup is independent of model turns and Gallery pagination.
    void client.loadProductVisualizations(selectedProductPath).then(() => {
      if (!disposed) failedProductRead.current = null;
    }).catch(() => { if (!disposed) failedProductRead.current = selectedProductPath; });
    return () => { disposed = true; };
  }, [client, selectedProductPath]);
  useEffect(() => {
    if (viewer && !gallery.loading && !gallery.visualizations.some((job) => job.id === viewer.id)) setViewer(null);
  }, [gallery.loading, gallery.visualizations, viewer]);
  const activity = () => session.noteMediaActivity?.();
  const openUpload = (suggestedTitle?: string | null, product?: {path: string; title: string} | null) => {
    activity();
    setDraftError(null); setMediaError(null);
    if (suggestedTitle) setDraft((current) => ({...current, title: current.title || suggestedTitle}));
    setModalProduct(product === null ? undefined : product ?? activeProduct(session.getSnapshot().conversation));
    setModal(true);
  };
  const release = (value: UploadDraft) => {
    if (typeof value.preview === "string" && urls.current.delete(value.preview)) URL.revokeObjectURL(value.preview);
  };
  const closeUpload = () => {
    fileVersion.current++;
    setModal(false);
    setDraft((value) => {
      if (!attempts.some((attempt) => attempt.draft.file === value.file && value.file)) { release(value); return emptyDraft(); }
      return value;
    });
  };
  const selectForReview = (photo: WindowPhotoDto, preserveProduct = false) => {
    activity(); fileVersion.current++; setDraftError(null);
    setDraft((current) => { if (!attempts.some((attempt) => attempt.draft.file === current.file && current.file)) release(current); return {file: null, window: photo, preview: () => client.windowSource(photo), title: photo.title, cleanup: photo.cleanup, consent: true, width: photo.width, height: photo.height}; });
    setModal(true);
    if (!preserveProduct) setModalProduct(activeProduct(session.getSnapshot().conversation));
  };
  const selectFile = async (file: File) => {
    activity(); const version = ++fileVersion.current;
    let url: string | undefined;
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo.");
      if (!file.size || file.size > 25 * 1024 * 1024) throw new Error("Choose a photo no larger than 25 MB.");
      url = URL.createObjectURL(file); urls.current.add(url);
      const image = new Image(); image.src = url; await image.decode();
      const canvas = imageCanvasForPhoto(image.naturalWidth, image.naturalHeight);
      if (!mounted.current || version !== fileVersion.current) { if (urls.current.delete(url)) URL.revokeObjectURL(url); return; }
      setDraftError(null);
      setDraft((current) => {
        if (!attempts.some((attempt) => attempt.draft.file === current.file && current.file)) release(current);
        return {...current, file, window: null, preview: url!, width: canvas.width, height: canvas.height};
      });
    } catch (error) {
      if (url && urls.current.delete(url)) URL.revokeObjectURL(url);
      if (!mounted.current || version !== fileVersion.current) return;
      setDraftError(error instanceof Error ? error.message : "Choose a readable room photo.");
      setDraft((current) => { release(current); return {...current, file: null, window: null, preview: null, consent: false}; });
    }
  };
  const changeDraft = (patch: Partial<UploadDraft>) => {
    setDraft((current) => {
      if (patch.preview === null && !attempts.some((attempt) => attempt.draft.file === current.file && current.file)) release(current);
      return {...current, ...patch};
    });
  };
  const patchAttempt = (id: string, patch: Partial<UploadAttempt>) => {
    if (mounted.current) setAttempts((values) => values.map((item) => item.requestId === id ? {...item, ...patch} : item));
  };
  const execute = async (attempt: UploadAttempt, recover = false) => {
    if (running.current.has(attempt.requestId)) return;
    running.current.add(attempt.requestId);
    patchAttempt(attempt.requestId, {stage: attempt.photo ? "preparing" : "uploading", error: null});
    try {
      const conversationId = attempt.conversationId ?? (await session.ensureMediaConversation()).conversationId;
      patchAttempt(attempt.requestId, {conversationId});
      const continuing = () => session.getSnapshot().conversation?.id === conversationId && session.getSnapshot().conversation?.status === "active";
      if (!continuing()) { release(attempt.draft); return; }
      let photo = attempt.photo;
      if (!photo && recover) photo = await client.recoverUpload(attempt.requestId);
      if (!photo && attempt.draft.file) photo = await client.upload({file: attempt.draft.file, title: attempt.draft.title, cleanup: attempt.draft.cleanup, requestId: attempt.requestId}, (progress) => patchAttempt(attempt.requestId, {progress}));
      if (!photo) throw new Error("Choose a saved window or upload a room photo.");
      if (!continuing()) { release(attempt.draft); return; }
      if (photo.title !== attempt.draft.title) photo = await client.rename(photo, attempt.draft.title);
      if (!continuing()) { release(attempt.draft); return; }
      patchAttempt(attempt.requestId, {photo, stage: "preparing", progress: 100});
      if (attempt.product) {
        const recovered = recover ? await client.recoverStart(attempt.generationId) : null;
        if (recovered) patchAttempt(attempt.requestId, {jobId: recovered.id});
        else if (continuing()) {
          if (activeProduct(session.getSnapshot().conversation)?.path !== attempt.product.path || !isCurrentProduct(attempt.product.path))
            throw new Error("Return to the blind selected for this photo request before starting its preview.");
          await client.start(photo, attempt.product.path, attempt.draft.cleanup, attempt.generationId, (job) => patchAttempt(attempt.requestId, {jobId: job.id}));
        }
      } else {
        // A completed upload already selects the window and refreshes context.
        // Existing windows and recovered uploads still need that context when
        // the current conversation has not received the selection yet.
        if (session.getSnapshot().conversation?.current?.selectedWindow?.id !== photo.id) await client.select(photo);
        if (mounted.current && continuing()) {
          setSelectedWindow(photo.id);
          if (!advisorStarted.current.has(attempt.requestId)) {
            advisorStarted.current.add(attempt.requestId);
            await sendMessage(`I'd like to choose a blind for my saved window “${photo.title}”, then visualize it in my room.`);
          }
        }
      }
      release(attempt.draft);
      if (mounted.current) {
        setAttempts((values) => values.filter((item) => item.requestId !== attempt.requestId));
        // A late acknowledgement still releases its file, but cannot clear a
        // new chat's review of the same saved window.
        setDraft((current) => continuing() && ((attempt.draft.file && current.file === attempt.draft.file) || (attempt.draft.window && current.window?.id === attempt.draft.window.id)) ? emptyDraft() : current);
      }
    } catch (error) {
      patchAttempt(attempt.requestId, {stage: "failed", error: error instanceof Error ? error.message : "Your image request could not finish. Please check its status before trying again."});
    } finally { running.current.delete(attempt.requestId); }
  };
  const submit = (input: UploadDraft) => {
    const previous = attempts.find((attempt) => !!input.file && attempt.draft.file === input.file || !!input.window && attempt.draft.window?.id === input.window.id);
    if (previous) {
      if (previous.draft.title !== input.title || previous.draft.cleanup !== input.cleanup) { setDraftError("Check the status of your previous image request before changing its details."); return; }
      setModal(false); void execute(previous, true); return;
    }
    if (modalProduct && (activeProduct(session.getSnapshot().conversation)?.path !== modalProduct.path || !isCurrentProduct(modalProduct.path))) {
      setDraftError("Return to the blind selected for this photo request before visualizing, or close this upload to choose another blind."); return;
    }
    if (attempts.length >= 4) { setDraftError("Wait for one of your photo requests to finish before adding another."); return; }
    activity();
    const attempt: UploadAttempt = {requestId: crypto.randomUUID(), generationId: crypto.randomUUID(), createdAt: new Date().toISOString(), jobId: null, conversationId: session.getSnapshot().conversation?.id ?? null, draft: {...input, title: windowTitle(input.title)}, product: modalProduct, photo: input.window, progress: 0, stage: input.file ? "uploading" : "preparing", error: null};
    setModal(false); onCustomerIntent(); showChat(); setAttempts((values) => [...values, attempt]);
    void execute(attempt);
  };
  const chooseWindow = async (photo: WindowPhotoDto) => {
    activity(); setMediaError(null);
    const conversationId = session.getSnapshot().conversation?.id;
    try {
      await client.select(photo);
      if (session.getSnapshot().conversation?.id !== conversationId || session.getSnapshot().conversation?.status !== "active") return;
      setSelectedWindow(photo.id);
      await sendMessage(`Select “${photo.title}” as my saved window photo. This selection alone is not a request for a new preview.`);
    }
    catch (error) { setMediaError(error instanceof Error ? error.message : "Your window could not be selected."); }
  };
  const selectAnswerWindow = async (question: QuestionPart, answer: string) => {
    const messages = session.getSnapshot().conversation?.messages ?? [];
    const message = messages.find((item) => item.parts.some((part) => part.type === "question" && part.invocationId === question.invocationId));
    const ids = message?.parts.flatMap((part) => part.type === "media" && part.kind === "windows" ? part.windowIds : []) ?? [];
    const matches = gallery.windows.filter((photo) => ids.includes(photo.id) && photo.title === answer);
    if (matches.length === 1) { await client.select(matches[0]); setSelectedWindow(matches[0].id); }
  };
  const checkJob = async (job: VisualizationJobDto) => {
    activity(); setMediaError(null);
    try { await client.check(job); }
    catch (error) { setMediaError(error instanceof Error ? error.message : "Your visualization status could not be checked."); }
  };
  const openViewer = (job: VisualizationJobDto) => { activity(); setViewer(job); };
  const productPreviews = useMemo<ProductGalleryPreview[]>(() => gallery.visualizations
    .filter((job) => job.productPath === selectedProductPath && job.status === "completed" && job.resultAvailable)
    .map((job) => ({kind: "visualization", id: `visualization:${job.id}`, alt: `AI preview for ${job.windowTitle}`, width: job.width, height: job.height, sourceKey: `${job.id}:result`, source: () => client.resultSource(job), onOpen: () => { session.noteMediaActivity?.(); setViewer(job); }})), [client, gallery.visualizations, selectedProductPath, session]);
  const viewerMedia = useMemo(() => viewer ? {before: () => client.beforeSource(viewer), after: () => client.resultSource(viewer), resultAsset: () => client.resultAsset(viewer)} : null, [client, viewer]);
  const renderMedia = (part: MediaPart): ReactNode => {
    const missing = (label: string) => referenceError === sourceVersion ? `${label} could not load. Open Gallery to retry.` : loadedReferences !== sourceVersion ? `Loading your ${label.toLowerCase()}…` : `${label} removed.`;
    if (part.kind === "renamed" || part.kind === "outcome") return null;
    if (part.kind === "upload") return <button type="button" className="roman-media-button" onClick={() => openUpload(part.suggestedTitle)}>Upload a room photo</button>;
    if (part.kind === "windows") {
      const windows = part.windowIds.flatMap((id) => gallery.windows.find((photo) => photo.id === id) ?? []);
      return windows.length ? <WindowCarousel windows={windows} windowSource={client.windowSource} onSelect={(photo) => { void chooseWindow(photo); }} /> : <p className="roman-inline-event">{missing("Window photos")}</p>;
    }
    if (part.kind === "window") {
      const photo = gallery.windows.find((item) => item.id === part.windowId);
      return photo ? <div className="roman-inline-window"><WindowCard photo={photo} source={() => client.windowSource(photo)} onSelect={() => selectForReview(photo)} /></div> : <p className="roman-inline-event">{missing("Window photo")}</p>;
    }
    const job = gallery.visualizations.find((item) => item.id === part.jobId);
    return job ? <VisualizationCard job={job} source={() => client.beforeSource(job)} result={() => client.resultSource(job)} onOpen={openViewer} onCheck={(item) => { void checkJob(item); }}
      onRetry={(item) => { const photo = gallery.windows.find((row) => row.id === item.windowId); if (photo) selectForReview(photo); }} /> : <p className="roman-inline-event">{missing("Visualization")}</p>;
  };
  return {
    enabled: gallery.enabled, openUpload, renderMedia, productPreviews, selectAnswerWindow,
    galleryView: <VisualizationGallery {...gallery} error={mediaError ?? gallery.error} selectedWindowId={selectedWindow} windowSource={client.windowSource} resultSource={client.resultSource}
      onUpload={openUpload} onSelectWindow={selectForReview}
      onRenameWindow={async (photo, title) => { activity(); await client.rename(photo, title); }}
      onDeleteWindow={async (photo) => { activity(); await client.deleteWindow(photo); if (selectedWindow === photo.id) setSelectedWindow(null); if (viewer?.windowId === photo.id) setViewer(null); }}
      onOpenVisualization={openViewer} onDeleteVisualization={async (job) => { activity(); await client.deleteVisualization(job); if (viewer?.id === job.id) setViewer(null); }}
      onRetry={(job) => { const photo = gallery.windows.find((item) => item.id === job.windowId); if (photo) selectForReview(photo); }}
      onCheck={(job) => { void checkJob(job); }}
      hasMoreWindows={!!gallery.nextWindowsCursor} hasMoreVisualizations={!!gallery.nextVisualizationsCursor}
      onLoadMoreWindows={() => { void client.loadWindows().catch(() => undefined); }} onLoadMoreVisualizations={() => { void client.loadVisualizations().catch(() => undefined); }} />,
    localCards: [mediaError && <p key="media-error" role="alert" className="roman-media-error">{mediaError}</p>, ...attempts.map((attempt) => {
      if (attempt.jobId && conversation?.messages.some((message) => message.parts.some((part) => part.type === "media" && part.kind === "visualization" && part.jobId === attempt.jobId))) return null;
      const accepted = gallery.visualizations.find((item) => item.id === attempt.jobId);
      const job: VisualizationJobDto = {id: attempt.requestId, windowId: attempt.photo?.id ?? attempt.requestId, windowTitle: attempt.draft.title, productPath: attempt.product?.path ?? "", productTitle: attempt.product?.title ?? "Your room photo", status: attempt.stage === "failed" ? "unknown" : "awaiting_product", width: attempt.photo?.width ?? attempt.draft.width ?? 1024, height: attempt.photo?.height ?? attempt.draft.height ?? 1024, createdAt: attempt.createdAt, startedAt: null, completedAt: null, error: attempt.error, resultAvailable: false};
      return <div key={attempt.requestId} className="roman-local-media"><VisualizationCard job={accepted ?? job} source={attempt.draft.preview} uploadProgress={attempt.stage === "uploading" ? attempt.progress : undefined} onCheck={() => { void execute(attempt, true); }} /></div>;
    })],
    dialogs: <>{modal && <UploadModal draft={draft} windows={gallery.windows} windowSource={client.windowSource} productTitle={modalProduct?.title}
      awaitingProduct={!!modalProduct && (selectedProductPath !== modalProduct.path || !isCurrentProduct(modalProduct.path))}
      onDraftChange={changeDraft} onFile={(file) => { void selectFile(file); }} onSelectWindow={(photo) => selectForReview(photo, true)} onSubmit={submit} onClose={closeUpload}
      error={draftError} hasMoreWindows={!!gallery.nextWindowsCursor} onLoadMoreWindows={() => { void client.loadWindows().catch(() => undefined); }} />}
      {viewer && viewerMedia && <VisualizationViewer key={viewer.id} title={`${viewer.windowTitle} · ${viewer.productTitle}`} {...viewerMedia} width={viewer.width} height={viewer.height} filename={`roman-${viewer.id}.jpg`} onClose={() => setViewer(null)} />}</>,
  };
}

export const committedMediaIntent = (conversation: ConversationSnapshot | null) => !!conversation?.messages.some((message) => message.parts.some((part) => part.type === "media" && isCustomerMediaIntent(part)));
