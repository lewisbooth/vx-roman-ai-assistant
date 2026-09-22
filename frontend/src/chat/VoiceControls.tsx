import type { VoiceClientState } from "../../../shared/voice";
import type { ConversationClient } from "../session/types";

export function StartVoiceButton({
  onStart,
  disabled,
}: {
  onStart: () => Promise<void>;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      className="roman-composer-action"
      data-roman-start-voice
      aria-label="Start voice"
      disabled={disabled}
      onClick={() => void onStart().catch(() => undefined)}
    >
      <span className="roman-action-label" aria-hidden="true">
        Start voice
      </span>
      <span className="roman-action-icon" aria-hidden="true">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M3 10v4M7.5 6v12M12 3v18M16.5 6v12M21 10v4" />
        </svg>
      </span>
    </button>
  );
}

export function VoiceControls({
  session,
  voice,
  waiting = false,
}: {
  session: ConversationClient;
  voice: VoiceClientState;
  waiting?: boolean;
}) {
  const running =
    voice.status === "starting" ||
    voice.status === "active" ||
    voice.status === "stopping";
  const needsStop =
    running || (voice.status === "error" && voice.muted) || waiting;
  const active = voice.status === "active" && !waiting;
  const status = waiting
    ? "Voice is active in another page."
    : voice.status === "starting"
      ? "Connecting voice…"
      : voice.status === "stopping"
        ? "Ending voice…"
        : voice.muted
          ? "Microphone muted"
          : "Voice is on";
  if (!needsStop) return null;
  return (
    <div className="roman-voice-bar">
      {active ? (
        <div
          className="roman-voice-waveform"
          aria-hidden="true"
          data-muted={voice.muted || undefined}
        >
          {Array.from({ length: 39 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      ) : (
        <span className="roman-voice-notice" role="status">
          {status}
        </span>
      )}
      <button
        type="button"
        className="roman-composer-action"
        aria-label="End voice"
        disabled={voice.status === "stopping"}
        onClick={() => void session.stopVoice().catch(() => undefined)}
      >
        <span className="roman-action-label" aria-hidden="true">
          End voice
        </span>
        <span className="roman-action-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </span>
      </button>
    </div>
  );
}
