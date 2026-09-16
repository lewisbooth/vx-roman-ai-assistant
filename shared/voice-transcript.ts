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
  /** Display positions reuse arrival slots; stored fragment sequences stay exact. */
  sequence: number;
  endSequence: number;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  createdAt: string;
  fragments: VoiceTranscriptFragment[];
}

const maxCaptionPauseMs = 3000;

/** Display only: hide non-speech cues and punctuation orphaned at a group boundary. */
export function voiceCaptionText(text: string): string {
  return text
    .replace(/[\t ]*\[(?:chuckle|breath)\][\t ]*/giu, " ")
    .trim()
    .replace(/^[.,!?;:](?:\s+|$)/u, "");
}

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
  let segment: VoiceTranscriptFragment[] = [];

  function appendSegment() {
    // Input ASR can arrive after Roman's response caption. Both streams carry
    // times on the same Live-session clock, but each speaker's deltas must be
    // appended in delivery order (they may split words and have equal times).
    const users = segment.filter((fragment) => fragment.role === "user");
    const assistants = segment.filter(
      (fragment) => fragment.role === "assistant",
    );
    let userIndex = 0;
    let assistantIndex = 0;
    let previous: VoiceTranscriptGroup | undefined;
    for (const slot of segment) {
      const user = users[userIndex];
      const assistant = assistants[assistantIndex];
      const takeUser =
        user &&
        (!assistant ||
          user.startMs < assistant.startMs ||
          (user.startMs === assistant.startMs &&
            user.sequence < assistant.sequence));
      const fragment = takeUser
        ? users[userIndex++]
        : assistants[assistantIndex++];
      if (
        previous &&
        previous.role === fragment.role &&
        adjacentInTimeline(previous.endSequence, slot.sequence, hidden) &&
        fragment.startMs >= previous.startMs &&
        // Natural pauses within speech should not create separate chat bubbles.
        fragment.startMs <= previous.endMs + maxCaptionPauseMs
      ) {
        previous.fragments.push(fragment);
        previous.text += fragment.text;
        previous.endMs = Math.max(previous.endMs, fragment.endMs);
        previous.endSequence = slot.sequence;
      } else {
        previous = {
          ...fragment,
          sequence: slot.sequence,
          endSequence: slot.sequence,
          fragments: [fragment],
        };
        groups.push(previous);
      }
    }
  }

  for (const fragment of ordered) {
    const previous = segment.at(-1);
    if (
      previous &&
      (previous.voiceId !== fragment.voiceId ||
        !adjacentInTimeline(previous.sequence, fragment.sequence, hidden) ||
        breakBeforeSequences.some(
          (sequence) =>
            sequence > previous.sequence && sequence <= fragment.sequence,
        ))
    ) {
      appendSegment();
      segment = [];
    }
    segment.push(fragment);
  }
  appendSegment();
  return groups;
}
