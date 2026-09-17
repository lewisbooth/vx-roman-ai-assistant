import type { ConversationMessage } from "../../../shared/conversation";
import type { VoiceCaptionPart } from "../../../shared/voice";
import { voiceCaptionText } from "../../../shared/voice-transcript";

/** Customer display only. The widget owns the question; stored speech stays exact. */
export function voiceQuestionCaptions(
  messages: readonly ConversationMessage[],
): Map<VoiceCaptionPart, string> {
  const entries = messages.flatMap((message) =>
    message.parts.map((part) => ({ part, role: message.role })),
  );
  const captions = new Map<VoiceCaptionPart, string>();
  for (const { part } of entries)
    if (part.type === "voice") captions.set(part, voiceCaptionText(part.text));

  for (const [index, { part: question }] of entries.entries()) {
    if (question.type !== "question" || !question.voiceReply) continue;
    const candidates: VoiceCaptionPart[] = [];
    for (const direction of [-1, 1]) {
      const side: VoiceCaptionPart[] = [];
      for (
        let next = index + direction;
        next >= 0 && next < entries.length;
        next += direction
      ) {
        const { role, part } = entries[next];
        if (
          role === "user" ||
          part.type === "question" ||
          part.type === "text" ||
          part.type === "page_view" ||
          part.type === "navigation"
        )
          break;
        if (part.type !== "voice" || role !== "assistant") continue;
        if (direction < 0 && part.voiceId !== question.voiceReply.voiceId)
          break;
        side.push(part);
      }
      candidates.push(...(direction < 0 ? side.reverse() : side));
    }

    // A pending question can be spoken again after voice restarts. Keep each
    // session separate, and never join speech across a customer turn or question.
    const groups: VoiceCaptionPart[][] = [];
    for (const part of candidates) {
      const previous = groups.at(-1);
      if (previous?.[0].voiceId === part.voiceId) previous.push(part);
      else groups.push([part]);
    }
    for (const group of groups)
      removeQuestion(group, question.question, captions);
  }
  return captions;
}

function removeQuestion(
  parts: VoiceCaptionPart[],
  question: string,
  captions: Map<VoiceCaptionPart, string>,
) {
  const phrase = question
    .trim()
    .replace(/[?!.]+$/u, "")
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  if (!phrase) return;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${phrase}(?:[?!.](?=\\s|$)|$)`,
    "giu",
  );
  let joined = "";
  const ranges = parts.map((part) => {
    if (joined) joined += " ";
    const text = captions.get(part)!;
    const start = joined.length;
    joined += text;
    return { part, text, start, end: joined.length };
  });
  const matches = [...joined.matchAll(pattern)].reverse();
  if (!matches.length) return;
  for (const { part, text, start, end } of ranges) {
    let display = text;
    for (const match of matches) {
      const from = Math.max(start, match.index);
      const to = Math.min(end, match.index + match[0].length);
      if (from < to)
        display = display.slice(0, from - start) + display.slice(to - start);
    }
    // Slices run right-to-left without changing the original character offsets.
    captions.set(part, voiceCaptionText(display));
  }
}
