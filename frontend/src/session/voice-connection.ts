/** One explicitly started microphone/peer connection. No credentials or transcript handling. */
export function createVoiceConnection(onFailure: (message: string) => void) {
  let closed = false;
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let audio: HTMLAudioElement | undefined;
  let connected = false;
  let started = false;
  let audioReady = false;
  let ready = false;
  let timer: number | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  function close() {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    if (channel) {
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    rejectReady?.(new Error("Voice was stopped."));
  }

  function fail(message: string) {
    if (closed) return;
    rejectReady?.(new Error(message));
    close();
    onFailure(message);
  }

  function checkReady() {
    if (!closed && connected && started && audioReady) {
      ready = true;
      window.clearTimeout(timer);
      resolveReady?.();
    }
  }

  return {
    async prepare(): Promise<string> {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          "Voice needs a browser with microphone access on HTTPS.",
        );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error(
          "Allow microphone access in your browser to talk to Roman.",
        );
      }
      if (closed) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Voice was stopped.");
      }
      peer = new RTCPeerConnection();
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      peer.ontrack = (event) => {
        if (closed || !audio) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .then(() => {
            audioReady = true;
            checkReady();
          })
          .catch(() => {
            fail(
              "Your browser blocked Roman's audio. Stop voice and start it again.",
            );
          });
      };
      peer.onconnectionstatechange = () => {
        if (closed || !peer) return;
        connected = peer.connectionState === "connected";
        if (["failed", "disconnected", "closed"].includes(peer.connectionState))
          fail("Voice disconnected. Start voice again when you are ready.");
        else checkReady();
      };
      for (const track of stream.getAudioTracks()) {
        track.onended = () =>
          fail("Your microphone disconnected. Start voice again to reconnect.");
        peer.addTrack(track, stream);
      }
      channel = peer.createDataChannel("oai-events");
      channel.onmessage = (event) => {
        // Captions and tool execution come only from the authenticated server.
        // The browser channel is used only to observe connection lifecycle.
        if (typeof event.data !== "string" || event.data.length > 65_536)
          return;
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!data || typeof data !== "object" || !("type" in data)) return;
        if (data.type === "session.started") {
          started = true;
          checkReady();
        } else if (data.type === "session.closed" || data.type === "error") {
          fail(
            "Roman's voice session ended. You can continue in text or start voice again.",
          );
        }
      };
      channel.onclose = () => {
        if (ready)
          fail("Voice disconnected. Start voice again when you are ready.");
      };
      channel.onerror = () =>
        fail("Roman could not connect voice. Please try again.");
      const offer = await peer.createOffer();
      if (closed) throw new Error("Voice was stopped.");
      await peer.setLocalDescription(offer);
      const sdp = peer.localDescription?.sdp;
      if (!sdp || sdp.length > 49_152)
        throw new Error("Roman could not prepare voice audio.");
      return sdp;
    },
    async connect(sdp: string): Promise<void> {
      if (closed || !peer) throw new Error("Voice was stopped.");
      const waiting = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
        timer = window.setTimeout(
          () => fail("Voice did not connect. Please try again."),
          20_000,
        );
      });
      // Install rejection handling before awaiting the SDP operation.
      void waiting.catch(() => undefined);
      await peer.setRemoteDescription({ type: "answer", sdp });
      checkReady();
      await waiting;
    },
    setMuted(muted: boolean) {
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    close,
  };
}
