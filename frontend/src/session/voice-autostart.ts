import type { ConversationClient } from "./types";
import { readVoiceAutostartPreference } from "./voice-preference";

/** One visible-page attempt; stopping voice or rejecting permission never restarts it. */
export function createVoiceAutostart(
  session: Pick<ConversationClient, "getSnapshot" | "subscribe" | "startVoice">,
) {
  let open = false;
  let attempted = false;
  let disposed = false;

  function startWhenReady() {
    if (disposed || attempted || !readVoiceAutostartPreference()) return;
    const state = session.getSnapshot();
    // A manual start, an earlier failure or another active tab owns its lifecycle.
    if (
      state.voice.status !== "idle" ||
      state.conversation?.voice?.status === "starting" ||
      state.conversation?.voice?.status === "active"
    ) {
      attempted = true;
      return;
    }
    if (
      !open ||
      state.restoring ||
      state.pending ||
      state.error ||
      state.approval ||
      state.conversation?.busy ||
      state.conversation?.tools.length
    )
      return;
    // Set before startVoice publishes "starting", avoiding subscription reentry.
    attempted = true;
    // The session client owns actionable permission/connection errors and text fallback.
    void session.startVoice().catch(() => {});
  }

  const unsubscribe = session.subscribe(startWhenReady);
  return {
    setOpen(value: boolean) {
      open = value;
      startWhenReady();
    },
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}
