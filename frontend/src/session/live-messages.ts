import type { ConversationMessage, ConversationSnapshot } from "../../../shared/conversation";

/** Only the latest server snapshot can trigger new-result UI; older pages cannot. */
export function liveSnapshotMessages(snapshot: ConversationSnapshot | null): ConversationMessage[] {
  if (!snapshot) return [];
  return [...snapshot.history.entries, ...snapshot.historyUpdates].flatMap((entry) =>
    "message" in entry ? [entry.message] : [],
  );
}
