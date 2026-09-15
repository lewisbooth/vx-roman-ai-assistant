import type { ConversationMessage } from "../../../shared/conversation";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { ProductCards } from "./ProductCards";
import { GuideCards } from "./GuideCards";
import { RichText } from "./RichText";
import { StorefrontLink } from "./StorefrontLink";

export function Timeline({
  messages,
  session,
  navigation,
  onContentChange,
}: {
  messages: readonly ConversationMessage[];
  session: ConversationClient;
  navigation: StorefrontNavigation;
  onContentChange: () => void;
}) {
  return (
    <ol
      className="roman-timeline"
      role="log"
      aria-label="Conversation with Roman"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((message) => (
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
              if (part.type === "page_view")
                return (
                  <p key={index} className="roman-page-view">
                    Viewed{" "}
                    <StorefrontLink url={part.path} navigation={navigation}>
                      {part.title || part.path}
                    </StorefrontLink>
                  </p>
                );
              if (part.type === "voice")
                return (
                  <div key={index} className="roman-voice-caption">
                    <span className="roman-voice-label">Voice</span>
                    <p className="roman-message-text">{part.text}</p>
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
          {message.status === "pending" && message.parts.length === 0 && (
            <p className="roman-message-status">Roman is thinking…</p>
          )}
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
