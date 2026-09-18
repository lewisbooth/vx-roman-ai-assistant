import type { QueuedMessage } from "./useMessageQueue";

export function MessageQueue({
  messages,
  onRemove,
  onRetry,
}: {
  messages: QueuedMessage[];
  onRemove: (id: number) => void;
  onRetry: (id: number) => void;
}) {
  const waiting = messages.filter((item) => item.status !== "sending");
  if (!waiting.length) return null;
  return (
    <section className="roman-message-queue" aria-label="Queued messages">
      <span className="roman-queue-heading">
        {waiting.some((item) => item.status === "queued")
          ? "Queued · sends when Roman is ready"
          : "Your message"}
      </span>
      <ol>
        {waiting.map((item) => (
          <li className="roman-queued-message" key={item.id}>
            <div>
              <p>{item.text}</p>
              {item.error && <span role="alert">{item.error}</span>}
            </div>
            {item.status === "failed" && (
              <button type="button" onClick={() => onRetry(item.id)}>
                Retry
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove queued message: ${item.text}`}
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
