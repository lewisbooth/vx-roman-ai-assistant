import type { ConversationMessage } from "../../../shared/conversation";
import type { QuestionPart } from "../../../shared/questions";

/** Journey events do not answer a question; a later customer turn does. */
export function latestQuestion(
  messages: readonly ConversationMessage[],
): QuestionPart | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") return;
    if (message.status !== "complete") continue;
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex--
    ) {
      const part = message.parts[partIndex];
      if (part.type === "question") return part;
    }
  }
}
