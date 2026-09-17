import { Buffer } from "node:buffer";
import type { ResponseInputFile } from "openai/resources/responses/responses";
import {
  parseProductGuidesResult,
  parseProductGuideUrl,
  type ProductGuide,
  type ProductGuideKind,
  type ProductGuidesResult,
} from "../../shared/product-guides";

export type FailureReason =
  | "invalid_guides"
  | "no_guides"
  | "not_found"
  | "network"
  | "timeout"
  | "too_large"
  | "invalid_pdf";

export type ProductGuideFiles =
  | {
      status: "ready";
      sources: ProductGuide[];
      files: ResponseInputFile[];
      unavailable?: { kind: ProductGuideKind; reason: FailureReason }[];
    }
  | { status: "unavailable"; reason: FailureReason };

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;
const CACHE_TTL_MS = 15 * 60_000;
const PDF_SIGNATURE = Buffer.from("%PDF-");
const cache = new Map<string, { bytes: Buffer; expiresAt: number }>();
let cachedBytes = 0;

class GuideReadError extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

function removeCached(url: string) {
  const entry = cache.get(url);
  if (entry) cachedBytes -= entry.bytes.length;
  cache.delete(url);
}

function cachedFile(url: string) {
  const now = Date.now();
  for (const [key, entry] of cache)
    if (entry.expiresAt <= now) removeCached(key);
  const entry = cache.get(url);
  if (entry) {
    cache.delete(url);
    cache.set(url, entry);
  }
  return entry?.bytes;
}

function cacheFile(url: string, bytes: Buffer) {
  removeCached(url);
  while (
    cache.size >= MAX_CACHE_ENTRIES ||
    cachedBytes + bytes.length > MAX_CACHE_BYTES
  ) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    removeCached(oldest);
  }
  cache.set(url, { bytes, expiresAt: Date.now() + CACHE_TTL_MS });
  cachedBytes += bytes.length;
}

async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const cached = cachedFile(url);
  if (cached) return cached;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10_000);
  const requestSignal = AbortSignal.any([signal, timeout.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => {
    // Cleanup must not replace a caller's abort reason or the read failure.
    void reader?.cancel().catch(() => undefined);
  };
  try {
    const response = await fetch(url, {
      signal: requestSignal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/pdf" },
    });
    reader = response.body?.getReader();
    requestSignal.throwIfAborted();
    if (!response.ok || response.redirected)
      throw new GuideReadError(
        !response.redirected && response.status === 404
          ? "not_found"
          : "network",
      );
    if (
      !reader ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "application/pdf"
    )
      throw new GuideReadError("invalid_pdf");
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > MAX_FILE_BYTES)
      throw new GuideReadError("too_large");

    requestSignal.addEventListener("abort", cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      requestSignal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE_BYTES) throw new GuideReadError("too_large");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    if (!bytes.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE))
      throw new GuideReadError("invalid_pdf");
    signal.throwIfAborted();
    cacheFile(url, bytes);
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.signal.aborted) throw new GuideReadError("timeout");
    throw error instanceof GuideReadError
      ? error
      : new GuideReadError("network");
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", cancelReader);
    cancelReader();
    reader?.releaseLock();
  }
}

/** One validated original, shared by PDP and selected library-document reads. */
export async function readGuideFile(
  url: string,
  storefrontOrigin: string,
  signal: AbortSignal,
  options: { refresh?: boolean; filename?: string } = {},
): Promise<
  | { status: "ready"; file: ResponseInputFile }
  | { status: "unavailable"; reason: FailureReason }
> {
  signal.throwIfAborted();
  let verified: string;
  const filename = options.filename ?? "guide.pdf";
  try {
    verified = parseProductGuideUrl(url, storefrontOrigin);
    if (!/^[a-zA-Z0-9_-]{1,100}\.pdf$/.test(filename)) throw new Error();
  } catch {
    return { status: "unavailable", reason: "invalid_guides" };
  }
  if (options.refresh) removeCached(verified);
  try {
    const bytes = await download(verified, signal);
    signal.throwIfAborted();
    return {
      status: "ready",
      file: {
        type: "input_file",
        filename,
        file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
        detail: "high",
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      status: "unavailable",
      reason: error instanceof GuideReadError ? error.reason : "network",
    };
  }
}

/** Public guide bytes stay in bounded server memory, never in customer DTOs. */
export async function readProductGuideFiles(
  result: ProductGuidesResult,
  storefrontOrigin: string,
  signal: AbortSignal,
  options: { refresh?: boolean } = {},
): Promise<ProductGuideFiles> {
  signal.throwIfAborted();
  let verified: ProductGuidesResult;
  try {
    verified = parseProductGuidesResult(result, storefrontOrigin);
  } catch {
    return { status: "unavailable", reason: "invalid_guides" };
  }
  if (verified.status === "unavailable")
    return { status: "unavailable", reason: "no_guides" };
  if (options.refresh)
    for (const guide of verified.guides) removeCached(guide.url);
  const files: ResponseInputFile[] = [];
  const sources: ProductGuide[] = [];
  const unavailable: { kind: ProductGuideKind; reason: FailureReason }[] = [];
  for (const guide of verified.guides) {
    try {
      const bytes = await download(guide.url, signal);
      signal.throwIfAborted();
      files.push({
        type: "input_file",
        filename: `${guide.kind}-guide.pdf`,
        file_data: `data:application/pdf;base64,${bytes.toString("base64")}`,
        detail: "high",
      });
      sources.push(guide);
    } catch (error) {
      signal.throwIfAborted();
      unavailable.push({
        kind: guide.kind,
        reason: error instanceof GuideReadError ? error.reason : "network",
      });
    }
  }
  if (!files.length)
    return { status: "unavailable", reason: unavailable[0].reason };
  return {
    status: "ready",
    sources,
    files,
    ...(unavailable.length ? { unavailable } : {}),
  };
}
