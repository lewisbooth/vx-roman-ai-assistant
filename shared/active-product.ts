import type { ConversationSnapshot } from "./conversation";

/** Only a completed Roman PDP navigation selects the active blind. */
export function activeProduct(
  conversation:
    | (Pick<ConversationSnapshot, "status" | "messages"> &
        Partial<Pick<ConversationSnapshot, "current">>)
    | null
    | undefined,
): { path: string; title: string } | undefined {
  if (conversation?.status !== "active") return;
  if (conversation.current)
    return conversation.current.activeProduct ?? undefined;
  for (const message of [...conversation.messages].reverse()) {
    if (message.status !== "complete" || message.role !== "context") continue;
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "navigation") continue;
      const match = /(?:^|\/)products\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(
        part.path,
      );
      if (match) return { path: `/products/${match[1]}`, title: part.title };
    }
  }
}
