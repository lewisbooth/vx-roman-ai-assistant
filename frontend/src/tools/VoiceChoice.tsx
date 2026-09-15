import { useId, useSyncExternalStore } from "react";
import { LIVE_VOICES, isLiveVoice } from "../../../shared/voice";
import type { ConversationClient } from "../session/types";

export function VoiceChoice({
  session,
  disabled,
}: {
  session: ConversationClient;
  disabled?: boolean;
}) {
  const id = useId();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const needsStop =
    state.voice.status === "starting" ||
    state.voice.status === "active" ||
    state.voice.status === "stopping" ||
    (state.voice.status === "error" && state.voice.muted) ||
    state.conversation?.voice?.status === "starting" ||
    state.conversation?.voice?.status === "active";
  return (
    <div className="roman-voice-choice">
      <label htmlFor={id}>Voice</label>
      <select
        id={id}
        value={state.selectedVoice}
        disabled={disabled || state.pending || state.restoring || needsStop}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          if (isLiveVoice(event.target.value))
            session.setVoice(event.target.value);
        }}
      >
        {LIVE_VOICES.map((name) => (
          <option key={name} value={name}>
            {name[0].toUpperCase() + name.slice(1)}
          </option>
        ))}
      </select>
      <span id={`${id}-hint`} className="roman-voice-choice-hint">
        {needsStop
          ? "Switch to text to change voice."
          : "Used for your next voice connection."}
      </span>
    </div>
  );
}
