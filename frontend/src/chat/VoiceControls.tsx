import type { VoiceClientState } from "../../../shared/voice";
import type { ConversationClient } from "../session/types";

export function VoiceControls({
  session,
  voice,
  disabled,
  waiting = false,
  dock = false,
}: {
  session: ConversationClient;
  voice: VoiceClientState;
  disabled?: boolean;
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
      ) : (
        !dock && (
          <button
            type="button"
            disabled={disabled || waiting}
            onClick={() => act(session.startVoice())}
          >
            Start voice
          </button>
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
