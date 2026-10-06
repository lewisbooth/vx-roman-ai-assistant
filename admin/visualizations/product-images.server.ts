import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { MAXIMUM_PHOTO_BYTES, normalizeProductImage } from "./image.server";
import type { NormalizedImage } from "./image.server";
import type { ProductImageRole } from "./prompt.server";

export interface ProductReference {
  url: string;
  role: ProductImageRole;
}

export interface PreparedProductReference extends ProductReference {
  image: NormalizedImage;
}

export class ProductImageError extends Error {
  constructor(message = "The product images could not be prepared securely.") {
    super(message);
    this.name = "ProductImageError";
  }
}

const excludedV4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const ipv4Number = (value: string) =>
  value.split(".").reduce((total, part) => total * 256 + Number(part), 0);

function ipv6Number(value: string): bigint | null {
  if (value.includes("%") || value.includes(".")) return null;
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups =
    halves.length === 2
      ? [...left, ...Array(missing).fill("0"), ...right]
      : left;
  if (groups.length !== 8) return null;
  return groups.reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

const inV6Range = (value: bigint, base: string, prefix: number) =>
  value >> BigInt(128 - prefix) === ipv6Number(base)! >> BigInt(128 - prefix);

// Port the donor's conservative globally reachable unicast subset. Reject an
// entire DNS answer when any address is private/special-use, then pin the socket.
export function isPublicImageAddress(address: string) {
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    return !excludedV4.some(
      ([base, prefix]) =>
        Math.floor(value / 2 ** (32 - prefix)) ===
        Math.floor(ipv4Number(base) / 2 ** (32 - prefix)),
    );
  }
  if (isIP(address) !== 6) return false;
  const value = ipv6Number(address);
  if (value === null || !inV6Range(value, "2000::", 3)) return false;
  return ![
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ].some(([base, prefix]) => inV6Range(value, String(base), Number(prefix)));
}

export function validateProductImageUrl(
  raw: string,
  allowedOrigins: readonly string[],
) {
  if (!raw || raw.length > 4096 || /\s|\p{Cc}/u.test(raw))
    throw new ProductImageError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProductImageError();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !allowedOrigins.includes(url.origin)
  )
    throw new ProductImageError();
  const path = url.pathname;
  const shopPath =
    /^\/cdn\/shop\/(?:files|products)\/[^/]+\.(?:jpe?g|png|webp)$/i;
  const cdnPath =
    /^\/s\/files\/(?:\d+\/)+(?:(?:files|products)\/)[^/]+\.(?:jpe?g|png|webp)$/i;
  if (
    !(url.hostname === "cdn.shopify.com" ? cdnPath : shopPath).test(path) ||
    /(?:%2f|%5c|%00|\\)/i.test(path)
  )
    throw new ProductImageError();
  return url;
}

type Address = { address: string; family: number };
type ReferenceOptions = {
  allowedOrigins: readonly string[];
  signal?: AbortSignal;
  // Narrow test seam; production always uses the DNS-pinned HTTPS implementation.
  resolve?: (hostname: string) => Promise<Address[]>;
  download?: (
    url: URL,
    addresses: readonly Address[],
    signal: AbortSignal,
  ) => Promise<{ bytes: Buffer; contentType: string }>;
};

export async function fetchProductReferences(
  references: readonly ProductReference[],
  options: ReferenceOptions,
): Promise<PreparedProductReference[]> {
  if (
    references.length < 1 ||
    references.length > 4 ||
    new Set(references.map((reference) => reference.url)).size !==
      references.length ||
    references.some(
      (reference) =>
        !["installation", "detail", "unknown"].includes(reference.role),
    )
  )
    throw new ProductImageError("Supply one to four distinct product images.");
  // Check the whole batch before DNS or download; trusted receipt validation is
  // still required by the job owner before these URLs reach this boundary.
  const urls = references.map((reference) =>
    validateProductImageUrl(reference.url, options.allowedOrigins),
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const result: PreparedProductReference[] = [];
  try {
    for (let index = 0; index < references.length; index++) {
      signal.throwIfAborted();
      const url = urls[index];
      const addresses = await raceAbort(
        (
          options.resolve ??
          ((hostname) => lookup(hostname, { all: true, verbatim: true }))
        )(url.hostname),
        signal,
      );
      if (
        addresses.length < 1 ||
        addresses.length > 16 ||
        addresses.some(
          (address) =>
            !isPublicImageAddress(address.address) ||
            isIP(address.address) !== address.family,
        )
      )
        throw new ProductImageError();
      const source = await (options.download ?? downloadPinnedImage)(
        url,
        addresses,
        signal,
      );
      const image = await normalizeProductImage(source.bytes, {
        contentType: source.contentType,
        signal,
      });
      result.push({ ...references[index], image });
    }
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof ProductImageError) throw error;
    if (signal.aborted)
      throw new ProductImageError("Product image preparation timed out.");
    throw new ProductImageError();
  }
}

async function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function downloadPinnedImage(
  url: URL,
  addresses: readonly Address[],
  signal: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const pinned = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, pinned.address, pinned.family);
    };
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup,
        family: pinned.family,
        servername: url.hostname,
        rejectUnauthorized: true,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          Accept: "image/jpeg, image/png, image/webp",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        void (async () => {
          const type = response.headers["content-type"]
            ?.toLowerCase()
            .split(";")[0]
            .trim();
          const declared = response.headers["content-length"];
          const encoding = response.headers["content-encoding"];
          if (
            response.statusCode !== 200 ||
            !type ||
            !["image/jpeg", "image/png", "image/webp"].includes(type) ||
            !declared ||
            !/^[1-9]\d*$/.test(declared) ||
            Number(declared) > MAXIMUM_PHOTO_BYTES ||
            (encoding && encoding.toLowerCase() !== "identity")
          )
            throw new ProductImageError();
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of response) {
            signal.throwIfAborted();
            length += chunk.length;
            if (length > MAXIMUM_PHOTO_BYTES || length > Number(declared))
              throw new ProductImageError();
            chunks.push(chunk);
          }
          if (length !== Number(declared)) throw new ProductImageError();
          resolve({ bytes: Buffer.concat(chunks, length), contentType: type });
        })().catch((error: unknown) => {
          response.destroy();
          req.destroy();
          reject(
            error instanceof ProductImageError
              ? error
              : new ProductImageError(),
          );
        });
      },
    );
    req.setTimeout(5_000, () => req.destroy(new ProductImageError()));
    req.on("error", () =>
      reject(signal.aborted ? signal.reason : new ProductImageError()),
    );
    req.end();
  });
}
