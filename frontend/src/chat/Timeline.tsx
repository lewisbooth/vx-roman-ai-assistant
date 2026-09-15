import type { ConversationMessage } from "../../../shared/conversation";

export function Timeline({
  messages,
}: {
  messages: readonly ConversationMessage[];
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
          <span className="sr-only">
            {message.role === "user" ? "You" : "Roman"}:
          </span>
          <div className="roman-message-parts">
            {message.parts.map((part, index) => (
              <p key={index} className="roman-message-text">
                {part.text}
              </p>
            ))}
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
