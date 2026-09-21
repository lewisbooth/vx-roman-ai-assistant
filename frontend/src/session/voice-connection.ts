export class MicrophonePermissionError extends Error {
  constructor() {
    super("Allow microphone access in your browser to talk to Roman.");
    this.name = "MicrophonePermissionError";
  }
}

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
  let trackAttached = false;
  let transportSignalled = false;
  let openingAccepted = false;
  let notifyTransportReady: (() => Promise<void>) | undefined;
  let ready = false;
  let timer: number | undefined;
  let disconnectTimer: number | undefined;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const beganAt = performance.now();
  const stages: Record<string, number> = {};
  let timingReported = false;

  function mark(stage: string) {
    // First occurrence owns startup timing; recovery events must not rewrite it.
    stages[stage] ??= Math.round(performance.now() - beganAt);
  }

  function reportTiming(status: "ready" | "failed" | "stopped") {
    if (timingReported) return;
    timingReported = true;
    mark("total");
    console.debug("[Roman] Voice startup timing.", {
      status,
      elapsedMs: { ...stages },
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    reportTiming("stopped");
    window.clearTimeout(timer);
    window.clearTimeout(disconnectTimer);
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

  function fail(message: string, reason: string) {
    if (closed) return;
    // Categorical diagnostics only: never SDP, audio, captions or credentials.
    console.warn("[Roman] Voice connection failed.", {
      reason,
      connectionState: peer?.connectionState,
      iceConnectionState: peer?.iceConnectionState,
      signalingState: peer?.signalingState,
      dataChannelState: channel?.readyState,
      ready,
      elapsedMs: Math.round(performance.now() - beganAt),
    });
    reportTiming("failed");
    rejectReady?.(new Error(message));
    close();
    onFailure(message);
  }

  function checkReady() {
    if (
      !closed &&
      connected &&
      started &&
      trackAttached &&
      !transportSignalled &&
      notifyTransportReady
    ) {
      transportSignalled = true;
      mark("transportReady");
      // play() can wait for the welcome's first audio; requesting the welcome
      // must therefore depend on the transport, not the playback promise.
      void Promise.resolve()
        .then(() => {
          if (closed) throw new Error("Voice was stopped.");
          return notifyTransportReady!();
        })
        .then(() => {
          if (closed) return;
          openingAccepted = true;
          mark("openingAccepted");
          checkReady();
        })
        .catch((error: unknown) => {
          fail(
            error instanceof Error
              ? error.message
              : "Roman could not begin voice. Please try again.",
            "opening_failed",
          );
        });
    }
    if (!closed && connected && started && audioReady && openingAccepted) {
      ready = true;
      reportTiming("ready");
      window.clearTimeout(timer);
      resolveReady?.();
    }
  }

  return {
    async prepare(onMicrophoneReady?: () => Promise<void>): Promise<string> {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          "Voice needs a browser with microphone access on HTTPS.",
        );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mark("microphone");
      } catch (error) {
        const name =
          error && typeof error === "object" && "name" in error
            ? error.name
            : undefined;
        if (name === "NotAllowedError" || name === "SecurityError")
          throw new MicrophonePermissionError();
        throw new Error(
          name === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try voice again."
            : "Roman could not access your microphone. Check that it is connected and available, then try again.",
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
        mark("remoteTrack");
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .then(() => {
            if (closed) return;
            audioReady = true;
            mark("playback");
            checkReady();
          })
          .catch(() => {
            fail(
              "Your browser blocked Roman's audio. Stop voice and start it again.",
              "playback_failed",
            );
          });
        trackAttached = true;
        checkReady();
      };
      peer.onconnectionstatechange = () => {
        if (closed || !peer) return;
        connected = peer.connectionState === "connected";
        if (connected) {
          mark("peerConnected");
          window.clearTimeout(disconnectTimer);
          disconnectTimer = undefined;
        } else if (peer.connectionState === "disconnected") {
          // ICE can recover on the same peer. Bound that wait without opening
          // another model session or replaying any storefront action.
          disconnectTimer ??= window.setTimeout(() => {
            disconnectTimer = undefined;
            if (!closed && !connected)
              fail(
                "Voice disconnected. Start voice again when you are ready.",
                "peer_disconnect_timeout",
              );
          }, 10_000);
        } else if (["failed", "closed"].includes(peer.connectionState)) {
          fail(
            "Voice disconnected. Start voice again when you are ready.",
            `peer_${peer.connectionState}`,
          );
        }
        checkReady();
      };
      for (const track of stream.getAudioTracks()) {
        track.onended = () =>
          fail(
            "Your microphone disconnected. Start voice again to reconnect.",
            "microphone_ended",
          );
        peer.addTrack(track, stream);
      }
      channel = peer.createDataChannel("oai-events");
      channel.onmessage = (event) => {
        // Captions and tool execution come only from the authenticated server.
        // The browser channel observes lifecycle only. The authenticated server
        // classifies command errors and publishes fatal session state; a rejected
        // optional command does not mean this media connection has ended.
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
          mark("sessionStarted");
          started = true;
          checkReady();
        } else if (data.type === "session.closed") {
          fail(
            "Roman's voice session ended. You can continue in text or start voice again.",
            "provider_closed",
          );
        }
      };
      channel.onclose = () => {
        if (ready)
          fail(
            "Voice disconnected. Start voice again when you are ready.",
            "data_channel_closed",
          );
      };
      channel.onerror = () =>
        fail(
          "Roman could not connect voice. Please try again.",
          "data_channel_error",
        );
      // Permission must precede conversation creation, but its authenticated
      // bootstrap can run while the browser prepares the local audio offer.
      const preparingPeer = peer;
      const prepareOffer = async () => {
        const offer = await preparingPeer.createOffer();
        if (closed) throw new Error("Voice was stopped.");
        await preparingPeer.setLocalDescription(offer);
        if (closed) throw new Error("Voice was stopped.");
        const sdp = preparingPeer.localDescription?.sdp;
        if (!sdp || sdp.length > 49_152)
          throw new Error("Roman could not prepare voice audio.");
        mark("offer");
        return sdp;
      };
      const prepareConversation = async () => {
        if (closed) throw new Error("Voice was stopped.");
        await onMicrophoneReady?.();
      };
      try {
        const [sdp] = await Promise.all([
          prepareOffer(),
          prepareConversation(),
        ]);
        if (closed) throw new Error("Voice was stopped.");
        return sdp;
      } catch (error) {
        close();
        throw error;
      }
    },
    async connect(
      sdp: string,
      onTransportReady: () => Promise<void>,
    ): Promise<void> {
      if (closed || !peer) throw new Error("Voice was stopped.");
      // Everything before this is microphone/offer preparation plus the
      // authenticated bootstrap/start request; later stages isolate WebRTC.
      mark("answerReceived");
      notifyTransportReady = onTransportReady;
      const waiting = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
        timer = window.setTimeout(
          () =>
            fail("Voice did not connect. Please try again.", "startup_timeout"),
          20_000,
        );
      });
      // Install rejection handling before awaiting the SDP operation.
      void waiting.catch(() => undefined);
      await peer.setRemoteDescription({ type: "answer", sdp });
      mark("answer");
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
