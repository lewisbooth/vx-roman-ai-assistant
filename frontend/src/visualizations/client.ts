import { GALLERY_STORAGE_KEY, isMediaId, isWindowPhotoDto as photo, isVisualizationJobDto as job, type GalleryCredential, type GallerySnapshot, type MediaPart, type VisualizationJobDto, type WindowPhotoDto } from "../../../shared/visualizations";
import type { ConversationClient } from "../session/types";

type State = GallerySnapshot & { loading: boolean; error: string | null; persistent: boolean };
const STORAGE_KEY = GALLERY_STORAGE_KEY;
const pending = (job: VisualizationJobDto) => ["awaiting_product", "preparing_assets", "generating", "saving"].includes(job.status);
const merge = <T extends { id: string }>(previous: readonly T[], incoming: readonly T[]) => [...new Map([...previous, ...incoming].map((item) => [item.id, item])).values()];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function credential(value: unknown): value is GalleryCredential {
  if (!record(value) || !isMediaId(value.ownerId) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.apiBaseUrl !== "string") return false;
  try { const url = new URL(value.apiBaseUrl); return url.protocol === "https:" && url.pathname === "/api/gallery" && !url.search && !url.hash && !url.username && !url.password; } catch { return false; }
}
function snapshot(value: unknown): value is GallerySnapshot {
  const ids = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every(isMediaId) && new Set(value).size === value.length;
  return record(value) && typeof value.enabled === "boolean" && ids(value.liveWindowIds, 100) && ids(value.liveVisualizationIds, 500) && Array.isArray(value.windows) && value.windows.length <= 24 && value.windows.every(photo) && Array.isArray(value.visualizations) && value.visualizations.length <= 24 && value.visualizations.every(job) && [value.nextWindowsCursor, value.nextVisualizationsCursor].every((cursor) => cursor === null || typeof cursor === "string" && cursor.length <= 300);
}
export function createGalleryClient(session: ConversationClient) {
  let state: State = { enabled: false, liveWindowIds: [], liveVisualizationIds: [], windows: [], visualizations: [], nextWindowsCursor: null, nextVisualizationsCursor: null, loading: false, error: null, persistent: true };
  let access: GalleryCredential | null = null;
  let boot: Promise<void> | undefined;
  let disposed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const preparing = new Set<string>();
  const failedPreparations = new Set<string>();
  const uncertainUploads = new Set<string>();
  const assets = new Map<string, { url: string; blob: Blob }>();
  const assetRequests = new Map<string, { promise: Promise<{ url: string; blob: Blob } | null>; controller: AbortController }>();
  let timer: number | undefined;
  let refreshing: Promise<void> | undefined;
  const clientId = crypto.randomUUID();
  const update = (patch: Partial<State>) => { if (!disposed) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); } };
  function saved() { try { const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); return credential(value) ? value : null; } catch { update({ persistent: false }); return null; } }
  function persist(value: GalleryCredential) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { update({ persistent: false }); } }
  async function readJson(url: string, init: RequestInit = {}) {
    if (disposed) throw new Error("Roman has been removed.");
    const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) });
    if (disposed) throw new Error("Roman has been removed.");
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(record(value) && record(value.error) && typeof value.error.message === "string" ? value.error.message : "Your image request could not be completed.");
    return value;
  }
  async function bootstrap() {
    const restore = saved();
    const url = new URL("/apps/roman/gallery", location.origin);
    url.searchParams.set("storefront_origin", location.origin);
    const value = await readJson(url.href, { method: "POST", mode: "same-origin", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(restore ? { ownerId: restore.ownerId, token: restore.token } : {}) });
    if (disposed) throw new Error("Roman has been removed.");
    if (!record(value) || !credential(value.credential) || !snapshot(value.gallery)) throw new Error("Roman received an invalid gallery response.");
    access = value.credential;
    persist(access);
    update({ ...value.gallery, loading: false, error: null });
    if (session.getSnapshot().conversation) await link();
    schedule();
  }
  async function initialize() {
    if (disposed) throw new Error("Roman has been removed.");
    if (access) return;
    if (!boot) {
      update({ loading: true });
      const operation = async () => { await bootstrap(); };
      const locked = async () => { if (navigator.locks) await navigator.locks.request(STORAGE_KEY, operation); else await operation(); };
      boot = locked().catch((error: unknown) => { update({ loading: false, error: error instanceof Error ? error.message : "Your gallery could not be loaded." }); throw error; }).finally(() => { boot = undefined; });
    }
    return boot;
  }
  async function api(operation: string, body?: unknown) {
    if (disposed) throw new Error("Roman has been removed.");
    if (!access) await initialize();
    if (disposed) throw new Error("Roman has been removed.");
    if (!access) throw new Error("Your gallery is unavailable.");
    return readJson(`${access.apiBaseUrl}/${access.ownerId}/${operation}`, { method: body === undefined ? "GET" : "POST", mode: "cors", credentials: "omit", headers: { Authorization: `Bearer ${access.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function link() {
    if (disposed) throw new Error("Roman has been removed.");
    const conversation = await session.ensureMediaConversation();
    if (disposed) throw new Error("Roman has been removed.");
    await api("link", conversation);
    return conversation;
  }
  function acceptJob(value: unknown) {
    if (!job(value)) throw new Error("Roman received an invalid visualization status.");
    update({ visualizations: merge(state.visualizations, [value]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    schedule();
    return value;
  }
  function schedule() {
    window.clearTimeout(timer);
    if (disposed) return;
    if (state.enabled) for (const item of state.visualizations) if (item.status === "awaiting_product" && !preparing.has(item.id) && !failedPreparations.has(item.id)) void prepare(item);
    if (state.visualizations.some(pending)) timer = window.setTimeout(() => { void refresh().catch(() => undefined); }, document.hidden ? 10_000 : 2000);
  }
  async function prepare(item: VisualizationJobDto) {
    if (!state.enabled || disposed) return;
    preparing.add(item.id);
    try {
      const value = await api("claim", { jobId: item.id, clientId });
      if (!record(value) || !record(value.claim) || typeof value.claim.token !== "string" || value.claim.productPath !== item.productPath) return;
      const token = value.claim.token;
      try {
        const preparation = await session.prepareVisualizationProduct(item.productPath, AbortSignal.any([lifetime.signal, AbortSignal.timeout(40_000)]));
        acceptJob(await api("prepare", { jobId: item.id, claimToken: token, preparation }));
      } catch (error) {
        // A lost acknowledgement is a read, never another generation request.
        const status = await api(`job?id=${item.id}`);
        if (job(status) && status.status !== "awaiting_product") acceptJob(status);
        else { failedPreparations.add(item.id); acceptJob(await api("prepare", { jobId: item.id, claimToken: token, error: error instanceof Error ? error.message.slice(0, 300) : "Product preparation failed." })); }
      }
    } catch (error) { failedPreparations.add(item.id); update({ error: error instanceof Error ? error.message : "The preview could not be prepared." }); }
    finally { preparing.delete(item.id); }
  }
  async function refresh(windowsCursor?: string, jobsCursor?: string) {
    if (refreshing && !windowsCursor && !jobsCursor) return refreshing;
    const operation = async () => {
      await initialize();
      const query = new URLSearchParams();
      if (windowsCursor) query.set("windowsCursor", windowsCursor);
      if (jobsCursor) query.set("jobsCursor", jobsCursor);
      const value = await api(`list${query.size ? `?${query}` : ""}`);
      if (!snapshot(value)) throw new Error("Roman received an invalid gallery response.");
      const windowIds = new Set(value.liveWindowIds), jobIds = new Set(value.liveVisualizationIds);
      invalidate([...state.windows.filter((item) => !windowIds.has(item.id)), ...state.visualizations.filter((item) => !jobIds.has(item.id))].map((item) => item.id));
      update({ ...value, windows: merge(state.windows, value.windows).filter((item) => windowIds.has(item.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), visualizations: merge(state.visualizations, value.visualizations).filter((item) => jobIds.has(item.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), ...(windowsCursor ? { nextVisualizationsCursor: state.nextVisualizationsCursor } : {}), ...(jobsCursor ? { nextWindowsCursor: state.nextWindowsCursor } : {}), error: null });
      schedule();
    };
    const promise = operation().catch((error: unknown) => { update({ error: error instanceof Error ? error.message : "Your gallery could not be loaded." }); schedule(); throw error; }).finally(() => { if (refreshing === promise) refreshing = undefined; });
    if (!windowsCursor && !jobsCursor) refreshing = promise;
    return promise;
  }
  const invalidate = (ids: string[]) => {
    for (const [key, request] of assetRequests) if (ids.some((id) => key.endsWith(`/${id}`))) request.controller.abort();
    for (const [key, asset] of assets) if (ids.some((id) => key.endsWith(`/${id}`))) { URL.revokeObjectURL(asset.url); assets.delete(key); }
  };
  async function asset(type: "window" | "before" | "result", id: string) {
    await initialize();
    if (!isMediaId(id) || !access || disposed) return null;
    const key = `${type}/${id}`;
    const cached = assets.get(key);
    if (cached) { assets.delete(key); assets.set(key, cached); return cached; }
    const existing = assetRequests.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const request = (async () => {
      const response = await fetch(`${access!.apiBaseUrl}/${access!.ownerId}/media/${key}`, { credentials: "omit", mode: "cors", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${access!.token}` }, signal: AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) return null;
      const blob = await response.blob();
      if (disposed || controller.signal.aborted || blob.size > 10 * 1024 * 1024) return null;
      const value = { url: URL.createObjectURL(blob), blob };
      assets.set(key, value);
      let total = [...assets.values()].reduce((sum, item) => sum + item.blob.size, 0);
      for (const [oldKey, old] of assets) { if (assets.size <= 12 && total <= 32 * 1024 * 1024) break; if (oldKey === key) continue; total -= old.blob.size; URL.revokeObjectURL(old.url); assets.delete(oldKey); }
      return value;
    })().catch(() => null).finally(() => assetRequests.delete(key));
    assetRequests.set(key, { promise: request, controller });
    return request;
  }
  function onVisibility() { if (!document.hidden && access && state.visualizations.some(pending)) void refresh().catch(() => undefined); }
  document.addEventListener("visibilitychange", onVisibility);
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize, refresh, link,
    async loadReferences(parts: readonly MediaPart[]) {
      const windowIds = [...new Set(parts.flatMap((part) => part.kind === "window" ? [part.windowId] : part.kind === "windows" ? part.windowIds : []))];
      const jobIds = [...new Set(parts.flatMap((part) => part.kind === "visualization" ? [part.jobId] : []))];
      for (let start = 0; start < Math.max(windowIds.length, jobIds.length); start += 24) {
        const requestedWindows = windowIds.slice(start, start + 24), requestedJobs = jobIds.slice(start, start + 24);
        const value = await api("references", { windowIds: requestedWindows, jobIds: requestedJobs });
        if (!record(value) || !Array.isArray(value.windows) || value.windows.length > 24 || !value.windows.every(photo) || !Array.isArray(value.visualizations) || value.visualizations.length > 24 || !value.visualizations.every(job)) throw new Error("Roman received invalid private media references.");
        update({ windows: merge(state.windows.filter((item) => !requestedWindows.includes(item.id)), value.windows).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), visualizations: merge(state.visualizations.filter((item) => !requestedJobs.includes(item.id)), value.visualizations).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      }
      schedule();
    },
    windowSource: (item: WindowPhotoDto) => asset("window", item.id).then((value) => value?.url ?? null),
    resultSource: (item: VisualizationJobDto) => asset("result", item.id).then((value) => value?.url ?? null),
    beforeSource: (item: VisualizationJobDto) => asset("before", item.id).then((value) => value?.url ?? null),
    resultAsset: (item: VisualizationJobDto) => asset("result", item.id),
    async loadWindows() { if (state.nextWindowsCursor) await refresh(state.nextWindowsCursor); },
    async loadVisualizations() { if (state.nextVisualizationsCursor) await refresh(undefined, state.nextVisualizationsCursor); },
    async select(item: WindowPhotoDto) { const conversation = await link(); const value = await api("select", { ...conversation, windowId: item.id }); if (!photo(value)) throw new Error("The window could not be selected."); await session.refreshMediaContext(); return value; },
    async rename(item: WindowPhotoDto, title: string) { const value = await api("rename", { windowId: item.id, title, revision: item.revision }); if (!photo(value)) throw new Error("The name could not be saved."); update({ windows: state.windows.map((row) => row.id === value.id ? value : row) }); await session.refreshMediaContext(); return value; },
    async deleteWindow(item: WindowPhotoDto) { await api("delete-window", { windowId: item.id }); const dependent = state.visualizations.filter((row) => row.windowId === item.id).map((row) => row.id); invalidate([item.id, ...dependent]); update({ windows: state.windows.filter((row) => row.id !== item.id), visualizations: state.visualizations.filter((row) => row.windowId !== item.id) }); await session.refreshMediaContext(); },
    async deleteVisualization(item: VisualizationJobDto) { await api("delete-job", { jobId: item.id }); invalidate([item.id]); update({ visualizations: state.visualizations.filter((row) => row.id !== item.id) }); },
    async start(item: WindowPhotoDto, productPath: string, cleanup = item.cleanup, requestId: string = crypto.randomUUID(), onAccepted?: (job: VisualizationJobDto) => void) {
      const conversation = await link();
      let result;
      try { result = await api("start", { ...conversation, requestId, windowId: item.id, productPath, cleanup }); }
      catch (error) { const status = await api(`request-status?requestId=${requestId}`); if (!record(status) || !job(status.job)) throw error; result = status.job; }
      const accepted = acceptJob(result);
      onAccepted?.(accepted);
      await session.refreshMediaContext();
      return accepted;
    },
    async check(item: VisualizationJobDto) { failedPreparations.delete(item.id); return acceptJob(await api(`job?id=${item.id}`)); },
    async recoverStart(requestId: string) {
      const value = await api(`request-status?requestId=${requestId}`);
      if (!record(value) || !job(value.job)) return null;
      const accepted = acceptJob(value.job);
      await session.refreshMediaContext();
      return accepted;
    },
    async recoverUpload(requestId: string) {
      const value = await api(`upload-status?requestId=${requestId}`);
      if (!record(value)) throw new Error("The upload status could not be checked.");
      if (photo(value.window)) { uncertainUploads.delete(requestId); update({ windows: merge(state.windows, [value.window]) }); return value.window; }
      if (value.status === "saving") throw new Error("Your photo is still being saved. Check its status in a moment.");
      return null;
    },
    async upload(input: { file: File; title: string; cleanup: boolean; requestId: string }, onProgress: (percentage: number) => void) {
      const conversation = await link();
      if (uncertainUploads.has(input.requestId)) {
        const status = await api(`upload-status?requestId=${input.requestId}`);
        if (record(status) && photo(status.window)) { update({ windows: merge(state.windows, [status.window]) }); uncertainUploads.delete(input.requestId); return status.window; }
        if (!record(status) || status.status !== "not_found") throw new Error("This upload has not finished. Check its status before uploading again.");
      }
      const form = new FormData();
      Object.entries({ ...conversation, requestId: input.requestId, title: input.title, cleanup: String(input.cleanup), consent: "true" }).forEach(([key, value]) => form.set(key, value));
      form.set("photo", input.file);
      let value: unknown;
      try {
        value = await new Promise<unknown>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `${access!.apiBaseUrl}/${access!.ownerId}/upload`);
          xhr.setRequestHeader("Authorization", `Bearer ${access!.token}`);
          xhr.timeout = 30_000;
          xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total * 100); };
          const abort = () => xhr.abort();
          lifetime.signal.addEventListener("abort", abort, { once: true });
          xhr.onloadend = () => lifetime.signal.removeEventListener("abort", abort);
          xhr.onload = () => { try { const body: unknown = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) throw new Error(record(body) && record(body.error) && typeof body.error.message === "string" ? body.error.message : "Your photo could not be saved."); resolve(body); } catch (error) { reject(error); } };
          xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error("Your photo upload was interrupted. Check its status before retrying."));
          xhr.send(form);
        });
      } catch (error) { uncertainUploads.add(input.requestId); const status = await api(`upload-status?requestId=${input.requestId}`); if (!record(status) || !photo(status.window)) throw error; value = status.window; }
      if (!photo(value)) throw new Error("Roman received an invalid saved photo.");
      uncertainUploads.delete(input.requestId);
      update({ windows: merge(state.windows, [value]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
      await session.refreshMediaContext();
      return value;
    },
    dispose() { disposed = true; lifetime.abort(); window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); for (const value of assets.values()) URL.revokeObjectURL(value.url); assets.clear(); listeners.clear(); },
  };
}
export type GalleryClient = ReturnType<typeof createGalleryClient>;
