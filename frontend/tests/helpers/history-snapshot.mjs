/** Compose bounded-wire metadata for UI/transport fixtures that create message arrays. */
export function historySnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const entries = snapshot.messages.map((message, index) => ({
    sequence: message.sequence ?? index,
    message,
  }));
  return {
    ...snapshot,
    history: {
      start: 0,
      end: entries.length ? Math.max(...entries.map((entry) => entry.sequence)) + 1 : 0,
      before: null,
      entries,
    },
    historyUpdates: [],
  };
}
