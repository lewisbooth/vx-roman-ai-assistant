import {
  MAXIMUM_PROVIDER_IMAGE_BYTES,
  parseImageCanvas,
  validateProviderImage,
} from "./image.server";
import type { NormalizedImage } from "./image.server";
import { buildVisualizationPrompt } from "./prompt.server";
import type { PreparedProductReference } from "./product-images.server";
import {
  jsonHasDuplicateKeys,
  jsonObject,
  readImageProviderUsage,
  unknownImageUsage,
} from "./usage.server";
import type { ImageTokenUsage } from "./usage.server";

export const PRIMARY_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const FALLBACK_IMAGE_MODEL = "gpt-image-2.5-flare";
export type ImageModel =
  typeof PRIMARY_IMAGE_MODEL | typeof FALLBACK_IMAGE_MODEL;
export const MAXIMUM_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
const IMAGE_ENDPOINT = "https://api.openai.com/v1/images/edits";

export interface ImageProviderReceipt {
  model: ImageModel;
  outcome: "succeeded" | "failed" | "unknown";
  providerRequestId: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  usage: ImageTokenUsage;
  usageValid: boolean;
  usageEvidenceJson: string | null;
  fallbackEligible: boolean;
  retryAfterSeconds: number | null;
}

export interface ImageProviderInput {
  model: ImageModel;
  requestId: string;
  ownerId: string;
  room: NormalizedImage;
  references: readonly PreparedProductReference[];
  productTitle: string;
  cleanup: boolean;
  targetDescription?: string;
  configurationSummary?: string;
  signal: AbortSignal;
  onReceipt: (receipt: ImageProviderReceipt) => Promise<void>;
}

export interface ImageProviderResult {
  receipt: ImageProviderReceipt;
  image: NormalizedImage | null;
  imageErrorCode: string | null;
}

