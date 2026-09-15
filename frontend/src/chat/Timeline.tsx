import type { ConversationMessage } from "../../../shared/conversation";
import type { StorefrontNavigation } from "../navigation/shared";
import type { ConversationClient } from "../session/types";
import { ProductCards } from "./ProductCards";
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
                return (
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
