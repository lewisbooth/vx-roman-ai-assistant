type HistoryAnchor = {
  id?: string;
  sequence?: number;
  top: number;
  bottom: number;
  height: number;
  scrollTop: number;
};

export function captureHistoryAnchor(scroll: HTMLElement): HistoryAnchor {
  const top = scroll.getBoundingClientRect().top;
  const row = [
    ...scroll.querySelectorAll<HTMLElement>("[data-history-sequence]"),
  ].find((element) => element.getBoundingClientRect().bottom > top);
  return {
    ...(row ? { id: row.dataset.historyId, sequence: Number(row.dataset.historySequence) } : {}),
    top: row ? row.getBoundingClientRect().top - top : 0,
    bottom: row ? row.getBoundingClientRect().bottom - top : 0,
    height: scroll.scrollHeight,
    scrollTop: scroll.scrollTop,
  };
}

export function restoreHistoryAnchor(
  scroll: HTMLElement,
  anchor: HistoryAnchor,
) {
  const candidates = [...scroll.querySelectorAll<HTMLElement>("[data-history-sequence]")];
  const row = candidates.find(element => anchor.id && element.dataset.historyId === anchor.id) ?? (
    anchor.sequence === undefined
      ? undefined
      : [
          ...scroll.querySelectorAll<HTMLElement>("[data-history-sequence]"),
        ].find(
          (element) =>
            Number(element.dataset.historySequence) <= anchor.sequence! &&
            Number(
              element.dataset.historyEnd ?? element.dataset.historySequence,
            ) >= anchor.sequence!,
        ));
  const mergedPrefix = row && Number(row.dataset.historySequence) < (anchor.sequence ?? 0);
  scroll.scrollTop = row
    ? scroll.scrollTop +
      (mergedPrefix ? row.getBoundingClientRect().bottom : row.getBoundingClientRect().top) -
      scroll.getBoundingClientRect().top -
      (mergedPrefix ? anchor.bottom : anchor.top)
    : anchor.scrollTop + scroll.scrollHeight - anchor.height;
}
