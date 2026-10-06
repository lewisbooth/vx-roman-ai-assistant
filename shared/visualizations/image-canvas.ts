const MAXIMUM_INPUT_PIXELS = 1_048_576;
const MAXIMUM_EDGE = 2048;

export interface ImageCanvas {
  width: number;
  height: number;
  size: string;
}

function validCanvas(width: number, height: number) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width < MAXIMUM_EDGE &&
    height < MAXIMUM_EDGE &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    width * height >= 655_360 &&
    width * height <= MAXIMUM_INPUT_PIXELS &&
    Math.max(width, height) <= 3 * Math.min(width, height)
  );
}

export function parseImageCanvas(size: string): ImageCanvas {
  if (!/^[1-9]\d*x[1-9]\d*$/.test(size))
    throw new Error("Expected a supported WIDTHxHEIGHT image canvas.");
  const [width, height] = size.split("x").map(Number);
  if (!validCanvas(width, height))
    throw new Error("Expected a supported WIDTHxHEIGHT image canvas.");
  return { width, height, size };
}

// Preserve the donor's exact rational comparison and largest-canvas tie break.
// This canvas is stored once and reused unchanged for Before and provider input.
export function imageCanvasForPhoto(
  width: number,
  height: number,
): ImageCanvas {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Positive integer photo dimensions are required.");
  const sourceShort = BigInt(Math.min(width, height));
  const sourceLong = [BigInt(Math.max(width, height)), 3n * sourceShort].reduce(
    (left, right) => (left < right ? left : right),
  );
  let bestLong = 1024;
  let bestShort = 1024;
  let bestPixels = MAXIMUM_INPUT_PIXELS;
  let bestError = absolute(
    BigInt(bestLong) * sourceShort - BigInt(bestShort) * sourceLong,
  );
  for (let longEdge = 16; longEdge < MAXIMUM_EDGE; longEdge += 16) {
    for (let shortEdge = 16; shortEdge <= longEdge; shortEdge += 16) {
      if (!validCanvas(longEdge, shortEdge)) continue;
      const error = absolute(
        BigInt(longEdge) * sourceShort - BigInt(shortEdge) * sourceLong,
      );
      const left = error * BigInt(bestShort);
      const right = bestError * BigInt(shortEdge);
      const pixels = longEdge * shortEdge;
      if (left > right || (left === right && pixels <= bestPixels)) continue;
      bestLong = longEdge;
      bestShort = shortEdge;
      bestError = error;
      bestPixels = pixels;
    }
  }
  return parseImageCanvas(
    width >= height ? `${bestLong}x${bestShort}` : `${bestShort}x${bestLong}`,
  );
}

const absolute = (value: bigint) => (value < 0n ? -value : value);
