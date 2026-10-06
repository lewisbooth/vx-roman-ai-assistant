export interface ImageTokenUsage {
  textInputTokens: number | null;
  textCachedInputTokens: number | null;
  imageInputTokens: number | null;
  imageCachedInputTokens: number | null;
  imageOutputTokens: number | null;
}

export interface ParsedImageUsage {
  usage: ImageTokenUsage;
  usageValid: boolean;
  usageEvidenceJson: string | null;
}

export const unknownImageUsage = (): ImageTokenUsage => ({
  textInputTokens: null,
  textCachedInputTokens: null,
  imageInputTokens: null,
  imageCachedInputTokens: null,
  imageOutputTokens: null,
});

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readImageProviderUsage(
  response: unknown,
  duplicateKeys = false,
): ParsedImageUsage {
  const root = jsonObject(response);
  const rawUsage = root?.usage;
  if (rawUsage === undefined || rawUsage === null)
    return {
      usage: unknownImageUsage(),
      usageValid: !duplicateKeys,
      usageEvidenceJson: null,
    };
  const usage = jsonObject(rawUsage);
  if (!usage)
    return {
      usage: unknownImageUsage(),
      usageValid: false,
      usageEvidenceJson: null,
    };
  let valid = !duplicateKeys;
  const object = (parent: Record<string, unknown> | null, key: string) => {
    const value = parent?.[key];
    if (value === undefined || value === null) return null;
    const result = jsonObject(value);
    if (!result) valid = false;
    return result;
  };
  const count = (parent: Record<string, unknown> | null, key: string) => {
    const value = parent?.[key];
    if (value === undefined || value === null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      valid = false;
      return null;
    }
    return value;
  };
  const input = count(usage, "input_tokens");
  const output = count(usage, "output_tokens");
  const total = count(usage, "total_tokens");
  const inputDetails = object(usage, "input_tokens_details");
  const text = count(inputDetails, "text_tokens");
  const image = count(inputDetails, "image_tokens");
  const outputDetails = object(usage, "output_tokens_details");
  const imageOutput = outputDetails
    ? count(outputDetails, "image_tokens")
    : output;
  const textOutput = count(outputDetails, "text_tokens");
  const within = (part: number | null, whole: number | null) =>
    part === null || whole === null || part <= whole;
  const addsUp = (
    left: number | null,
    right: number | null,
    whole: number | null,
  ) =>
    left === null || right === null || whole === null || left + right === whole;
  if (
    (textOutput !== null && textOutput > 0) ||
    !within(text, input) ||
    !within(image, input) ||
    !within(imageOutput, output) ||
    !within(input, total) ||
    !within(output, total) ||
    !addsUp(text, image, input) ||
    !addsUp(input, output, total) ||
    !addsUp(imageOutput, textOutput, output)
  )
    valid = false;
  return {
    usage: valid
      ? {
          textInputTokens: text,
          textCachedInputTokens: null,
          imageInputTokens: image,
          imageCachedInputTokens: null,
          imageOutputTokens: imageOutput,
        }
      : unknownImageUsage(),
    usageValid: valid,
    usageEvidenceJson: JSON.stringify(sanitizeUsage(usage)),
  };
}

function sanitizeUsage(usage: Record<string, unknown>) {
  let remaining = 128;
  const write = (
    value: Record<string, unknown>,
    depth: number,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
      if (!remaining) break;
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
      const nested = jsonObject(field);
      if (nested && depth < 8) {
        remaining--;
        result[key] = write(nested, depth + 1);
      } else if (
        field === null ||
        (typeof field === "number" && Number.isFinite(field))
      ) {
        remaining--;
        result[key] = field;
      }
    }
    return result;
  };
  return write(usage, 0);
}

// JSON.parse keeps the last duplicate. Reject such usage as billing evidence,
// without retaining or logging image payloads. Called only after valid JSON parse.
export function jsonHasDuplicateKeys(text: string) {
  const stack: Array<{
    kind: "object" | "array";
    keys: Set<string>;
    key: boolean;
  }> = [];
  for (let index = 0; index < text.length; index++) {
    const token = text[index];
    if (token === "{" || token === "[") {
      stack.push({
        kind: token === "{" ? "object" : "array",
        keys: new Set(),
        key: true,
      });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === '"') {
      const start = index;
      // Skip image strings without regex backtracking or copying their payload.
      // Input was already parsed as JSON, so strings are necessarily terminated.
      for (index++; index < text.length && text[index] !== '"'; index++)
        if (text[index] === "\\") index++;
      const current = stack[stack.length - 1];
      if (current?.kind === "object" && current.key) {
        const key: string = JSON.parse(text.slice(start, index + 1));
        if (current.keys.has(key)) return true;
        current.keys.add(key);
        current.key = false;
      }
    } else {
      const current = stack[stack.length - 1];
      if (current?.kind !== "object") continue;
      if (token === ",") current.key = true;
      else if (token === ":") current.key = false;
    }
  }
  return false;
}
