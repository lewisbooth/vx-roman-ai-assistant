import type {
  ConversationMessage,
  ConversationPart,
  ConversationHistoryEntry,
} from "./conversation";
import { groupVoiceTranscript } from "./voice-transcript";
import { isCustomerMediaIntent } from "./visualizations";

function voiceAssociation(part: ConversationPart) {
  return part.type === "products" ||
    part.type === "guides" ||
    part.type === "question"
    ? part.voiceReply
    : undefined;
}

function isBackgroundObservation(message: ConversationMessage): boolean {
  return (
    message.role === "context" &&
    message.status !== "failed" &&
    message.parts.length > 0 &&
    message.parts.every(
      (part) =>
        part.type === "page_view" ||
        part.type === "navigation" ||
        (part.type === "media" && !isCustomerMediaIntent(part)),
    )
  );
}

export function projectConversationTimeline(
  entries: readonly ConversationHistoryEntry[],
): ConversationMessage[] {
  const ordered = [...entries].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const rows = ordered.flatMap((entry) =>
    "message" in entry
      ? [
          {
            sequence: entry.sequence,
            endSequence: entry.sequence,
            message: entry.message,
          },
        ]
      : [],
  );
  const voiceTranscripts = ordered.flatMap((entry) =>
    "caption" in entry ? [entry.caption] : [],
  );
  const voicePlacements = rows.flatMap((row) =>
    row.message.parts.flatMap((part) => {
      const reply = voiceAssociation(part);
      return reply ? [reply] : [];
    }),
  );
  const captionBoundaries = voicePlacements.flatMap((reply) => {
    const nextMessage = rows.find(
      (row) =>
        row.sequence >= reply.afterSequence &&
        !isBackgroundObservation(row.message),
    );
    if (!nextMessage) return [];
    const responseStartMs = voiceTranscripts.reduce(
      (startMs, fragment) =>
        fragment.voiceId === reply.voiceId &&
        fragment.role === "assistant" &&
        fragment.sequence >= reply.afterSequence &&
        fragment.sequence < nextMessage.sequence
          ? Math.min(startMs, fragment.startMs)
          : startMs,
      Infinity,
    );
    // A spoken reply already separates the old response from the next one.
    // Its delegation row can arrive after Roman starts acknowledging it (even
    // between "Alright," and "the kitchen"); that bookkeeping is not another
    // speech boundary. Keep the boundary when no new customer input is known.
    if (
      nextMessage.message.role === "context" &&
      nextMessage.message.status !== "failed" &&
      (nextMessage.message.parts.length === 0 ||
        nextMessage.message.parts.some(voiceAssociation)) &&
      voiceTranscripts.some(
        (fragment) =>
          fragment.voiceId === reply.voiceId &&
          fragment.role === "user" &&
          fragment.sequence >= reply.afterSequence &&
          fragment.sequence < nextMessage.sequence &&
          // ASR can arrive late: delivery after completion alone does not make
          // it a new turn. The customer must speak after this response begins.
          fragment.startMs > responseStartMs,
      )
    )
      return [];
    // Other messages/delegations end this response. Completion itself may
    // happen midway through Roman's sentence; the projector handles it below.
    return [nextMessage.sequence];
  });
  const captions = groupVoiceTranscript(
    voiceTranscripts.map((fragment) => {
      if (fragment.role !== "user" && fragment.role !== "assistant")
        throw new Error("Invalid stored voice caption role.");
      return {
        ...fragment,
        role: fragment.role,
        createdAt: fragment.createdAt,
      };
    }),
    // Reserved result rows and background page changes do not interrupt speech.
    // Customer input and visible events remain boundaries; the next delegation
    // adds one only when customer speech has not already separated the replies.
    rows
      .filter(
        (row) =>
          (row.message.parts.length === 0 && row.message.status !== "failed") ||
          isBackgroundObservation(row.message) ||
          row.message.parts.some(
            (part) =>
              voiceAssociation(part) ||
              (part.type === "voice_event" && part.event === "started"),
          ),
      )
      .map((row) => row.sequence),
    captionBoundaries,
    voicePlacements.map((reply) => reply.afterSequence),
  );
  for (const caption of captions)
    rows.push({
      sequence: caption.sequence,
      endSequence: caption.endSequence,
      message: {
        id: caption.id,
        sourceSequence: caption.fragments.reduce(
          (start, fragment) => Math.min(start, fragment.sequence),
          Infinity,
        ),
        sourceEndSequence: caption.fragments.reduce(
          (end, fragment) => Math.max(end, fragment.sequence),
          -Infinity,
        ),
        role: caption.role,
        status: "complete",
        createdAt: caption.createdAt,
        parts: [
          {
            type: "voice",
            version: 1,
            voiceId: caption.voiceId,
            text: caption.text,
            startMs: caption.startMs,
            endMs: caption.endMs,
          },
        ],
      },
    });
  rows.sort((left, right) => left.sequence - right.sequence);
  // Delegation reserves a hidden row before tools run. Place its cards at
  // completion, then beneath the following spoken response as captions arrive.
  // Never cross a customer turn, different voice or another result.
  const positions = new Map<string, number>();
  for (const row of rows) {
    const reply = row.message.parts.map(voiceAssociation).find(Boolean);
    if (!reply || row.message.role !== "context") continue;
    let position = reply.afterSequence - 0.5;
    for (const next of rows) {
      if (next === row || next.endSequence < reply.afterSequence) continue;
      if (isBackgroundObservation(next.message)) continue;
      if (
        next.message.role !== "assistant" ||
        !next.message.parts.every(
          (part) => part.type === "voice" && part.voiceId === reply.voiceId,
        )
      )
        break;
      position = next.endSequence + 0.5;
    }
    positions.set(row.message.id, position);
  }
  // Captions can beat the browser's readiness request to the server. Keep the
  // recorded start before its own speech without changing stored chronology.
  for (const row of rows) {
    const start = row.message.parts.find(
      (part) => part.type === "voice_event" && part.event === "started",
    );
    if (start?.type !== "voice_event") continue;
    const firstCaption = rows.find((candidate) =>
      candidate.message.parts.some(
        (part) => part.type === "voice" && part.voiceId === start.voiceId,
      ),
    );
    positions.set(
      row.message.id,
      Math.min(row.sequence, firstCaption?.sequence ?? row.sequence) - 0.5,
    );
  }
  return rows
    .sort(
      (left, right) =>
        (positions.get(left.message.id) ?? left.sequence) -
        (positions.get(right.message.id) ?? right.sequence),
    )
    .map((row) => ({
      ...row.message,
      sequence: row.sequence,
      endSequence: row.endSequence,
      sourceSequence: row.message.sourceSequence ?? row.sequence,
      sourceEndSequence: row.message.sourceEndSequence ?? row.endSequence,
    }));
}
