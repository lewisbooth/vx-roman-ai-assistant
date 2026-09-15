import { isStorefrontPagePath } from "../../shared/journey";

const numberFormat = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const usdFormat = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function estimatedUsd(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value > 0 && value < 0.000001) return "< USD 0.000001";
  return `USD ${usdFormat.format(value)}`;
}

export function serviceTierLabel(tier: string | null): string {
  if (tier === "default") return "Standard (default)";
  if (tier === "priority") return "Fast (priority)";
  return tier || "Not recorded";
}

export function priceBoundary(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function recordedNumber(value: number | null): string {
  return value === null ? "Not recorded" : numberFormat.format(value);
}

export function recordedDate(value: string | null): string {
  return value === null ? "—" : `${dateFormat.format(new Date(value))} UTC`;
}

// Transcript content is untrusted, including links in generated Markdown.
export function storefrontHref(value: string, origin: string): string | null {
  if (!value.trim()) return null;
  try {
    const storefront = new URL(origin);
    const target = new URL(value, storefront);
    return storefront.protocol === "https:" &&
      target.origin === storefront.origin &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash &&
      isStorefrontPagePath(target.pathname, storefront.origin)
      ? target.href
      : null;
  } catch {
    return null;
  }
}
