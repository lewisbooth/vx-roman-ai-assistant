import type {
  ConversationHistoryEntry,
  ConversationHistoryPage,
  ConversationReadVersion,
} from "../../../shared/conversation";
import { projectConversationTimeline } from "../../../shared/conversation-timeline";

/** Raw records remain the owner; caption groups are rebuilt across page boundaries. */
export function createConversationHistory() {
  const entries = new Map<
    number,
    { entry: ConversationHistoryEntry; version: ConversationReadVersion }
  >();
  let ranges: { start: number; end: number }[] = [];
  return {
    merge(
      page: ConversationHistoryPage,
      version: ConversationReadVersion,
      updates: readonly ConversationHistoryEntry[] = [],
    ) {
      for (const entry of [...page.entries, ...updates]) {
        const old = entries.get(entry.sequence);
        if (
          !old ||
          version.revision > old.version.revision ||
          (version.revision === old.version.revision &&
            version.streamRevision >= old.version.streamRevision)
        )
          entries.set(entry.sequence, { entry, version });
      }
      const ordered = [...ranges, { start: page.start, end: page.end }].sort(
        (left, right) => left.start - right.start,
      );
      ranges = [];
      for (const range of ordered) {
        const previous = ranges.at(-1);
        if (previous && range.start <= previous.end)
          previous.end = Math.max(previous.end, range.end);
        else ranges.push({ ...range });
      }
    },
    get before() {
      // Fill an interrupted polling interval before requesting still older history.
      return ranges.length > 1
        ? ranges.at(-1)!.start
        : ranges[0]?.start || null;
    },
    get hasGap() {
      return ranges.length > 1;
    },
    messages() {
      return projectConversationTimeline(
        [...entries.values()]
          .map(({ entry }) => entry)
          .sort((left, right) => left.sequence - right.sequence),
      ).filter(
        (message) => message.parts.length > 0 || message.status === "failed",
      );
    },
  };
}
