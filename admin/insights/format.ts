import { isStorefrontPagePath } from "../../shared/journey";

const numberFormat = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

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
