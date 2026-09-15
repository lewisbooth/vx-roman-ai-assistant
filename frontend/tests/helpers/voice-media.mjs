export function voiceMedia(window, options = {}) {
  const peers = [];
  const tracks = [];
  const calls = { microphone: 0, play: 0, pause: 0, debug: [] };
  window.console.debug = (...args) => calls.debug.push(args);
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  tracks.push(track);
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(window.navigator, "mediaDevices", {
    value: {
      getUserMedia: async (constraints) => {
        calls.microphone++;
        calls.constraints = constraints;
        if (options.getUserMedia) return options.getUserMedia(stream);
        return stream;
      },
    },
  });
  window.HTMLMediaElement.prototype.play = function () {
    calls.play++;
    return options.play ? options.play() : Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function () {
    calls.pause++;
  };
  window.RTCPeerConnection = class {
    constructor() {
      peers.push(this);
      this.connectionState = "new";
      this.added = [];
    }
    addTrack(added, source) {
      this.added.push({ track: added, stream: source });
    }
    createDataChannel(name) {
      this.channel = {
        name,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      return this.channel;
    }
    async createOffer() {
      return { type: "offer", sdp: options.sdp ?? "v=0\r\no=roman-offer" };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }
    close() {
      this.closed = true;
      this.connectionState = "closed";
    }
  };
  function event(type, extra = {}) {
    peers
      .at(-1)
      .channel.onmessage?.({ data: JSON.stringify({ type, ...extra }) });
  }
  function connect({ started = true, audio = true } = {}) {
    const peer = peers.at(-1);
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();
    if (audio) peer.ontrack?.({ track, streams: [stream] });
    if (started) event("session.started");
  }
  return { peers, calls, tracks, stream, event, connect };
}
