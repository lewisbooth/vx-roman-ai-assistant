import assert from "node:assert/strict";
import { test } from "node:test";
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
  const media = voiceMedia(window, options);
  const errors = [];
  window.eval(`${bundle.outputFiles[0].text}\nwindow.Voice = Voice;`);
  const connection = window.Voice.createVoiceConnection((message) =>
    errors.push(message),
  );
  t.after(() => {
    connection.close();
    window.close();
  });
  return { window, media, errors, connection };
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
  const { connection, media } = setup(t, {
    getUserMedia: (stream) =>
      new Promise((resolve) => {
        allow = () => resolve(stream);
      }),
  });
  const preparing = connection.prepare();
  connection.close();
  allow();
  await assert.rejects(preparing, /stopped/);
  assert.equal(media.peers.length, 0);
  assert.equal(media.tracks[0].stopped, true);
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

test("a peer disconnect stops microphone and playback rather than reconnecting", async (t) => {
  const { connection, media, errors } = setup(t);
  await connection.prepare();
  const connecting = connection.connect("answer", async () => {});
  media.connect();
  await connecting;
  media.peers[0].connectionState = "disconnected";
  media.peers[0].onconnectionstatechange();
  assert.equal(media.tracks[0].stopped, true);
  assert.equal(media.calls.pause, 1);
  assert.equal(media.calls.microphone, 1);
  assert.match(errors[0], /disconnected/);
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
