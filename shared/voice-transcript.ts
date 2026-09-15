/** Exact captions received by the server from the voice provider. */
export interface VoiceTranscriptFragment {
  id: string;
  voiceId: string;
  providerEventId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  createdAt: string;
}

export interface VoiceTranscriptGroup {
  /** The first fragment's ID remains stable when another caption joins it. */
  id: string;
  voiceId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  createdAt: string;
  fragments: VoiceTranscriptFragment[];
}

const maxCaptionPauseMs = 3000;

function adjacentInTimeline(
  previous: number,
  current: number,
  hiddenSequences: ReadonlySet<number>,
): boolean {
  if (current <= previous || current - previous > hiddenSequences.size + 1)
    return false;
  for (let sequence = previous + 1; sequence < current; sequence++) {
    if (!hiddenSequences.has(sequence)) return false;
  }
  return true;
}

/** Display grouping only: captions are observations, not completed user turns. */
export function groupVoiceTranscript(
  fragments: readonly VoiceTranscriptFragment[],
  hiddenSequences: readonly number[] = [],
  breakBeforeSequences: readonly number[] = [],
): VoiceTranscriptGroup[] {
  const groups: VoiceTranscriptGroup[] = [];
  const hidden = new Set(hiddenSequences);
  const ordered = [...fragments].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const fragment of ordered) {
    const previous = groups.at(-1);
    const lastFragment = previous?.fragments.at(-1);
    if (
      previous &&
      lastFragment &&
      previous.voiceId === fragment.voiceId &&
      previous.role === fragment.role &&
      adjacentInTimeline(lastFragment.sequence, fragment.sequence, hidden) &&
      !breakBeforeSequences.some(
        (sequence) =>
          sequence > lastFragment.sequence && sequence <= fragment.sequence,
      ) &&
      fragment.startMs >= previous.startMs &&
      // Natural pauses within speech should not create separate chat bubbles.
      fragment.startMs <= previous.endMs + maxCaptionPauseMs
    ) {
      previous.fragments.push(fragment);
      // Provider deltas may split a word. Never infer spaces or completed intent.
      previous.text += fragment.text;
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      groups.push({ ...fragment, fragments: [fragment] });
    }
  }
  return groups;
}
