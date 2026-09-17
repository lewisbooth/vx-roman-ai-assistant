import type { ResponseInputFile } from "openai/resources/responses/responses";
import type { ProductGuide } from "../../shared/product-guides";
import type { CachedGuideSource } from "../conversations/presentation.server";
import { createGuideContext } from "./context.server";

export interface GuideSession extends CachedGuideSource {
  origin: string;
  pageId: string;
  sources: ProductGuide[];
  files: ResponseInputFile[];
}

export const GUIDE_SESSION_TTL_MS = 30 * 60_000;
const maxSessions = 16;
const maxBytes = 32 * 1024 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessions = new Map<string, { value: GuideSession; bytes: number }>();
let storedBytes = 0;

export function clearGuideSession(conversationId: string): void {
  const previous = sessions.get(conversationId);
  if (previous) storedBytes -= previous.bytes;
  sessions.delete(conversationId);
}

function expire(now: number) {
  for (const [id, entry] of sessions)
    if (entry.value.expiresAt <= now) clearGuideSession(id);
}

/** A hit changes eviction priority, never its original expiry or page binding. */
export function readGuideSession(
  conversationId: string,
  origin: string,
  page: { productPath: string; pageId: string } | undefined,
): GuideSession | undefined {
  expire(Date.now());
  const entry = sessions.get(conversationId);
  if (
    !entry ||
    !page ||
    entry.value.origin !== origin ||
    entry.value.productPath !== page.productPath ||
    entry.value.pageId !== page.pageId
  )
    return undefined;
  sessions.delete(conversationId);
  sessions.set(conversationId, entry);
  return entry.value;
}

/** Only successfully persisted guide provenance may populate this process cache. */
export function saveGuideSession(
  conversationId: string,
  session: GuideSession,
): void {
  const now = Date.now();
  expire(now);
  if (
    typeof conversationId !== "string" ||
    !uuid.test(conversationId) ||
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    Object.keys(session).length !== 9 ||
    typeof session.sourceCallId !== "string" ||
    !session.sourceCallId ||
    session.sourceCallId.length > 200 ||
    typeof session.sourceAssistantId !== "string" ||
    !uuid.test(session.sourceAssistantId) ||
    typeof session.pageId !== "string" ||
    !uuid.test(session.pageId) ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= now ||
    session.expiresAt > now + GUIDE_SESSION_TTL_MS ||
    !Array.isArray(session.kinds) ||
    session.kinds.length < 1 ||
    session.kinds.length > 2 ||
    new Set(session.kinds).size !== session.kinds.length ||
    !Array.isArray(session.sources) ||
    session.sources.length !== session.kinds.length ||
    !session.kinds.every((kind) =>
      session.sources.some((source) => source?.kind === kind),
    )
  )
    throw new Error("Invalid original-guide session receipt.");
  const context = createGuideContext(
    { status: "ready", sources: session.sources, files: session.files },
    session.origin,
    session.productPath,
  );
  if (context.productPath !== session.productPath)
    throw new Error("Guide session requires a canonical product binding.");
  const previous = sessions.get(conversationId)?.value;
  const expiresAt =
    previous?.sourceCallId === session.sourceCallId &&
    previous.sourceAssistantId === session.sourceAssistantId
      ? Math.min(previous.expiresAt, session.expiresAt)
      : session.expiresAt;

  // Project and freeze public PDF data and opaque receipt fields only. No
  // caller-owned arrays/objects can alter a cached document or its authority.
  const value: GuideSession = {
    sourceCallId: session.sourceCallId,
    sourceAssistantId: session.sourceAssistantId,
    productPath: session.productPath,
    expiresAt,
    kinds: [...session.kinds],
    origin: session.origin,
    pageId: session.pageId,
    sources: session.sources.map(({ kind, url }) => ({
      kind,
      url: new URL(url, session.origin).href,
    })),
    files: session.files.map(({ type, detail, filename, file_data }) => ({
      type,
      detail,
      filename,
      file_data,
    })),
  };
  const bytes = value.files.reduce(
    (sum, file) => sum + 2 * file.file_data!.length,
    0,
  );
  if (bytes > maxBytes)
    throw new Error("Original-guide session exceeds the cache budget.");
  value.sources.forEach(Object.freeze);
  value.files.forEach(Object.freeze);
  Object.freeze(value.sources);
  Object.freeze(value.files);
  Object.freeze(value.kinds);
  Object.freeze(value);

  clearGuideSession(conversationId);
  while (sessions.size >= maxSessions || storedBytes + bytes > maxBytes) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    clearGuideSession(oldest);
  }
  sessions.set(conversationId, { value, bytes });
  storedBytes += bytes;
}
