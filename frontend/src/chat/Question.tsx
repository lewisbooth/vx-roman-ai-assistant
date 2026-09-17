import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  formatMeasurementAnswer,
  type QuestionPart,
} from "../../../shared/questions";

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

  const question = (
    <p ref={text} id={id} tabIndex={-1} className="roman-message-text">
      {part.question}
    </p>
  );
  const measurement = part.measurement;
  const instructions = measurement && (
    <p id={`${id}-instructions`} className="roman-measurement-instructions">
      {measurement.instructions}
    </p>
  );
  if (!active)
    return (
      <>
        {question}
        {instructions}
        {measurement && (
          <p className="roman-question-hint">
            {measurement.label} ({measurement.unit})
          </p>
        )}
      </>
    );
  return (
    <section
      className="roman-action-panel roman-question"
      aria-labelledby={id}
      aria-busy={pending}
    >
      {question}
      {measurement ? (
        <>
          {instructions}
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
                    : "Enter a number of zero or more.",
                );
              }
            }}
          >
            <label htmlFor={`${id}-measurement`}>
              {measurement.label} ({measurement.unit})
            </label>
            <div className="roman-action-buttons roman-measurement-entry">
              <div className="roman-measurement-field">
                <input
                  id={`${id}-measurement`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  required
                  value={measurementValue}
                  disabled={disabled}
                  readOnly={pending}
                  aria-invalid={invalid}
                  aria-describedby={`${id}-instructions${error ? ` ${id}-error` : ""}`}
                  onChange={(event) => {
                    setMeasurementValue(event.target.value);
                    setError(undefined);
                    setInvalid(false);
                  }}
                />
                <span aria-hidden="true">{measurement.unit}</span>
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
}
