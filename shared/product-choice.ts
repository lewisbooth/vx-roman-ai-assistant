import { parseProductPath } from "./product-path";

/** A customer's carousel selection, never authorization for a store action. */
export interface ProductChoice {
  carouselId: string;
  productId: string;
  title: string;
  productPath: string;
}

export interface ProductChoiceReference extends ProductChoice {
  voiceId?: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseProductChoice(value: unknown): ProductChoice {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a valid product from Roman's carousel.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4 ||
    typeof input.carouselId !== "string" ||
    !uuid.test(input.carouselId) ||
    typeof input.productId !== "string" ||
    input.productId.length > 100 ||
    !/^gid:\/\/shopify\/Product\/\d+$/.test(input.productId) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title !== input.title.trim() ||
    input.title.length > 200 ||
    /[\r\n]/.test(input.title)
  )
    throw new Error("Choose a valid product from Roman's carousel.");
  return {
    carouselId: input.carouselId,
    productId: input.productId,
    title: input.title,
    productPath: parseProductPath(input.productPath),
  };
}

export function parseProductChoiceReference(
  value: unknown,
): ProductChoiceReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid product choice reference.");
  const { voiceId, ...choice } = value as Record<string, unknown>;
  if (
    voiceId !== undefined &&
    (typeof voiceId !== "string" || !uuid.test(voiceId))
  )
    throw new Error("Invalid product choice reference.");
  return {
    ...parseProductChoice(choice),
    ...(voiceId !== undefined ? { voiceId } : {}),
  };
}

export function productChoiceText(choice: ProductChoice): string {
  return `I'd like the ${choice.title}.`;
}
