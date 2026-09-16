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
  if (!needsStop && !waiting && !voice.error) return null;
  return (
    <div className={`roman-voice-controls${dock ? " roman-voice-dock" : ""}`}>
      <span className="roman-voice-status" role="status">
        {waiting
          ? "Voice is active in another page."
          : voice.status === "starting"
            ? "Connecting voice…"
            : voice.status === "stopping"
              ? "Ending voice…"
              : voice.status === "active"
                ? voice.muted
                  ? "Microphone muted"
                  : "Voice is on"
                : ""}
      </span>
      {voice.status === "active" && (
        <button
          type="button"
          aria-pressed={voice.muted}
          onClick={() => session.setVoiceMuted(!voice.muted)}
        >
          {voice.muted ? "Unmute microphone" : "Mute microphone"}
        </button>
      )}
      {needsStop || waiting ? (
        <button
          type="button"
          disabled={voice.status === "stopping"}
          onClick={() => act(session.stopVoice())}
        >
          {dock ? "Stop voice" : "Switch to text"}
        </button>
      ) : null}
      {voice.error && (
        <p className="roman-chat-error" role="alert">
          {voice.error}
        </p>
      )}
    </div>
  );
}
