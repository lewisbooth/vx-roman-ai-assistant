import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { voiceMedia } from "./helpers/voice-media.mjs";

const bundle = await build({
  entryPoints: ["frontend/src/session/voice-connection.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Voice",
  platform: "browser",
});
function setup(t, options) {
  const dom = new JSDOM("<!doctype html>", {
    url: "https://hd-dev-single.myshopify.com",
    runScripts: "outside-only",
  });
  const { window } = dom;
  const clock = { now: 0 };
  Object.defineProperty(window.performance, "now", { value: () => clock.now });
  const media = voiceMedia(window, options);
  const errors = [];
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, ms) => {
    const id = ++nextTimer;
    timers.set(id, { callback, ms });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.eval(`${bundle.outputFiles[0].text}\nwindow.Voice = Voice;`);
  const connection = window.Voice.createVoiceConnection((message) =>
    errors.push(message),
  );
  t.after(() => {
    connection.close();
    window.close();
  });
  return { window, media, errors, warnings, timers, connection, clock };
}

test("voice requests audio only on prepare, and waits for started, peer and playback before becoming ready", async (t) => {
  const { connection, media } = setup(t);
  assert.equal(media.calls.microphone, 0);
  assert.match(await connection.prepare(), /roman-offer/);
  assert.deepEqual(JSON.parse(JSON.stringify(media.calls.constraints)), {
    audio: true,
  });
  assert.equal(media.peers[0].channel.name, "oai-events");
  let ready = false;
  const connecting = connection
    .connect("v=0\r\no=answer", async () => {})
    .then(() => {
      ready = true;
    });
  media.connect({ started: false });
  await Promise.resolve();
  assert.equal(ready, false);
  media.event("session.started");
  await connecting;
  assert.equal(ready, true);
  connection.setMuted(true);
  assert.equal(media.tracks[0].enabled, false);
  connection.setMuted(false);
  assert.equal(media.tracks[0].enabled, true);
  connection.close();
  assert.ok(media.tracks.every((track) => track.stopped));
  assert.equal(media.peers[0].closed, true);
  assert.equal(media.peers[0].channel.closed, true);
  assert.equal(media.calls.pause, 1);
});

test("stopping while permission is pending stops a late microphone without creating a peer", async (t) => {
  let allow;
  let conversationPreparations = 0;
  const { connection, media } = setup(t, {
    getUserMedia: (stream) =>
      new Promise((resolve) => {
        allow = () => resolve(stream);
      }),
  });
  const preparing = connection.prepare(async () => {
    conversationPreparations++;
  });
  connection.close();
  allow();
  await assert.rejects(preparing, /stopped/);
  assert.equal(media.peers.length, 0);
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(conversationPreparations, 0);
});

test("conversation preparation starts only after microphone permission and overlaps local SDP work", async (t) => {
  let allowMicrophone;
  let allowConversation;
  let conversationPreparing = false;
  let prepared = false;
  const { connection, media } = setup(t, {
    getUserMedia: (stream) =>
      new Promise((resolve) => {
        allowMicrophone = () => resolve(stream);
      }),
  });
  const preparing = connection
    .prepare(() => {
      conversationPreparing = true;
      return new Promise((resolve) => {
        allowConversation = resolve;
      });
    })
    .then((sdp) => {
      prepared = true;
      return sdp;
    });
  assert.equal(conversationPreparing, false);
  assert.equal(media.peers.length, 0);
  allowMicrophone();
  await new Promise(setImmediate);
  assert.equal(conversationPreparing, true);
  assert.match(media.peers[0].localDescription.sdp, /roman-offer/);
  assert.equal(prepared, false);
  allowConversation();
  assert.match(await preparing, /roman-offer/);
});

test("conversation bootstrap does not wait for a delayed SDP offer and prepare waits for both", async (t) => {
  const { connection, window } = setup(t);
  let allowOffer;
  let conversationPrepared = false;
  let prepared = false;
  window.RTCPeerConnection.prototype.createOffer = () =>
    new Promise((resolve) => {
      allowOffer = () => resolve({ type: "offer", sdp: "v=0\r\no=delayed" });
    });
  const preparing = connection
    .prepare(async () => {
      conversationPrepared = true;
    })
    .then((sdp) => {
      prepared = true;
      return sdp;
    });
  await new Promise(setImmediate);
  assert.equal(conversationPrepared, true);
  assert.equal(prepared, false);
  allowOffer();
  assert.match(await preparing, /delayed/);
});

test("denied microphone permission is classified without preparing a conversation", async (t) => {
  for (const name of ["NotAllowedError", "SecurityError"]) {
    let conversationPreparations = 0;
    const { connection, media, window } = setup(t, {
      getUserMedia: () => Promise.reject({ name }),
    });
    await assert.rejects(
      connection.prepare(async () => {
        conversationPreparations++;
      }),
      (error) => {
        assert.ok(error instanceof window.Voice.MicrophonePermissionError);
        assert.match(error.message, /Allow microphone access/);
        return true;
      },
    );
    assert.equal(conversationPreparations, 0);
    assert.equal(media.peers.length, 0);
  }
});

test("missing, busy and unknown microphone failures do not claim permission was denied", async (t) => {
  for (const name of [
    "NotFoundError",
    "NotReadableError",
    "AbortError",
    "Error",
  ]) {
    const { connection, media, window } = setup(t, {
      getUserMedia: () => Promise.reject({ name }),
    });
    await assert.rejects(connection.prepare(), (error) => {
      assert.equal(
        error instanceof window.Voice.MicrophonePermissionError,
        false,
      );
      assert.match(
        error.message,
        name === "NotFoundError"
          ? /No microphone was found/
          : /connected and available/,
      );
      return true;
    });
    assert.equal(media.peers.length, 0);
  }
});

test("either preparation branch failing closes capture and handles the other branch's later rejection", async (t) => {
  for (const failingBranch of ["offer", "conversation"]) {
    const { connection, media, window, errors } = setup(t);
    let rejectOffer;
    let rejectConversation;
    window.RTCPeerConnection.prototype.createOffer = () =>
      new Promise((_, reject) => {
        rejectOffer = reject;
      });
    const preparing = connection.prepare(
      () =>
        new Promise((_, reject) => {
          rejectConversation = reject;
        }),
    );
    const rejected = assert.rejects(preparing, /preparation unavailable/);
    await new Promise(setImmediate);
    const failFirst =
      failingBranch === "offer" ? rejectOffer : rejectConversation;
    const failLater =
      failingBranch === "offer" ? rejectConversation : rejectOffer;
    failFirst(new Error("preparation unavailable"));
    await rejected;
    assert.equal(media.tracks[0].stopped, true);
    assert.equal(media.peers[0].closed, true);
    assert.equal(media.peers[0].channel.closed, true);
    failLater(new Error("late failure"));
    await new Promise(setImmediate);
    assert.deepEqual(errors, []);
  }
});

test("native startup remains pending until delayed playback succeeds and lifecycle events do not restart audio", async (t) => {
  let allowPlayback;
  const { connection, media } = setup(t, {
    play: () =>
      new Promise((resolve) => {
        allowPlayback = resolve;
      }),
  });
  await connection.prepare();
  let ready = false;
  const connecting = connection
    .connect("answer", async () => {})
    .then(() => {
      ready = true;
    });
  media.connect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(media.calls.play, 1);
  allowPlayback();
  await connecting;
  assert.equal(ready, true);
  media.event("session.started");
  media.peers[0].onconnectionstatechange();
  assert.equal(media.calls.play, 1);
  assert.equal(media.calls.pause, 0);
  assert.equal(media.calls.microphone, 1);
});

test("stopping during delayed playback cannot reactivate voice when play later resolves", async (t) => {
  let allowPlayback;
  const { connection, media, errors } = setup(t, {
    play: () =>
      new Promise((resolve) => {
        allowPlayback = resolve;
      }),
  });
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  connection.close();
  await assert.rejects(connecting, /stopped/);
  allowPlayback();
  await Promise.resolve();
  assert.equal(media.calls.play, 1);
  assert.equal(media.calls.pause, 1);
  assert.equal(media.peers[0].closed, true);
  assert.equal(media.tracks[0].stopped, true);
  assert.deepEqual(errors, []);
});

test("browser data messages cannot execute tools or upload captions", async (t) => {
  const { connection, media, errors } = setup(t);
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.event("function_call", {
    name: "navigate",
    arguments: '{"path":"/cart"}',
  });
  media.event("conversation.item.input_audio_transcription.completed", {
    transcript: "untrusted",
  });
  media.peers[0].channel.onmessage({ data: "not json" });
  media.connect();
  await connecting;
  assert.deepEqual(errors, []);
});

test("provider command errors do not close media or decide readiness in the browser", async (t) => {
  const { connection, media, errors, warnings } = setup(t);
  await connection.prepare();
  let ready = false;
  const connecting = connection.connect("answer", async () => {}).then(() => {
    ready = true;
  });
  const commandError = {
    error: {
      type: "invalid_request_error",
      code: "immutable_field_update",
      client_event_id: "optional-context",
    },
  };
  media.event("error", commandError);
  await Promise.resolve();
  assert.equal(ready, false, "An error is not a startup acknowledgement");
  assert.equal(media.tracks[0].stopped, false);
  media.connect();
  await connecting;

  media.event("error", commandError);
  assert.equal(media.tracks[0].enabled, true);
  assert.equal(media.tracks[0].stopped, false);
  assert.equal(media.peers[0].closed, undefined);
  assert.equal(media.calls.pause, 0);
  connection.setMuted(true);
  media.event("error", { error: { code: null } });
  assert.equal(media.tracks[0].enabled, false, "Error handling preserves mute");
  assert.equal(media.tracks[0].stopped, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);

  media.event("session.closed", { reason: "content" });
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(media.peers[0].closed, true);
  assert.equal(errors.length, 1);
  assert.equal(warnings[0][1].reason, "provider_closed");
});

test("blocked audio playback closes microphone and reports an actionable error", async (t) => {
  const { connection, media, errors } = setup(t, {
    play: () => Promise.reject(new Error("not allowed")),
  });
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  await assert.rejects(connecting, /blocked Roman's audio/);
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(media.peers[0].closed, true);
  assert.equal(errors.length, 1);
});

test("a transient disconnect preserves the same muted session and clears its bounded recovery timer", async (t) => {
  const { connection, media, errors, warnings, timers } = setup(t);
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  await connecting;
  connection.setMuted(true);
  media.peers[0].connectionState = "disconnected";
  media.peers[0].onconnectionstatechange();
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0];
  assert.equal(timer.ms, 10_000);
  media.peers[0].onconnectionstatechange();
  assert.equal(timers.size, 1);
  assert.equal(timers.get(id), timer);
  assert.equal(media.tracks[0].stopped, false);
  media.peers[0].connectionState = "connected";
  media.peers[0].onconnectionstatechange();
  assert.equal(timers.size, 0);
  assert.equal(media.tracks[0].enabled, false);
  assert.equal(media.peers.length, 1);
  assert.equal(media.calls.microphone, 1);
  assert.equal(media.calls.play, 1);
  assert.equal(media.calls.pause, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("a persistent disconnect expires without a new session or replay and records only transport diagnostics", async (t) => {
  const { connection, media, errors, warnings, timers } = setup(t);
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  await connecting;
  media.peers[0].connectionState = "disconnected";
  media.peers[0].onconnectionstatechange();
  const [id, timer] = [...timers][0];
  // Moving back to connecting must not extend the recovery deadline.
  media.peers[0].connectionState = "connecting";
  media.peers[0].onconnectionstatechange();
  timers.delete(id);
  timer.callback();
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(media.calls.pause, 1);
  assert.equal(media.calls.microphone, 1);
  assert.match(errors[0], /disconnected/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].reason, "peer_disconnect_timeout");
  assert.equal(warnings[0][1].connectionState, "connecting");
  assert.deepEqual(Object.keys(warnings[0][1]).sort(), [
    "connectionState",
    "dataChannelState",
    "elapsedMs",
    "iceConnectionState",
    "ready",
    "reason",
    "signalingState",
  ]);
  timer.callback();
  assert.equal(errors.length, 1);
});

test("terminal failures and deliberate close cancel an in-progress recovery", async (t) => {
  for (const reason of ["failed", "closed", "channel", "channel-error", "stop"]) {
    const { connection, media, errors, timers } = setup(t);
    await connection.prepare();
    const connecting = connection.connect("answer", async () => {});
    media.connect();
    await connecting;
    media.peers[0].connectionState = "disconnected";
    media.peers[0].onconnectionstatechange();
    const timer = [...timers.values()][0];
    if (reason === "channel") media.peers[0].channel.onclose();
    else if (reason === "channel-error") media.peers[0].channel.onerror();
    else if (reason === "stop") connection.close();
    else {
      media.peers[0].connectionState = reason;
      media.peers[0].onconnectionstatechange();
    }
    assert.equal(timers.size, 0);
    timer.callback();
    assert.equal(media.tracks[0].stopped, true);
    assert.equal(media.calls.pause, 1);
    assert.equal(media.calls.microphone, 1);
    assert.equal(errors.length, reason === "stop" ? 0 : 1);
  }
});

test("removing the microphone ends voice without opening another device", async (t) => {
  const { connection, media, errors } = setup(t);
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  await connecting;
  media.tracks[0].onended();
  assert.equal(media.peers[0].closed, true);
  assert.equal(media.calls.microphone, 1);
  assert.match(errors[0], /microphone disconnected/);
});

test("transport readiness fires once before playback resolves and both acknowledgements are required", async (t) => {
  let allowPlayback;
  let acknowledgeReady;
  let notifications = 0;
  const { connection, media } = setup(t, {
    play: () =>
      new Promise((resolve) => {
        allowPlayback = resolve;
      }),
  });
  await connection.prepare();
  let ready = false;
  const connecting = connection
    .connect("answer", () => {
      notifications++;
      return new Promise((resolve) => {
        acknowledgeReady = resolve;
      });
    })
    .then(() => {
      ready = true;
    });
  media.connect({ audio: false });
  await Promise.resolve();
  assert.equal(notifications, 0);
  media.peers[0].ontrack({ track: media.tracks[0], streams: [media.stream] });
  await Promise.resolve();
  assert.equal(notifications, 1);
  assert.equal(ready, false);
  allowPlayback();
  await Promise.resolve();
  assert.equal(ready, false);
  media.event("session.started");
  media.peers[0].onconnectionstatechange();
  assert.equal(notifications, 1);
  acknowledgeReady();
  await connecting;
  assert.equal(ready, true);
  assert.equal(media.calls.debug.length, 1);
  const timing = media.calls.debug[0][1];
  assert.equal(timing.status, "ready");
  assert.ok(
    Object.values(timing.elapsedMs).every(
      (value) => typeof value === "number" && value >= 0,
    ),
  );
  assert.ok(timing.elapsedMs.playback >= timing.elapsedMs.transportReady);
});

test("failed or cancelled readiness never leaves microphone or playback active", async (t) => {
  for (const cancellation of [false, true]) {
    let rejectReady;
    const { connection, media, errors, window } = setup(t);
    await connection.prepare();
    const connecting = connection.connect(
      "answer",
      () =>
        new Promise((_, reject) => {
          rejectReady = reject;
        }),
    );
    const rejected = assert.rejects(
      connecting,
      cancellation ? /stopped/ : /opening unavailable/,
    );
    media.connect();
    await Promise.resolve();
    if (cancellation) connection.close();
    rejectReady(new window.Error("opening unavailable"));
    await rejected;
    await Promise.resolve();
    assert.equal(media.tracks[0].stopped, true);
    assert.equal(media.peers[0].closed, true);
    assert.equal(errors.length, cancellation ? 0 : 1);
    assert.equal(media.calls.debug.length, 1);
  }
});

test("startup timing separates answer arrival, WebRTC and opening without recovery overwriting first milestones", async (t) => {
  const { connection, media, clock } = setup(t);
  clock.now = 10;
  await connection.prepare();
  let acknowledgeReady;
  clock.now = 20;
  const connecting = connection.connect(
    "answer",
    () =>
      new Promise((resolve) => {
        acknowledgeReady = resolve;
      }),
  );
  await new Promise(setImmediate);
  const peer = media.peers[0];
  clock.now = 30;
  peer.connectionState = "connected";
  peer.onconnectionstatechange();
  clock.now = 40;
  peer.ontrack({ track: media.tracks[0], streams: [media.stream] });
  await Promise.resolve();
  clock.now = 50;
  media.event("session.started");
  await Promise.resolve();
  clock.now = 60;
  media.event("session.started");
  peer.onconnectionstatechange();
  clock.now = 70;
  acknowledgeReady();
  await connecting;
  assert.equal(media.calls.debug.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(media.calls.debug[0][1])), {
    status: "ready",
    elapsedMs: {
      microphone: 10,
      offer: 10,
      answerReceived: 20,
      answer: 20,
      peerConnected: 30,
      remoteTrack: 40,
      playback: 40,
      sessionStarted: 50,
      transportReady: 50,
      openingAccepted: 70,
      total: 70,
    },
  });
});
