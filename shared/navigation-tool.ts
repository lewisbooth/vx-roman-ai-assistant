export interface NavigationResult {
  status: "navigated";
  path: string;
}

export const navigationToolDefinition = {
  type: "function",
  name: "navigate",
  description:
    "Navigate the customer's current storefront to a known page when they ask to visit it. Use a root-relative path from the catalog or conversation, including any query or fragment. The storefront may require a full page reload.",
  strict: true,
  parameters: {
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 2048 } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

export function parseNavigationCall(input: unknown): { path: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Navigation arguments must be an object.");
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).length !== 1 ||
    typeof args.path !== "string" ||
    args.path.length > 2048 ||
    !args.path.startsWith("/") ||
    args.path.startsWith("//") ||
    args.path.includes("\\") ||
    [...args.path].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Navigation requires a current-storefront path.");
  const url = new URL(args.path, "https://storefront.invalid");
  if (url.origin !== "https://storefront.invalid")
    throw new Error("Navigation requires a current-storefront path.");
  return { path: `${url.pathname}${url.search}${url.hash}` };
}