export async function generateVisualizationAttempt(
  input: ImageProviderInput,
  options: { apiKey: string; fetch?: typeof fetch },
): Promise<ImageProviderResult> {
  if (
    ![PRIMARY_IMAGE_MODEL, FALLBACK_IMAGE_MODEL].includes(input.model) ||
    !options.apiKey.trim()
  )
    throw new Error("The image provider is not configured.");
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.ownerId)
  )
    throw new Error("Bounded request and owner identities are required.");
  const canvas = parseImageCanvas(`${input.room.width}x${input.room.height}`);
  if (
    input.references.length < 1 ||
    input.references.length > 4 ||
    !validInput(input.room) ||
    input.references.some((reference) => !validInput(reference.image))
  )
    throw new Error("Bounded optimized room and product images are required.");
  const prompt = buildVisualizationPrompt({
    productTitle: input.productTitle,
    cleanup: input.cleanup,
    roles: input.references.map((reference) => reference.role),
    targetDescription: input.targetDescription,
    configurationSummary: input.configurationSummary,
  });
  const emptyReceipt: ImageProviderReceipt = {
    model: input.model,
    outcome: "unknown",
    providerRequestId: null,
    httpStatus: null,
    errorCode: null,
    usage: unknownImageUsage(),
    usageValid: true,
    usageEvidenceJson: null,
    fallbackEligible: false,
    retryAfterSeconds: null,
  };
  let receipt = emptyReceipt;
  let encoded: string | null = null;
  let imageErrorCode: string | null = null;
  try {
    input.signal.throwIfAborted();
    // A physical attempt is one POST. There is no SDK resilience/retry layer;
    // only the job owner may reserve one explicitly eligible Flare continuation.
    const response = await (options.fetch ?? fetch)(IMAGE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": input.requestId,
      },
      body: JSON.stringify({
        model: input.model,
        quality: "auto",
        size: canvas.size,
        n: 1,
        output_format: "jpeg",
        stream: false,
        prompt,
        images: [
          input.room,
          ...input.references.map((reference) => reference.image),
        ].map((image) => ({
          image_url: `data:image/jpeg;base64,${image.bytes.toString("base64")}`,
        })),
        user: input.ownerId,
      }),
      signal: input.signal,
    });
    receipt = {
      ...receipt,
      httpStatus: response.status,
      outcome:
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
          ? "failed"
          : "unknown",
      providerRequestId: requestId(response.headers.get("x-request-id")),
    };
    const text = await readProviderResponse(response, input.signal);
    const parsed: unknown = JSON.parse(text);
    if (!withinDepth(parsed, 16))
      throw new ProviderReadError("provider_invalid_response");
    const duplicates = jsonHasDuplicateKeys(text);
    const usage = readImageProviderUsage(parsed, duplicates);
    receipt = { ...receipt, ...usage };
    const root = jsonObject(parsed);
    if (!response.ok) {
      const fallbackEligible =
        !duplicates &&
        input.model === PRIMARY_IMAGE_MODEL &&
        isEligibleImageFallback(response.status, parsed);
      receipt = {
        ...receipt,
        outcome: fallbackEligible ? "failed" : receipt.outcome,
        fallbackEligible,
        errorCode: fallbackEligible
          ? "provider_model_unavailable"
          : `provider_http_${response.status}`,
        retryAfterSeconds: fallbackEligible
          ? retryAfter(response.headers.get("retry-after"))
          : null,
      };
    } else if (
      !root ||
      duplicates ||
      Object.hasOwn(root, "error") ||
      !Array.isArray(root.data) ||
      !root.data.length ||
      !jsonObject(root.data[0])
    ) {
      receipt = { ...receipt, errorCode: "provider_invalid_response" };
    } else {
      receipt = {
        ...receipt,
        outcome: "succeeded",
        errorCode: usage.usageValid ? null : "provider_invalid_usage",
      };
      const data = jsonObject(root.data[0]);
      if (
        root.data.length !== 1 ||
        typeof data?.b64_json !== "string" ||
        !data.b64_json.length
      )
        imageErrorCode = "provider_image_missing";
      else encoded = data.b64_json;
    }
  } catch (error) {
    receipt = {
      ...receipt,
      errorCode: input.signal.aborted
        ? "provider_cancelled"
        : error instanceof ProviderReadError
          ? error.code
          : error instanceof SyntaxError
            ? "provider_invalid_response"
            : "provider_connection_failed",
      fallbackEligible: false,
      retryAfterSeconds: null,
    };
  }

  // Mandatory durability boundary: billing evidence commits before base64
  // decoding, native image validation, result storage or final publication.
  // Receipt persistence failure propagates; it must never provoke another POST.
  await input.onReceipt(receipt);
  if (!encoded) return { receipt, image: null, imageErrorCode };
  if (encoded.length > Math.ceil(MAXIMUM_PROVIDER_IMAGE_BYTES / 3) * 4)
    return { receipt, image: null, imageErrorCode: "provider_image_too_large" };
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    return { receipt, image: null, imageErrorCode: "provider_image_invalid" };
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAXIMUM_PROVIDER_IMAGE_BYTES)
    return { receipt, image: null, imageErrorCode: "provider_image_too_large" };
  if (bytes.toString("base64") !== encoded)
    return { receipt, image: null, imageErrorCode: "provider_image_invalid" };
  try {
    const image = await validateProviderImage(bytes, canvas, {
      signal: input.signal,
    });
    return { receipt, image, imageErrorCode: null };
  } catch {
    return {
      receipt,
      image: null,
      imageErrorCode: input.signal.aborted
        ? "provider_cancelled"
        : "provider_image_invalid",
    };
  }
}

function validInput(image: NormalizedImage) {
  return (
    image.bytes.length > 0 &&
    image.bytes.length <= MAXIMUM_PROVIDER_IMAGE_BYTES &&
    image.width > 0 &&
    image.height > 0 &&
    image.width <= 2048 &&
    image.height <= 2048 &&
    image.width * image.height <= 1_048_576
  );
}

export function isEligibleImageFallback(status: number, value: unknown) {
  const root = jsonObject(value);
  if (!root || Object.hasOwn(root, "data") || Object.hasOwn(root, "usage"))
    return false;
  const error = jsonObject(root.error);
  return (
    !!error &&
    ((status === 404 && error.code === "model_not_found") ||
      (status === 503 &&
        error.code === "server_is_overloaded" &&
        error.type === "service_unavailable_error"))
  );
}

const requestId = (value: string | null) =>
  value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;

function retryAfter(value: string | null) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(2_147_483_647, Number(value));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(
        2_147_483_647,
        Math.max(0, Math.ceil((date - Date.now()) / 1000)),
      )
    : null;
}

function withinDepth(value: unknown, remaining: number): boolean {
  if (value === null || typeof value !== "object") return true;
  if (remaining <= 0) return false;
  return (Array.isArray(value) ? value : Object.values(value)).every((child) =>
    withinDepth(child, remaining - 1),
  );
}

class ProviderReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function readProviderResponse(response: Response, signal: AbortSignal) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProviderReadError("provider_response_too_large");
  }
  if (!response.body)
    throw new ProviderReadError("provider_response_incomplete");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAXIMUM_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderReadError("provider_response_too_large");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
