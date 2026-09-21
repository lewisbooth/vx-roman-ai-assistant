import type { ConversationMessage } from "../../../shared/conversation";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { ProductCards } from "./ProductCards";
import { RichText } from "./RichText";
import { StorefrontLink } from "./StorefrontLink";
import { Question } from "./Question";
import type { QuestionPart } from "../../../shared/questions";
import { VOICE_EVENT_LABELS } from "../../../shared/voice";
import { voiceCaptionText } from "../../../shared/voice-transcript";
import type { CatalogProduct } from "../../../shared/catalog";
import { productChoiceText } from "../../../shared/product-choice";

export function Timeline({
  messages,
  session,
  navigation,
  onContentChange,
  activeQuestionId,
  questionDisabled = false,
  productsDisabled = false,
  voice = false,
  onAnswer,
  onChooseProduct,
}: {
  messages: readonly ConversationMessage[];
  session: ConversationClient;
  navigation: StorefrontNavigation;
  onContentChange: () => void;
  activeQuestionId?: string;
  questionDisabled?: boolean;
  productsDisabled?: boolean;
  voice?: boolean;
  onAnswer?: (part: QuestionPart, answer: string) => Promise<void>;
  onChooseProduct?: (
    carouselId: string,
    product: CatalogProduct,
  ) => Promise<void>;
}) {
  // Keep the current question below every widget and later journey event.
  // Text questions stay visible as history. Voice questions own controls only: recorded
  // captions own spoken history, even when speech was interrupted or absent.
  const rows = messages.flatMap((message) => {
    const questions = message.parts.filter((part) => part.type === "question");
    const parts = message.parts
      .filter(
        (part) =>
          part.type !== "question" &&
          part.type !== "page_view" &&
          part.type !== "navigation" &&
          part.type !== "guides",
      )
      .filter((part) => part.type !== "voice" || voiceCaptionText(part.text));
    return [
      ...(parts.length || message.status === "failed"
        ? [{ kind: "message" as const, id: message.id, message, parts }]
        : []),
      ...questions.map((part) => ({
        kind: "question" as const,
        id: `${message.id}:question:${part.invocationId}`,
        part,
      })),
    ];
  });
  const activeRow = rows.findIndex(
    (row) =>
      row.kind === "question" && row.part.invocationId === activeQuestionId,
  );
  if (activeRow >= 0) rows.push(...rows.splice(activeRow, 1));
  let lastCustomer = -1;
  rows.forEach((row, index) => {
    if (row.kind === "message" && row.message.role === "user")
      lastCustomer = index;
  });
  return (
    <ol
      className="roman-timeline"
      role="log"
      aria-label="Conversation with Roman"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {rows.map((row, rowIndex) => {
        if (row.kind === "question")
          return (
            <Question
              key={row.id}
              part={row.part}
              active={!!onAnswer && row.part.invocationId === activeQuestionId}
              disabled={questionDisabled}
              voice={voice}
              onAnswer={onAnswer!}
              currentTurn={rowIndex >= lastCustomer}
            />
          );
        const { message, parts } = row;
        return (
          <li
            key={row.id}
            className={`roman-message roman-message-${message.role}`}
            data-current-turn={rowIndex >= lastCustomer ? "true" : undefined}
          >
            {message.role !== "context" && (
              <span className="sr-only">
                {message.role === "user" ? "You" : "Roman"}:
              </span>
            )}
            <div className="roman-message-parts">
              {parts.map((part, index) => {
                if (part.type === "text")
                  return message.role === "assistant" ? (
                    <RichText
                      key={index}
                      text={part.text}
                      navigation={navigation}
                      pending={message.status === "pending"}
                    />
                  ) : (
                    <p key={index} className="roman-message-text">
                      {part.productChoice
                        ? productChoiceText(part.productChoice)
                        : part.text}
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
                if (part.type === "cart_sample_added")
                  return (
                    <p
                      key={index}
                      className="roman-inline-event roman-cart-added"
                    >
                      Roman added a sample of {part.sample.title} to your cart{" "}
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
                return (
                  <ProductCards
                    key={part.invocationId}
                    productIds={part.productIds}
                    carouselId={part.invocationId}
                    session={session}
                    onChoose={onChooseProduct}
                    disabled={productsDisabled || message.status === "failed"}
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
        );
      })}
    </ol>
  );
}
