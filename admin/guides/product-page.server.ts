import type { ConversationMessage } from "../../shared/conversation";
import { parseProductPath } from "../../shared/product-path";

/** Canonical identity from validated storefront observations, never model text. */
export function productPagePath(path: string): string | undefined {
  const match =
    /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(
      path,
    );
  if (!match) return;
  try {
    return parseProductPath(`/products/${match[1]}`);
  } catch {
    return;
  }
}

/** Duplicate observations retain the episode; leaving and returning starts another. */
export function latestProductPage(
  messages: readonly ConversationMessage[],
): { productPath: string; pageId: string } | undefined {
  let current: { productPath: string; pageId: string } | undefined;
  for (const message of messages) {
    if (message.role !== "context" || message.status !== "complete") continue;
    for (const part of message.parts) {
      if (part.type !== "page_view" && part.type !== "navigation") continue;
      const productPath = productPagePath(part.path);
      if (!productPath) current = undefined;
      else if (current?.productPath !== productPath)
        current = { productPath, pageId: message.id };
    }
  }
  return current;
}
