import type { GuidePart } from "./conversation";
import { parseProductPath, productPathSchema } from "./product-path";
import {
  parseProductConfigurationResult,
  type ProductConfiguration,
} from "./product-configuration";

export type ProductGuideKind = "measuring" | "fitting";
export interface ProductGuide {
  kind: ProductGuideKind;
  url: string;
}
export interface ProductGuidesResult {
  status: "found" | "unavailable";
  productPath: string;
  guides: ProductGuide[];
  /** A fresh native read only; PDF cache entries never carry this capability. */
  configuration?: ProductConfiguration;
}

export const PRODUCT_GUIDE_LABELS = {
  measuring: "Measuring guide",
  fitting: "Fitting guide",
} as const;

const kinds = ["measuring", "fitting"] as const;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Model read contract; selection and refresh stay server-side. */
export const productGuidesToolDefinition = {
  type: "function",
  name: "get_product_guides",
  description:
    "Read selected original measuring/fitting PDFs and diagrams for the verified current productPath. A fresh browser discovery includes native configuration, supported measurement inputs and limits in the same operation. kinds chooses only originals needed for this question. refresh:false reuses matching cached originals without browser lookup/download; cached files do not provide fresh configuration. refresh:true discovers fresh current-page links. Files attach for this turn and return source provenance; inventory alone is not document content.",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      productPath: productPathSchema,
      kinds: {
        type: "array",
        items: { type: "string", enum: kinds },
        minItems: 1,
        maxItems: 2,
      },
      refresh: { type: "boolean" },
    },
    required: ["productPath", "kinds", "refresh"],
    additionalProperties: false,
  },
} as const;

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Product guides must be an object.");
  return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unexpected product guide fields.");
}

/** Browser discovery only; it returns links without downloading either PDF. */
export function parseProductGuidesCall(input: unknown): {
  productPath: string;
} {
  const value = object(input);
  exact(value, ["productPath"]);
  return { productPath: parseProductPath(value.productPath) };
}

export function parseGuideSelection(input: unknown): {
  productPath: string;
  kinds: ProductGuideKind[];
} {
  const value = object(input);
  exact(value, ["productPath", "kinds"]);
  if (
    !Array.isArray(value.kinds) ||
    value.kinds.length < 1 ||
    value.kinds.length > 2 ||
    new Set(value.kinds).size !== value.kinds.length ||
    !value.kinds.every((kind) => kinds.includes(kind))
  )
    throw new Error("Choose one or two distinct supported guide kinds.");
  return {
    productPath: parseProductPath(value.productPath),
    kinds: [...value.kinds],
  };
}

export function parseProductGuideRead(input: unknown): {
  productPath: string;
  kinds: ProductGuideKind[];
  refresh: boolean;
} {
  const value = object(input);
  exact(value, [
    "productPath",
    "kinds",
    ...(Object.hasOwn(value, "refresh") ? ["refresh"] : []),
  ]);
  if (Object.hasOwn(value, "refresh") && typeof value.refresh !== "boolean")
    throw new Error("Guide refresh must be a boolean.");
  return {
    ...parseGuideSelection({
      productPath: value.productPath,
      kinds: value.kinds,
    }),
    refresh: value.refresh === true,
  };
}

