export interface StoreSupportResult {
  status: "found" | "unavailable";
  phone?: string;
  hours?: string;
  contactUrl?: string;
}

export const storeSupportToolDefinition = {
  type: "function",
  name: "get_store_support",
  description:
    "Read the current store's footer contact phone, opening hours and contact-page link. Return only fields actually present; missing contact details are unknown, not permission to invent defaults. State verified hours directly without source narration; opening hours alone do not prove current availability. Does not call, message or navigate.",
  strict: true,
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const;

export function parseStoreSupportCall(input: unknown): Record<string, never> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length
  )
    throw new Error("Store support does not accept arguments.");
  return {};
}

function text(input: unknown, max: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > max ||
    /[\p{Cc}\p{Cf}]/u.test(input)
  )
    throw new Error("Invalid store support text.");
  return input.trim();
}

export function parseStoreSupportResult(
  input: unknown,
  storefrontOrigin: string,
): StoreSupportResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid store support result.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["status", "phone", "hours", "contactUrl"].includes(key),
    ) ||
    (value.status !== "found" && value.status !== "unavailable")
  )
    throw new Error("Invalid store support fields.");
  const result: StoreSupportResult = { status: value.status };
  if (value.phone !== undefined) {
    const phone = text(value.phone, 40);
    if (
      !/^\+?[\d ().-]+$/.test(phone) ||
      !/^\d{6,18}$/.test(phone.replace(/\D/g, ""))
    )
      throw new Error("Invalid support phone number.");
    result.phone = phone;
  }
  if (value.hours !== undefined) result.hours = text(value.hours, 160);
  if (value.contactUrl !== undefined) {
    const raw = text(value.contactUrl, 2048);
    const origin = new URL(storefrontOrigin),
      url = new URL(raw, origin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== storefrontOrigin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      /[\\\s]/.test(raw)
    )
      throw new Error("Invalid support contact URL.");
    result.contactUrl = url.href;
  }
  if ((result.status === "found") !== Object.keys(result).length > 1)
    throw new Error("Store support status does not match its details.");
  return result;
}
