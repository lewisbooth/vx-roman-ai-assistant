import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { MAX_MESSAGE_LENGTH } from "../../../shared/conversation";
import { StartVoiceButton } from "./VoiceControls";

type ComposerProps = {
  busy: boolean;
  disabled?: boolean;
  voiceControls?: ReactNode;
  queuedMessages?: ReactNode;
  error: string | null;
  onClearError: () => void;
  onSend: (message: string) => Promise<void>;
  onStartVoice?: () => Promise<void>;
};

export function Composer({
  busy,
  disabled = false,
  voiceControls,
  queuedMessages,
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
  const draftRevision = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sendDisabled = disabled || sending;
  const displayedError = error || sendError;
  const sendLabel = busy ? "Queue message" : "Send";

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }, [message]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || disabled || submitting.current) return;
    // Focus during the user's submission, never after the network response: a
    // later completion must not steal focus from another control or voice mode.
    textarea.current?.focus({ preventScroll: true });
    submitting.current = true;
    const submittedRevision = draftRevision.current;
    setSending(true);
    setSendError(undefined);
    try {
      await onSend(text);
      // Enqueueing is immediate, but a completion must still leave any newer
      // typing intact. Network delivery belongs to the queue owner.
      if (draftRevision.current === submittedRevision) setMessage("");
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
      {queuedMessages}
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
      <form onSubmit={(event) => void submit(event)} aria-busy={sending}>
        <label htmlFor={id} className="sr-only">
          Message Roman
        </label>
        <div className="roman-composer-field">
          <textarea
            ref={textarea}
            id={id}
            value={message}
            onChange={(event) => {
              draftRevision.current++;
              setMessage(event.target.value);
            }}
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
            placeholder="Ask Roman…"
            disabled={disabled}
          />
          <button
            type="submit"
            className="roman-composer-action roman-send-button"
            aria-label={sendLabel}
            disabled={sendDisabled || !message.trim()}
          >
            <span className="roman-action-label" aria-hidden="true">
              {sendLabel}
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
        {voiceControls}
        {onStartVoice && (
          <div className="roman-composer-voice">
            <StartVoiceButton
              onStart={onStartVoice}
              disabled={disabled || sending || busy}
            />
          </div>
        )}
      </form>
    </div>
  );
}
