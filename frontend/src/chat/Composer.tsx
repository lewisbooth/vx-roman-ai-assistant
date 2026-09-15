import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MAX_MESSAGE_LENGTH } from "../../../shared/conversation";

type ComposerProps = {
  busy: boolean;
  error: string | null;
  onClearError: () => void;
  onSend: (message: string) => Promise<void>;
};

export function Composer({ busy, error, onClearError, onSend }: ComposerProps) {
  const id = useId();
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState<string>();
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = busy || sending;
  const displayedError = error || sendError;

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }, [message]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || busy || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setSendError(undefined);
    try {
      await onSend(text);
      setMessage("");
    } catch (cause) {
      setSendError(
        cause instanceof Error
          ? cause.message
          : "Your message could not be sent.",
      );
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  return (
    <div className="roman-composer">
      {displayedError && (
        <p className="roman-chat-error" role="alert">
          {displayedError}
          {error && (
            <button
              type="button"
              className="roman-chat-retry"
              onClick={() => {
                setSendError(undefined);
                onClearError();
              }}
            >
              Retry connection
            </button>
          )}
        </p>
      )}
      <form onSubmit={(event) => void submit(event)} aria-busy={pending}>
        <label htmlFor={id} className="sr-only">
          Message Roman
        </label>
        <textarea
          ref={textarea}
          id={id}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Ask Roman anything..."
          disabled={pending}
        />
        <button type="submit" disabled={pending || !message.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
