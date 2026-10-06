import {
  imageCanvasForPhoto,
  parseImageCanvas,
} from "../../shared/visualizations/image-canvas";
import type { ImageCanvas } from "../../shared/visualizations/image-canvas";
export {
  imageCanvasForPhoto,
  parseImageCanvas,
} from "../../shared/visualizations/image-canvas";
export type { ImageCanvas } from "../../shared/visualizations/image-canvas";
import { createHash } from "node:crypto";
import sharp from "sharp";

export const MAXIMUM_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAXIMUM_DECODED_PIXELS = 52_000_000;
export const MAXIMUM_PROVIDER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_INPUT_PIXELS = 1_048_576;
const MAXIMUM_EDGE = 2048;

export interface NormalizedImage {
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
}

export class ImageValidationError extends Error {
  constructor(
    readonly code:
      | "image_empty"
      | "image_too_large"
      | "image_invalid"
      | "image_format_unsupported"
      | "image_type_mismatch"
      | "image_too_many_pixels"
      | "image_animated"
      | "image_canvas_mismatch"
      | "image_processing_busy",
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

const invalid = () =>
  new ImageValidationError(
    "image_invalid",
    "The photo is invalid or incomplete.",
  );

type ImageOptions = { contentType?: string; signal?: AbortSignal };

let activeDecodes = 0;
const decodeWaiters: Array<{ grant: () => void }> = [];

async function withImageProcessing<T>(
  options: ImageOptions,
  run: () => Promise<T>,
) {
  options.signal?.throwIfAborted();
  if (activeDecodes < 4) activeDecodes++;
  else {
    if (decodeWaiters.length >= 8)
      throw new ImageValidationError(
        "image_processing_busy",
        "Image processing is busy. Please try again shortly.",
      );
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        const index = decodeWaiters.indexOf(waiter);
        if (index !== -1) decodeWaiters.splice(index, 1);
        reject(
          options.signal?.reason ?? new Error("Image processing cancelled."),
        );
      };
      const waiter = {
        grant: () => {
          options.signal?.removeEventListener("abort", aborted);
          resolve();
        },
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
      decodeWaiters.push(waiter);
    });
  }
  try {
    options.signal?.throwIfAborted();
    return await run();
  } finally {
    const next = decodeWaiters.shift();
    if (next) next.grant();
    else activeDecodes--;
  }
}

async function readImage(bytes: Buffer, options: ImageOptions) {
  options.signal?.throwIfAborted();
  if (!bytes.length)
    throw new ImageValidationError("image_empty", "Choose a room photo.");
  if (bytes.length > MAXIMUM_PHOTO_BYTES)
    throw new ImageValidationError(
      "image_too_large",
      "Choose a photo no larger than 25 MB.",
    );
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAXIMUM_DECODED_PIXELS,
    }).metadata();
  } catch {
    options.signal?.throwIfAborted();
    throw invalid();
  }
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format))
    throw new ImageValidationError(
      "image_format_unsupported",
      "Use a JPEG, PNG or WebP photo.",
    );
  const expectedType = `image/${metadata.format}`;
  if (
    options.contentType &&
    options.contentType.toLowerCase().split(";")[0].trim() !== expectedType
  )
    throw new ImageValidationError(
      "image_type_mismatch",
      "The photo contents do not match its image type.",
    );
  const { width, height } = metadata;
  if (!width || !height) throw invalid();
  if (width * height > MAXIMUM_DECODED_PIXELS)
    throw new ImageValidationError(
      "image_too_many_pixels",
      "Choose a photo with no more than 52 megapixels.",
    );
  requireCompleteContainer(bytes, metadata.format);
  if ((metadata.pages ?? 1) > 1 || hasAnimation(bytes, metadata.format))
    throw new ImageValidationError(
      "image_animated",
      "Use a still photo rather than an animation.",
    );
  const swapsAxes =
    metadata.orientation && [5, 6, 7, 8].includes(metadata.orientation);
  options.signal?.throwIfAborted();
  return {
    width: swapsAxes ? height : width,
    height: swapsAxes ? width : height,
    format: metadata.format,
  };
}

function requireCompleteContainer(bytes: Buffer, format: string) {
  const complete =
    format === "jpeg"
      ? bytes.length >= 2 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9
      : format === "png"
        ? bytes
            .subarray(-12)
            .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
        : bytes.length >= 12 && bytes.readUInt32LE(4) === bytes.length - 8;
  if (!complete) throw invalid();
}

function hasAnimation(bytes: Buffer, format: string) {
  if (format === "webp")
    return (
      bytes.length >= 21 &&
      bytes.subarray(12, 16).toString("ascii") === "VP8X" &&
      (bytes[20] & 2) !== 0
    );
  if (format !== "png") return false;
  for (let offset = 8; offset < bytes.length;) {
    if (bytes.length - offset < 12) throw invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw invalid();
    if (bytes.subarray(offset + 4, offset + 8).toString("ascii") === "acTL")
      return true;
    offset += length + 12;
  }
  return false;
}

async function encode(
  bytes: Buffer,
  width: number,
  height: number,
  options: ImageOptions,
): Promise<NormalizedImage> {
  options.signal?.throwIfAborted();
  try {
    const output = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAXIMUM_DECODED_PIXELS,
    })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(width, height, { fit: "cover", position: "centre" })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    options.signal?.throwIfAborted();
    return {
      bytes: output.data,
      sha256: createHash("sha256").update(output.data).digest("hex"),
      width: output.info.width,
      height: output.info.height,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof ImageValidationError) throw error;
    throw invalid();
  }
}

export async function normalizeRoomPhoto(
  bytes: Buffer,
  options: ImageOptions = {},
) {
  return withImageProcessing(options, async () => {
    const source = await readImage(bytes, options);
    const canvas = imageCanvasForPhoto(source.width, source.height);
    const image = await encode(bytes, canvas.width, canvas.height, options);
    return { image, canvas };
  });
}

export async function normalizeProductImage(
  bytes: Buffer,
  options: ImageOptions = {},
) {
  return withImageProcessing(options, async () => {
    const source = await readImage(bytes, options);
    const scale = Math.min(
      1,
      MAXIMUM_EDGE / Math.max(source.width, source.height),
      Math.sqrt(MAXIMUM_INPUT_PIXELS / (source.width * source.height)),
    );
    return encode(
      bytes,
      Math.max(1, Math.floor(source.width * scale)),
      Math.max(1, Math.floor(source.height * scale)),
      options,
    );
  });
}

export async function validateProviderImage(
  bytes: Buffer,
  canvas: ImageCanvas,
  options: ImageOptions = {},
): Promise<NormalizedImage> {
  return withImageProcessing(options, async () => {
    if (!bytes.length || bytes.length > MAXIMUM_PROVIDER_IMAGE_BYTES)
      throw new ImageValidationError(
        "image_too_large",
        "The generated image exceeded the allowed size.",
      );
    const source = await readImage(bytes, {
      ...options,
      contentType: "image/jpeg",
    });
    const expected = parseImageCanvas(canvas.size);
    if (source.width !== expected.width || source.height !== expected.height)
      throw new ImageValidationError(
        "image_canvas_mismatch",
        "The generated image has an unexpected size.",
      );
    return encode(bytes, expected.width, expected.height, options);
  });
}
