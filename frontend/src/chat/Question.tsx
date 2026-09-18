import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatMeasurementAnswer,
  MAX_QUESTION_ANSWER_LENGTH,
  type QuestionPart,
} from "../../../shared/questions";

export function Question({
  part,
  active,
  disabled,
  voice,
  onAnswer,
  dock,
  currentTurn = false,
}: {
  part: QuestionPart;
  active: boolean;
  disabled: boolean;
  voice: boolean;
  onAnswer: (part: QuestionPart, answer: string) => Promise<void>;
  dock?: HTMLElement | null;
  currentTurn?: boolean;
}) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const sending = useRef(false);
  const clicked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [measurementValue, setMeasurementValue] = useState("");

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
    setInvalid(false);
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

  const measurement = part.measurement;
  // Keep the component mounted when an optimistic voice answer retires it.
  // Failed submissions can restore the numeric draft and error without a
  // manufactured transcript row or a separate question-state cache.
  if (!active && part.voiceReply) return null;
  // The same structured question owns the transcript and its current controls.
  // Keep text history in place while the answer panel comes and goes. Voice
  // captions alone own spoken history, so their widgets never add prose here.
  const transcript = !part.voiceReply && (
    <p ref={text} id={id} tabIndex={-1} className="roman-message-text">
      {part.question}
    </p>
  );
  const controls = active && (
    <section
      className="roman-action-panel roman-question"
      aria-labelledby={`${id}-prompt`}
      aria-busy={pending}
    >
      <p id={`${id}-prompt`} className="roman-message-text">
        {part.question}
      </p>
      {measurement ? (
        <>
          {measurement.instructions && (
            <p
              id={`${id}-instructions`}
              className="roman-measurement-instructions"
            >
              {measurement.instructions}
            </p>
          )}
          <form
            className="roman-measurement-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || sending.current) return;
              try {
                void answer(formatMeasurementAnswer(part, measurementValue));
              } catch (cause) {
                setInvalid(true);
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Enter your measurement or reply.",
                );
              }
            }}
          >
            <div className="roman-action-buttons roman-measurement-entry">
              <div className="roman-measurement-field">
                <input
                  id={`${id}-measurement`}
                  type="text"
                  aria-label={part.question}
                  maxLength={
                    MAX_QUESTION_ANSWER_LENGTH - measurement.label.length - 2
                  }
                  required
                  value={measurementValue}
                  disabled={disabled}
                  readOnly={pending}
                  aria-invalid={invalid}
                  aria-describedby={
                    [
                      measurement.instructions && `${id}-instructions`,
                      error && `${id}-error`,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  onChange={(event) => {
                    setMeasurementValue(event.target.value);
                    setError(undefined);
                    setInvalid(false);
                  }}
                />
                {measurement.unit && (
                  <span aria-hidden="true">{measurement.unit}</span>
                )}
              </div>
              <button type="submit" disabled={disabled || pending}>
                Submit
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="roman-action-buttons">
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
      )}
      <p className="roman-question-hint">
        {voice
          ? measurement
            ? "Reply aloud or enter your measurement."
            : "Reply aloud or choose an answer."
          : "Or reply in your own words."}
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="roman-chat-error">
          {error}
        </p>
      )}
    </section>
  );
  return (
    <li
      className="roman-message roman-message-assistant"
      data-current-turn={currentTurn ? "true" : undefined}
      hidden={!!part.voiceReply && active && !!dock}
    >
      <span className="sr-only">Roman:</span>
      <div className="roman-message-parts">
        {transcript}
        {controls && dock ? createPortal(controls, dock) : controls}
      </div>
    </li>
  );
}