/** Preserve the exact file version; this validates links and never fetches PDFs. */
export function parseProductGuideUrl(
  input: unknown,
  storefrontOrigin: string,
): string {
  if (
    typeof input !== "string" ||
    input.length > 2048 ||
    /[\\\s]/.test(input) ||
    [...input].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid product guide URL.");
  const origin = new URL(storefrontOrigin);
  const url = new URL(input, origin.origin);
  const supportedLocation =
    (url.origin === storefrontOrigin &&
      /^\/cdn\/shop\/files\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.pdf$/.test(
        url.pathname,
      )) ||
    (url.origin === "https://cdn.shopify.com" &&
      /^\/s\/files\/1\/(?:\d{1,12}\/){2,4}files\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.pdf$/.test(
        url.pathname,
      ));
  if (
    origin.protocol !== "https:" ||
    origin.origin !== storefrontOrigin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !supportedLocation
  )
    throw new Error(
      "Product guides must be PDF files on the storefront or Shopify file CDN.",
    );
  // Reject raw dot/encoded path segments before URL normalization can hide them.
  if (
    input.includes("%") ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(input.split(/[?#]/, 1)[0])
  )
    throw new Error("Invalid product guide URL path.");
  if (url.search && !/^\?v=\d{1,30}$/.test(url.search))
    throw new Error(
      "Product guide URLs support only the store's numeric file version.",
    );
  return url.href;
}

function parseGuides(input: unknown, storefrontOrigin: string): ProductGuide[] {
  if (!Array.isArray(input) || input.length > 2)
    throw new Error("A product has at most two supported guides.");
  const found = new Set<ProductGuideKind>();
  return input.map((entry) => {
    const value = object(entry);
    exact(value, ["kind", "url"]);
    if (
      !kinds.includes(value.kind as ProductGuideKind) ||
      found.has(value.kind as ProductGuideKind)
    )
      throw new Error("Product guide kinds must be supported and distinct.");
    const kind = value.kind as ProductGuideKind;
    found.add(kind);
    return { kind, url: parseProductGuideUrl(value.url, storefrontOrigin) };
  });
}

export function parseProductGuidesResult(
  input: unknown,
  storefrontOrigin: string,
): ProductGuidesResult {
  const value = object(input);
  exact(value, [
    "status",
    "productPath",
    "guides",
    ...(value.configuration !== undefined ? ["configuration"] : []),
  ]);
  const guides = parseGuides(value.guides, storefrontOrigin);
  const productPath = parseProductPath(value.productPath);
  const configuration =
    value.configuration === undefined
      ? undefined
      : parseProductConfigurationResult(
          "get_product_configuration",
          value.configuration,
        );
  if (configuration && configuration.productPath !== productPath)
    throw new Error(
      "Product guides and configuration must belong to the same product.",
    );
  if (
    (value.status !== "found" && value.status !== "unavailable") ||
    (value.status === "found") !== guides.length > 0
  )
    throw new Error("Product guide availability does not match its links.");
  return {
    status: value.status,
    productPath,
    guides,
    ...(configuration ? { configuration } : {}),
  };
}

export function parseGuidePart(
  input: unknown,
  storefrontOrigin: string,
): GuidePart {
  const value = object(input);
  exact(value, [
    "type",
    "version",
    "invocationId",
    ...(value.version === 2 ? ["libraryPagePath"] : ["productPath"]),
    "guides",
    ...(value.voiceReply !== undefined ? ["voiceReply"] : []),
  ]);
  if (
    value.type !== "guides" ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.invocationId !== "string" ||
    !uuidPattern.test(value.invocationId)
  )
    throw new Error("Invalid saved guide part.");
  const guides = parseGuides(value.guides, storefrontOrigin);
  if (!guides.length) throw new Error("A saved guide part must contain a PDF.");
  let source:
    | { version: 1; productPath: string }
    | {
        version: 2;
        libraryPagePath:
          "/pages/measuring-blinds" | "/pages/measuring-curtains";
      };
  if (value.version === 2) {
    if (
      (value.libraryPagePath !== "/pages/measuring-blinds" &&
        value.libraryPagePath !== "/pages/measuring-curtains") ||
      guides.length !== 1 ||
      guides[0].kind !== "measuring"
    )
      throw new Error(
        "A library guide must be one measuring PDF from a supported library page.",
      );
    source = { version: 2, libraryPagePath: value.libraryPagePath };
  } else
    source = { version: 1, productPath: parseProductPath(value.productPath) };
  let voiceReply: GuidePart["voiceReply"];
  if (value.voiceReply !== undefined) {
    const voice = object(value.voiceReply);
    exact(voice, ["voiceId", "afterSequence"]);
    if (
      typeof voice.voiceId !== "string" ||
      !uuidPattern.test(voice.voiceId) ||
      typeof voice.afterSequence !== "number" ||
      !Number.isSafeInteger(voice.afterSequence) ||
      voice.afterSequence < 0
    )
      throw new Error("Invalid guide voice association.");
    voiceReply = { voiceId: voice.voiceId, afterSequence: voice.afterSequence };
  }
  return {
    type: "guides",
    ...source,
    invocationId: value.invocationId,
    guides,
    ...(voiceReply ? { voiceReply } : {}),
  };
}
