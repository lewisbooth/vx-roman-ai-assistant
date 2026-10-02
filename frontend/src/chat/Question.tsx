import { useId, useLayoutEffect, useRef, useState } from "react";
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
  currentTurn = false,
  revealPending = false,
  historySequence,
  historyId,
}: {
  part: QuestionPart;
  active: boolean;
  disabled: boolean;
  voice: boolean;
  onAnswer: (part: QuestionPart, answer: string) => Promise<void>;
  currentTurn?: boolean;
  /** Reserve the actual wrapped panel without exposing unanswered controls early. */
  revealPending?: boolean;
  historySequence?: number;
  historyId?: string;
}) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const panel = useRef<HTMLElement>(null);
  const sending = useRef(false);
  const submittedFocus = useRef<Element | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [measurementValue, setMeasurementValue] = useState("");
  const controlsDisabled = disabled || revealPending;

  useLayoutEffect(() => {
    if (!active && submittedFocus.current) {
      const paragraph = text.current;
      const root = paragraph?.getRootNode() as
        Document | ShadowRoot | undefined;
      const focused = root?.activeElement;
      // Keep a keyboard user's place when the submitted control disappears,
      // without taking focus back from the composer or another control.
      if (
        paragraph &&
        (!focused ||
          focused === paragraph.ownerDocument.body ||
          focused === submittedFocus.current)
      )
        paragraph.focus({ preventScroll: true });
      submittedFocus.current = null;
    }
  }, [active]);

  async function answer(value: string) {
    if (!active || controlsDisabled || sending.current) return;
    sending.current = true;
    const root = panel.current?.getRootNode() as
      Document | ShadowRoot | undefined;
    const focused = root?.activeElement;
    submittedFocus.current =
      focused && panel.current?.contains(focused) ? focused : null;
    setPending(true);
    setError(undefined);
    setInvalid(false);
    try {
      await onAnswer(part, value);
    } catch (cause) {
      submittedFocus.current = null;
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
  // The active card owns its question. Once answered, leave one plain-text
  // history entry. Voice captions alone own spoken history.
  const transcript = !part.voiceReply && !active && (
    <p
      ref={text}
      id={id}
      tabIndex={-1}
      className="roman-message-text"
      style={{ outline: "none" }}
    >
      {part.question}
    </p>
  );
  const controls = active && (
    <section
      ref={panel}
      className="roman-action-panel roman-question"
      aria-labelledby={`${id}-prompt`}
      aria-busy={pending}
      aria-live={voice ? "off" : "polite"}
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
              if (controlsDisabled || sending.current) return;
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
                  disabled={controlsDisabled}
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
              <button type="submit" disabled={controlsDisabled || pending}>
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
              disabled={controlsDisabled || pending}
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
      data-history-sequence={historySequence}
      data-history-id={historyId}
      className="roman-message roman-message-assistant"
      data-current-turn={currentTurn ? "true" : undefined}
      data-active-question={active || undefined}
      data-question-reveal-pending={revealPending || undefined}
      aria-hidden={revealPending || undefined}
      {...(revealPending ? { inert: "" } : {})}
    >
      <span className="sr-only">Roman:</span>
      <div className="roman-message-parts">
        {transcript}
        {controls}
      </div>
    </li>
  );
}
