import type { VoiceClientState } from "../../../shared/voice";
import type { ConversationClient } from "../session/types";

export function UploadImageButton({
  onUpload,
}: {
  onUpload: () => void;
}) {
  return (
    <button
      type="button"
      className="roman-composer-action roman-composer-tooltip roman-upload-image"
      data-roman-upload
      aria-label="Upload image"
      onClick={onUpload}
    >
      <span className="roman-action-label" aria-hidden="true">
        Upload image
      </span>
      <span className="roman-action-icon" aria-hidden="true">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </span>
    </button>
  );
}

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
      className="roman-composer-action roman-composer-tooltip roman-start-voice"
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
    <div className="roman-voice-bar" data-microphone-control={active || undefined}>
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
      {active && (
        <button
          type="button"
          className="roman-composer-action roman-composer-tooltip roman-voice-microphone"
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          data-muted={voice.muted || undefined}
          onClick={() => session.setMicrophoneMuted(!voice.muted)}
        >
          <span className="roman-action-label" aria-hidden="true">
            {voice.muted ? "Unmute microphone" : "Mute microphone"}
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
              {voice.muted ? (
                <>
                  <path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M9 5V4a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 4.9M19 10v2c0 .6-.1 1.2-.2 1.7" />
                  <path d="M12 19v3M8 22h8" />
                </>
              ) : (
                <>
                  <rect x="9" y="1" width="6" height="14" rx="3" />
                  <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
                </>
              )}
            </svg>
          </span>
        </button>
      )}
      <button
        type="button"
        className="roman-composer-action roman-composer-tooltip roman-end-voice"
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
