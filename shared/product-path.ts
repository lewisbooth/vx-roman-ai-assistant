const productPathPattern = /^\/products\/[a-z0-9][a-z0-9-]*$/;

export const productPathSchema = {
  type: "string",
  pattern: productPathPattern.source,
  maxLength: 255,
} as const;

export function parseProductPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !productPathPattern.test(value)
  )
    throw new Error("Use a canonical /products/handle path.");
  return value;
}
