import { useId, useLayoutEffect, useRef, useState } from "react";
import type { QuestionPart } from "../../../shared/questions";

export function Question({
  part,
  active,
  disabled,
  voice,
  onAnswer,
}: {
  part: QuestionPart;
  active: boolean;
  disabled: boolean;
  voice: boolean;
  onAnswer: (part: QuestionPart, answer: string) => Promise<void>;
}) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const sending = useRef(false);
  const clicked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useLayoutEffect(() => {
    if (!active && clicked.current) {
      text.current?.focus({ preventScroll: true });
      clicked.current = false;
    }
  }, [active]);

  async function answer(value: string) {
    if (!active || disabled || sending.current) return;
    sending.current = true;
    clicked.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onAnswer(part, value);
    } catch (cause) {
      clicked.current = false;
      setError(
        cause instanceof Error
          ? cause.message
          : "Your answer could not be sent. Please try again.",
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  const question = (
    <p ref={text} id={id} tabIndex={-1} className="roman-message-text">
      {part.question}
    </p>
  );
  if (!active) return question;
  return (
    <section
      className="roman-question"
      aria-labelledby={id}
      aria-busy={pending}
    >
      {question}
      <div className="roman-question-answers">
        {part.answers.map((value) => (
          <button
            key={value}
            type="button"
            disabled={disabled || pending}
            onClick={() => void answer(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <p className="roman-question-hint">
        {voice
          ? "Reply aloud, or choose an answer to switch to text."
          : "Or reply in your own words."}
      </p>
      {error && (
        <p role="alert" className="roman-chat-error">
          {error}
        </p>
      )}
    </section>
  );
}
