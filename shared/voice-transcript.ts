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

/** Display grouping only: captions are observations, not completed user turns. */
export function groupVoiceTranscript(
  fragments: readonly VoiceTranscriptFragment[],
): VoiceTranscriptGroup[] {
  const groups: VoiceTranscriptGroup[] = [];
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
      lastFragment.sequence + 1 === fragment.sequence &&
      fragment.startMs >= previous.startMs &&
      fragment.startMs <= previous.endMs + 750
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
