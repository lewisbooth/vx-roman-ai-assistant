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
      className="roman-composer-action roman-start-voice"
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
  dock = false,
}: {
  session: ConversationClient;
  voice: VoiceClientState;
  waiting?: boolean;
  dock?: boolean;
}) {
  const running =
    voice.status === "starting" ||
    voice.status === "active" ||
    voice.status === "stopping";
  const needsStop = running || (voice.status === "error" && voice.muted);
  const act = (operation: Promise<void>) => {
    void operation.catch(() => undefined);
  };
  const active = voice.status === "active" && !waiting;
  const muteLabel = voice.muted ? "Unmute microphone" : "Mute microphone";
  const stopLabel = dock ? "Stop voice" : "End voice";
  const status = waiting
    ? "Voice is active in another page."
    : voice.status === "starting"
      ? "Connecting voice…"
      : voice.status === "stopping"
        ? "Ending voice…"
        : active
          ? voice.muted
            ? "Microphone muted"
            : "Voice is on"
          : voice.muted
            ? "Microphone stopped"
            : "";
  if (!needsStop && !waiting && !voice.error) return null;
  const controls = (
    <>
      {(active || !dock) && (needsStop || waiting) && (
        <button
          type="button"
          className={dock ? undefined : "roman-voice-icon"}
          aria-label={muteLabel}
          title={muteLabel}
          aria-pressed={voice.muted}
          disabled={!active}
          onClick={() => session.setVoiceMuted(!voice.muted)}
        >
          {dock ? (
            muteLabel
          ) : (
            <>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
                {voice.muted && <path d="m3 3 18 18" />}
              </svg>
              <span className="sr-only">{muteLabel}</span>
            </>
          )}
        </button>
      )}
      {needsStop || waiting ? (
        <button
          type="button"
          className={dock ? undefined : "roman-voice-icon"}
          aria-label={stopLabel}
          title={stopLabel}
          disabled={voice.status === "stopping"}
          onClick={() => act(session.stopVoice())}
        >
          {dock ? (
            stopLabel
          ) : (
            <>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              <span className="sr-only">{stopLabel}</span>
            </>
          )}
        </button>
      ) : null}
    </>
  );
  return (
    <div
      className={
        dock ? "roman-voice-controls roman-voice-dock" : "roman-voice-composer"
      }
    >
      {dock ? (
        <>
          <span className="roman-voice-status" role="status">
            {status}
          </span>
          {controls}
        </>
      ) : (
        (needsStop || waiting) && (
          <>
            <div className="roman-voice-bar">
              <div
                className="roman-voice-waveform"
                aria-hidden="true"
                data-animated={active && !voice.muted}
              >
                {Array.from({ length: 13 }, (_, index) => (
                  <span key={index} />
                ))}
              </div>
              <div className="roman-voice-actions">{controls}</div>
            </div>
            <span
              className={`roman-voice-status ${active && !voice.muted ? "sr-only" : "roman-voice-notice"}`}
              role="status"
            >
              {status}
            </span>
          </>
        )
      )}
      {voice.error && (
        <p className="roman-chat-error" role="alert">
          {voice.error}
        </p>
      )}
    </div>
  );
}
