import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MAX_MESSAGE_LENGTH } from "../../../shared/conversation";
import { StartVoiceButton } from "./VoiceControls";

type ComposerProps = {
  busy: boolean;
  disabled?: boolean;
  hidden?: boolean;
  error: string | null;
  onClearError: () => void;
  onSend: (message: string) => Promise<void>;
  onStartVoice?: () => Promise<void>;
};

export function Composer({
  busy,
  disabled = false,
  hidden = false,
  error,
  onClearError,
  onSend,
  onStartVoice,
}: ComposerProps) {
  const id = useId();
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState<string>();
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = busy || disabled || sending;
  const displayedError = error || sendError;

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input || hidden) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }, [message, hidden]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || busy || disabled || hidden || submitting.current) return;
    // Focus during the user's submission, never after the network response: a
    // later completion must not steal focus from another control or voice mode.
    textarea.current?.focus({ preventScroll: true });
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
    <div className="roman-composer" hidden={hidden && !displayedError}>
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
      <form
        hidden={hidden}
        onSubmit={(event) => void submit(event)}
        aria-busy={pending}
      >
        <label htmlFor={id} className="sr-only">
          Message Roman
        </label>
        <div className="roman-composer-field">
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
            disabled={disabled || hidden}
            readOnly={pending}
          />
          <button
            type="submit"
            className="roman-composer-action roman-send-button"
            aria-label="Send"
            disabled={pending || !message.trim()}
          >
            <span className="roman-action-label" aria-hidden="true">
              Send
            </span>
            <span className="roman-action-icon" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m21 3-6.5 18-4-7.5L3 9.5 21 3Z" />
                <path d="m10.5 13.5 5-5" />
              </svg>
            </span>
          </button>
        </div>
        {onStartVoice && (
          <div className="roman-composer-voice">
            <StartVoiceButton onStart={onStartVoice} disabled={pending} />
          </div>
        )}
      </form>
    </div>
  );
}
