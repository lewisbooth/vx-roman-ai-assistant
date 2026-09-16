import type { ConversationMessage } from "../../../shared/conversation";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { ProductCards } from "./ProductCards";
import { GuideCards } from "./GuideCards";
import { RichText } from "./RichText";
import { StorefrontLink } from "./StorefrontLink";
import { Question } from "./Question";
import type { QuestionPart } from "../../../shared/questions";
import { VOICE_EVENT_LABELS } from "../../../shared/voice";
import { voiceCaptionText } from "../../../shared/voice-transcript";

export function Timeline({
  messages,
  session,
  navigation,
  onContentChange,
  activeQuestionId,
  questionDisabled = false,
  voice = false,
  onAnswer,
}: {
  messages: readonly ConversationMessage[];
  session: ConversationClient;
  navigation: StorefrontNavigation;
  onContentChange: () => void;
  activeQuestionId?: string;
  questionDisabled?: boolean;
  voice?: boolean;
  onAnswer?: (part: QuestionPart, answer: string) => Promise<void>;
}) {
  // Keep the current question below every widget and later journey event.
  // Stable row IDs retain the question when its buttons retire after a reply.
  const rows = messages.flatMap((message) => {
    const questions = message.parts.filter((part) => part.type === "question");
    const parts = message.parts
      .filter((part) => part.type !== "question" && part.type !== "page_view")
      .filter((part) => part.type !== "voice" || voiceCaptionText(part.text));
    return [
      ...(parts.length || message.status !== "complete"
        ? [{ ...message, parts }]
        : []),
      ...questions.map((part) => ({
        ...message,
        id: `${message.id}:question:${part.invocationId}`,
        role: "assistant" as const,
        parts: [part],
      })),
    ];
  });
  const activeRow = rows.findIndex((row) =>
    row.parts.some(
      (part) =>
        part.type === "question" && part.invocationId === activeQuestionId,
    ),
  );
  if (activeRow >= 0) rows.push(...rows.splice(activeRow, 1));
  return (
    <ol
      className="roman-timeline"
      role="log"
      aria-label="Conversation with Roman"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {rows.map((message) => (
        <li
          key={message.id}
          className={`roman-message roman-message-${message.role}`}
        >
          {message.role !== "context" && (
            <span className="sr-only">
              {message.role === "user" ? "You" : "Roman"}:
            </span>
          )}
          <div className="roman-message-parts">
            {message.parts.map((part, index) => {
              if (part.type === "question")
                return (
                  <Question
                    key={part.invocationId}
                    part={part}
                    active={
                      !!onAnswer && part.invocationId === activeQuestionId
                    }
                    disabled={questionDisabled}
                    voice={voice}
                    onAnswer={onAnswer!}
                  />
                );
              if (part.type === "text")
                return message.role === "assistant" ? (
                  <RichText
                    key={index}
                    text={part.text}
                    navigation={navigation}
                  />
                ) : (
                  <p key={index} className="roman-message-text">
                    {part.text}
                  </p>
                );
              if (part.type === "navigation")
                return (
                  <p
                    key={index}
                    className="roman-inline-event roman-navigation"
                  >
                    Roman navigated to{" "}
                    <StorefrontLink url={part.path} navigation={navigation}>
                      {part.title || part.path}
                    </StorefrontLink>
                  </p>
                );
              if (part.type === "cart_added")
                return (
                  <p
                    key={index}
                    className="roman-inline-event roman-cart-added"
                  >
                    Roman added {part.product.title} to your cart
                    {part.product.measurements &&
                      ` at ${part.product.measurements.width} x ${part.product.measurements.height}${part.product.measurements.unit}`}{" "}
                    <StorefrontLink url="/cart" navigation={navigation}>
                      View Cart
                    </StorefrontLink>
                  </p>
                );
              if (part.type === "voice_event")
                return (
                  <p
                    key={index}
                    className="roman-inline-event roman-voice-event"
                  >
                    {VOICE_EVENT_LABELS[part.event]}
                  </p>
                );
              if (part.type === "voice")
                return (
                  <div key={index} className="roman-voice-caption">
                    <span className="roman-voice-label">Voice</span>
                    <p className="roman-message-text">
                      {voiceCaptionText(part.text)}
                    </p>
                  </div>
                );
              if (part.type === "guides")
                return <GuideCards key={part.invocationId} part={part} />;
              return (
                <ProductCards
                  key={part.invocationId}
                  productIds={part.productIds}
                  session={session}
                  navigation={navigation}
                  onContentChange={onContentChange}
                />
              );
            })}
          </div>
          {message.status === "failed" && (
            <p className="roman-chat-error">
              {message.error ||
                "Roman could not finish this reply. Please try again."}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
