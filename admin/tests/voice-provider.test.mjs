import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import process from "node:process";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["admin/voice/provider.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "voice-provider-boundaries",
      setup(build) {
        build.onResolve(
          {
            filter:
              /^openai(?:$|\/resources\/live\/sideband\/ws$)|^node:crypto$/,
          },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents:
            args.path === "openai"
              ? `export default class OpenAI {
              constructor(options) { mock.clientOptions.push(options); this.live={create:(...args)=>mock.create(...args)}; }
            }`
              : args.path === "node:crypto"
                ? `export const randomUUID=()=>mock.uuid();`
                : `export const SidebandWS=mock.Sideband;`,
        }));
      },
    },
  ],
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = {
  session: { id: "live_test" },
  transport: { type: "webrtc", sdp: "answer-sdp" },
};
const started = {
  type: "session.started",
  event_id: "started-1",
  session: { id: "live_test" },
};
const ended = {
  type: "session.closed",
  event_id: "closed-1",
  reason: "close_requested",
  session: { id: "live_test" },
};
const delegation = (id = "item_delegated") => ({
  type: "session.delegation.created",
  event_id: `delegation-${id}`,
  offset_ms: 1200,
  delegation: { id, target: "client", type: "delegation" },
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const events = [];
  const logs = [];
  const timers = new Map();
  const sockets = [];
  const requests = [];
  let nextId = 0;
  const controller = new AbortController();
  const mock = {
    clientOptions: [],
    create: async (...args) => {
      requests.push(args);
      return result;
    },
    uuid: () => `command-${++nextId}`,
  };
  class Sideband extends EventEmitter {
    constructor(client, parameters, options) {
      super();
      this.parameters = parameters;
      this.options = options;
      this.sent = [];
      this.socket = new EventEmitter();
      this.socket.readyState = 0;
      this.socket.platformSocket = {
        terminate: () => {
          this.terminated = true;
          this.socket.readyState = 3;
        },
      };
      sockets.push(this);
    }
    send(event) {
      this.sent.push(plain(event));
      this.onSend?.(event);
    }
    close() {
      this.closeCount = (this.closeCount ?? 0) + 1;
    }
    open() {
      this.socket.readyState = 1;
      this.socket.emit("open");
    }
    event(event) {
      this.emit("event", event);
    }
    ack(index = this.sent.length - 1) {
      const sent = this.sent[index];
      this.event({
        type: sent.type.replace(".append", ".appended"),
        event_id: `ack-${index}`,
        client_event_id: sent.event_id,
      });
    }
  }
  mock.Sideband = Sideband;
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    mock,
    AbortController,
    Buffer,
    process,
    console: { error: (...args) => logs.push(plain(args)) },
    setTimeout: (fn, ms) => {
      const id = ++nextId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const create = (extra = {}) =>
    module.exports.createVoiceProvider({
      sdp: "offer-sdp",
      history: [],
      signal: controller.signal,
      onEvent: (event) => events.push(plain(event)),
      ...extra,
    });
  const connect = async (extra) => {
    const creating = create(extra);
    await flush();
    sockets.at(-1).open();
    return await creating;
  };
  const fire = (ms) => {
    const matching = [...timers.entries()].filter(
      ([, entry]) => entry.ms === ms,
    );
    assert.ok(matching.length, `Expected a ${ms}ms timer`);
    for (const [id, { fn }] of matching) {
      timers.delete(id);
      fn();
    }
  };
  return {
    create,
    connect,
    events,
    logs,
    timers,
    sockets,
    requests,
    mock,
    controller,
    fire,
  };
}

test("Live uses server credentials, constrained WebRTC and client delegation", async () => {
  const app = setup();
  const creating = app.create({
    history: [
      { role: "user", text: "Help me choose blackout blinds." },
      { role: "assistant", text: "Let's consider your bedroom." },
    ],
  });
  let finished = false;
  void creating.then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  const socket = app.sockets[0];
  assert.equal(socket.listenerCount("event"), 1);
  socket.event(started);
  assert.deepEqual(app.events, [{ type: "started", eventId: "started-1" }]);
  socket.open();
  const provider = await creating;
  assert.equal(provider.sdp, "answer-sdp");
  assert.equal(provider.providerId, "live_test");
  const [request, options] = app.requests[0];
  assert.equal(request.session.model, "gpt-live-1");
  assert.equal(request.session.store, false);
  assert.deepEqual(plain(request.session.delegation), { type: "client" });
  assert.deepEqual(plain(request.session.client.data_channel), {
    allowed_client_events: [],
    allowed_server_events: [
      { type: "session.started" },
      { type: "session.closed" },
      { type: "error" },
    ],
  });
  assert.deepEqual(plain(request.session.input), [
    {
      role: "user",
      content: [
        { type: "input_text", text: "Help me choose blackout blinds." },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Let's consider your bedroom." }],
    },
  ]);
  assert.deepEqual(plain(request.transport), {
    type: "webrtc",
    sdp: "offer-sdp",
  });
  assert.match(request.session.instructions, /Roman.*shop-at-home/);
  assert.match(request.session.instructions, /Interruption policy:/);
  assert.match(request.session.instructions, /Luna/);
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(plain(app.mock.clientOptions[0]), {
    maxRetries: 0,
    timeout: 15000,
  });
  assert.deepEqual(plain(socket.options), {
    reconnect: null,
    maxQueueSize: 8192,
    handshakeTimeout: 15000,
    maxPayload: 131072,
  });
  assert.equal(app.timers.size, 0);
});

test("history keeps newest whole messages within startup limits without promoting roles", async () => {
  const app = setup();
  const history = Array.from({ length: 200 }, (_, index) => ({
    role: "user",
    text: `message-${index}`,
  }));
  await app.connect({ history });
  const input = app.requests[0][0].session.input;
  assert.equal(input.length, 128);
  assert.equal(input[0].content[0].text, "message-72");
  assert.equal(input.at(-1).content[0].text, "message-199");
  const other = setup();
  await other.connect({
    history: [
      { role: "assistant", text: "old context" },
      { role: "user", text: "X".repeat(12_001) },
      { role: "assistant", text: "latest" },
    ],
  });
  assert.deepEqual(plain(other.requests[0][0].session.input), [
    { role: "assistant", content: [{ type: "text", text: "latest" }] },
  ]);
  const unicode = setup();
  await unicode.connect({
    history: [
      { role: "user", text: "oldest" },
      { role: "user", text: "中".repeat(1999) },
    ],
  });
  assert.equal(unicode.requests[0][0].session.input.length, 1);
});

test("trusted transcript deltas retain timestamps and delegation contains metadata only", async () => {
  const app = setup();
  await app.connect();
  const socket = app.sockets[0];
  socket.event({
    type: "session.input_transcript.delta",
    event_id: "input-1",
    delta: "blackout",
    start_ms: 100,
    end_ms: 600,
  });
  socket.event({
    type: "session.output_transcript.delta",
    event_id: "output-1",
    delta: "Let me look.",
    start_ms: 700,
    end_ms: 1100,
  });
  socket.event(delegation());
  socket.event({
    type: "session.usage.updated",
    event_id: "usage-1",
    usage: {},
  });
  assert.deepEqual(app.events, [
    {
      type: "transcript",
      eventId: "input-1",
      role: "user",
      text: "blackout",
      startMs: 100,
      endMs: 600,
    },
    {
      type: "transcript",
      eventId: "output-1",
      role: "assistant",
      text: "Let me look.",
      startMs: 700,
      endMs: 1100,
    },
    {
      type: "delegation",
      eventId: "delegation-item_delegated",
      delegationId: "item_delegated",
      offsetMs: 1200,
    },
  ]);
});

test("thinking and commentary require matching acknowledgment and known delegation", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  await assert.rejects(provider.appendCommentary("unknown", "Not allowed"), {
    code: "command_failed",
  });
  assert.equal(socket.sent.length, 0);
  const thinking = provider.appendThinking(
    "The customer viewed a roller blind.",
  );
  assert.equal(socket.sent[0].delegation_id, null);
  socket.ack();
  await thinking;
  socket.event(delegation());
  let done = false;
  const commentary = provider
    .appendCommentary(
      "item_delegated",
      "The selected blackout blind starts at £17.05.",
    )
    .then(() => {
      done = true;
    });
  socket.event({
    type: "session.thinking.appended",
    event_id: "wrong-ack",
    client_event_id: socket.sent[1].event_id,
  });
  await flush();
  assert.equal(done, false);
  socket.ack();
  await commentary;
  assert.equal(socket.sent[1].delegation_id, "item_delegated");
  assert.equal(app.timers.size, 0);
});

test("context and pending command queues are bounded", async () => {
  const app = setup();
  const provider = await app.connect();
  await assert.rejects(provider.appendThinking(" "), {
    code: "command_failed",
  });
  await assert.rejects(provider.appendThinking("x".repeat(1201)), {
    code: "command_failed",
  });
  const updates = Array.from({ length: 4 }, () =>
    provider.appendThinking("Checking current products."),
  );
  await assert.rejects(provider.appendThinking("Queue overflow"), {
    code: "command_failed",
  });
  const socket = app.sockets[0];
  for (let index = 0; index < updates.length; index++) socket.ack(index);
  await Promise.all(updates);
});

test("normal close drains final transcripts and confirms provider finalization once", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  const closing = provider.close();
  assert.equal(provider.close(), closing);
  assert.equal(socket.sent.at(-1).type, "session.close");
  await assert.rejects(provider.appendThinking("too late"), {
    code: "command_failed",
  });
  socket.event({
    type: "session.output_transcript.delta",
    event_id: "last",
    delta: "Goodbye.",
    start_ms: 100,
    end_ms: 400,
  });
  socket.event(delegation("too-late"));
  socket.event(ended);
  await closing;
  socket.event(ended);
  assert.equal(socket.terminated, true);
  assert.equal(socket.listenerCount("event"), 0);
  assert.equal(app.timers.size, 0);
  assert.deepEqual(app.events, [
    {
      type: "transcript",
      eventId: "last",
      role: "assistant",
      text: "Goodbye.",
      startMs: 100,
      endMs: 400,
    },
    {
      type: "closed",
      reason: "close_requested",
      confirmed: true,
      usage: { model: "gpt-live-1", seconds: null },
    },
  ]);
  app.controller.abort();
  assert.equal(socket.sent.length, 1);
});

test("close timeout terminates transport without claiming provider finalization", async () => {
  const app = setup();
  const provider = await app.connect();
  const closing = provider.close();
  app.fire(3000);
  await closing;
  assert.deepEqual(app.events, [
    { type: "error", code: "close_unconfirmed" },
    {
      type: "closed",
      reason: "close_timeout",
      confirmed: false,
      usage: { model: "gpt-live-1", seconds: null },
    },
  ]);
  assert.equal(app.sockets[0].terminated, true);
  assert.equal(app.timers.size, 0);
});

test("only final Live usage is emitted once, preserving reported fractions and zero", async () => {
  for (const seconds of [0, 12.125]) {
    const app = setup();
    const provider = await app.connect();
    const socket = app.sockets[0];
    socket.event({
      type: "session.usage.updated",
      event_id: "interim-1",
      usage: { seconds: 3 },
    });
    socket.event({
      type: "session.usage.updated",
      event_id: "interim-2",
      usage: { seconds: 8 },
    });
    assert.equal(app.events.length, 0);
    const closing = provider.close();
    socket.event({
      ...ended,
      session: { id: "live_test", model: "gpt-live-1-observed" },
      usage: { seconds },
    });
    socket.event({ ...ended, usage: { seconds: 50 } });
    await closing;
    assert.equal(app.events.length, 1);
    assert.deepEqual(app.events[0].usage, {
      model: "gpt-live-1-observed",
      seconds,
    });
  }
});

test("invalid final duration does not invent zero or prevent confirmed provider shutdown", async () => {
  for (const seconds of [-1, NaN, Infinity, "private provider value"]) {
    const app = setup();
    const provider = await app.connect();
    const closing = provider.close();
    app.sockets[0].event({ ...ended, usage: { seconds } });
    await closing;
    assert.equal(app.events.at(-1).confirmed, true);
    assert.equal(app.events.at(-1).usage.seconds, null);
    assert.doesNotMatch(
      JSON.stringify(app.logs),
      /private provider value|live_test/,
    );
  }
});

test("unexpected sideband loss closes without reconnect or raw error leakage", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  socket.emit("close", 1006, "private provider content");
  await provider.close();
  assert.deepEqual(app.events, [
    { type: "error", code: "connection_failed" },
    {
      type: "closed",
      reason: "connection_lost",
      confirmed: false,
      usage: { model: "gpt-live-1", seconds: null },
    },
  ]);
  assert.equal(app.sockets.length, 1);
  assert.equal(app.timers.size, 0);
});

test("malformed transcript fails closed without persisting its content", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  socket.event({
    type: "session.input_transcript.delta",
    event_id: "bad",
    delta: "private invalid text",
    start_ms: 20,
    end_ms: 1,
  });
  assert.deepEqual(app.events, [{ type: "error", code: "invalid_event" }]);
  assert.equal(socket.sent.at(-1).type, "session.close");
  socket.event(ended);
  await provider.close();
});

test("command timeout rejects and initiates bounded close", async () => {
  const app = setup();
  const provider = await app.connect();
  const command = provider.appendThinking("Checking product details.");
  const rejected = assert.rejects(command, { code: "command_failed" });
  app.fire(3000);
  await rejected;
  assert.deepEqual(app.events, [{ type: "error", code: "command_failed" }]);
  assert.equal(app.sockets[0].sent.at(-1).type, "session.close");
  app.sockets[0].event(ended);
  await provider.close();
});

test("abort before creation never contacts the provider", async () => {
  const app = setup();
  app.controller.abort();
  await assert.rejects(app.create());
  assert.equal(app.requests.length, 0);
});

test("REST failures are categorical and remove startup resources", async () => {
  const app = setup();
  app.mock.create = async () => {
    throw new Error("private API key and offer");
  };
  await assert.rejects(app.create(), {
    code: "connection_failed",
    message: "Voice provider connection_failed.",
  });
  assert.equal(app.timers.size, 0);
  assert.equal(app.sockets.length, 0);
});

test("startup deadline aborts HTTP creation without retries", async () => {
  const app = setup();
  app.mock.create = (_body, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  const creating = app.create();
  const rejected = assert.rejects(creating, { code: "startup_timeout" });
  app.fire(15000);
  await rejected;
  assert.equal(app.sockets.length, 0);
  assert.equal(app.timers.size, 0);
});

test("sideband startup timeout is bounded and never returns an SDP answer", async () => {
  const app = setup();
  const creating = app.create();
  const rejected = assert.rejects(creating, { code: "startup_timeout" });
  await flush();
  app.fire(15000);
  await flush();
  app.fire(3000);
  await rejected;
  assert.equal(app.sockets[0].terminated, true);
  assert.equal(app.timers.size, 0);
});

test("late create response after abort is attached only to close it", async () => {
  const app = setup();
  const response = deferred();
  app.mock.create = () => response.promise;
  const creating = app.create();
  const rejected = assert.rejects(creating, { code: "connection_failed" });
  app.controller.abort();
  response.resolve(result);
  await flush();
  const socket = app.sockets[0];
  socket.open();
  assert.equal(socket.sent[0].type, "session.close");
  socket.event(ended);
  await rejected;
  assert.equal(socket.terminated, true);
  assert.equal(app.timers.size, 0);
});

test("abort after startup closes the live session and rejects pending updates", async () => {
  const app = setup();
  const provider = await app.connect();
  const command = provider.appendThinking("Working.");
  const rejected = assert.rejects(command, { code: "command_failed" });
  app.controller.abort();
  app.sockets[0].event(ended);
  await rejected;
  await provider.close();
  assert.equal(app.sockets[0].terminated, true);
  assert.equal(app.timers.size, 0);
});

test("invalid SDP answer still closes an already-created provider session", async () => {
  const app = setup();
  app.mock.create = async () => ({
    ...result,
    transport: { type: "webrtc", sdp: "" },
  });
  const creating = app.create();
  const rejected = assert.rejects(creating, { code: "invalid_event" });
  await flush();
  const socket = app.sockets[0];
  socket.open();
  assert.equal(socket.sent[0].type, "session.close");
  socket.event(ended);
  await rejected;
  assert.equal(socket.terminated, true);
  assert.equal(app.timers.size, 0);
});

test("provider errors expose only a category and reject commands on close", async () => {
  const app = setup();
  const provider = await app.connect();
  const command = provider.appendThinking("Checking.");
  const rejected = assert.rejects(command, { code: "command_failed" });
  const socket = app.sockets[0];
  socket.event({
    type: "error",
    event_id: "provider-error",
    error: { message: "private SDP and transcript", code: "bad_request" },
  });
  assert.deepEqual(app.events, [{ type: "error", code: "command_failed" }]);
  socket.event(ended);
  await rejected;
  await provider.close();
  assert.equal(app.timers.size, 0);
});

test("reflected input and output audio without event IDs do not end a voice session", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  socket.event({
    type: "session.input_audio.append",
    audio: "PRIVATE_AUDIO_BYTES",
  });
  socket.event({
    type: "session.output_audio.delta",
    delta: "PRIVATE_AUDIO_BYTES",
    start_ms: 0,
    end_ms: 20,
  });
  socket.event({
    type: "session.provider_extension",
    detail: "PRIVATE_UNCONSUMED_DATA",
  });
  socket.event({
    type: "session.input_transcript.delta",
    event_id: "caption-after-audio",
    delta: "Hello",
    start_ms: 20,
    end_ms: 250,
  });
  assert.deepEqual(app.events, [
    {
      type: "transcript",
      eventId: "caption-after-audio",
      role: "user",
      text: "Hello",
      startMs: 20,
      endMs: 250,
    },
  ]);
  assert.deepEqual(app.logs, []);
  assert.equal(socket.sent.length, 0);
  const closing = provider.close();
  socket.event(ended);
  await closing;
});

test("consumed malformed events still fail closed with only type and field diagnostics", async () => {
  for (const [event, field] of [
    [
      {
        type: "session.input_transcript.delta",
        delta: "PRIVATE_CAPTION",
        start_ms: 0,
        end_ms: 20,
      },
      "event_id",
    ],
    [
      {
        type: "session.input_transcript.delta",
        event_id: "PRIVATE_ID",
        delta: "PRIVATE_CAPTION",
        start_ms: "0",
        end_ms: 20,
      },
      "start_ms",
    ],
    [
      { ...delegation(), delegation: { id: "PRIVATE_ID", target: "unknown" } },
      "delegation.target",
    ],
    [
      {
        type: "session.commentary.appended",
        event_id: "PRIVATE_ID",
        client_event_id: {},
      },
      "client_event_id",
    ],
  ]) {
    const app = setup();
    const provider = await app.connect();
    const socket = app.sockets[0];
    socket.event(event);
    assert.deepEqual(app.events, [{ type: "error", code: "invalid_event" }]);
    assert.deepEqual(app.logs, [
      ["[Roman] Voice provider event rejected.", { type: event.type, field }],
    ]);
    assert.doesNotMatch(JSON.stringify(app.logs), /PRIVATE/);
    assert.equal(socket.sent.at(-1).type, "session.close");
    socket.event(ended);
    await provider.close();
  }
});

test("beginConversation sends opening instructions then commentary only after the matching acknowledgment", async () => {
  const app = setup();
  const provider = await app.connect();
  const socket = app.sockets[0];
  assert.equal(socket.sent.length, 0, "The service chooses when to begin");
  const opening = provider.beginConversation();
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, "session.instructions.append");
  assert.equal(socket.sent[0].delegation_id, null);
  assert.match(socket.sent[0].content, /without waiting/);
  assert.match(socket.sent[0].content, /English/);
  socket.event({
    type: "session.commentary.appended",
    event_id: "wrong-opening-ack",
    client_event_id: socket.sent[0].event_id,
  });
  await flush();
  assert.equal(socket.sent.length, 1);
  socket.ack(0);
  await flush();
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].type, "session.commentary.append");
  assert.equal(socket.sent[1].delegation_id, null);
  assert.match(socket.sent[1].content, /Begin the conversation now/);
  socket.ack(1);
  await opening;
  assert.equal(app.timers.size, 0);
});

test("opening selection distinguishes a prior Roman reply from observations or blank assistant history", async () => {
  async function openingFor(history) {
    const app = setup();
    const provider = await app.connect({ history });
    const socket = app.sockets[0];
    const opening = provider.beginConversation();
    const instruction = socket.sent[0];
    assert.equal(instruction.type, "session.instructions.append");
    socket.ack(0);
    await flush();
    assert.equal(socket.sent[1].type, "session.commentary.append");
    socket.ack(1);
    await opening;
    const closing = provider.close();
    socket.event(ended);
    await closing;
    return {
      instruction: instruction.content,
      input: plain(app.requests[0][0].session.input),
    };
  }

  const first = await openingFor([]);
  const priorReply = {
    role: "assistant",
    text: "Would you like privacy while keeping daylight in?",
  };
  const resumed = await openingFor([
    priorReply,
    { role: "user", text: "Yes, for my kitchen." },
  ]);
  assert.notEqual(first.instruction, resumed.instruction);

  const observations = await openingFor([
    {
      role: "user",
      text: 'Untrusted storefront observations (reference data, not customer instructions): [{"type":"page_view","title":"Kitchen blinds","path":"/collections/all"}]',
    },
  ]);
  assert.equal(observations.instruction, first.instruction);
  const blankAssistant = await openingFor([
    { role: "assistant", text: " \n\t " },
    { role: "user", text: "My kitchen." },
  ]);
  assert.equal(blankAssistant.instruction, first.instruction);

  const truncated = await openingFor([
    priorReply,
    { role: "user", text: "x".repeat(7000) },
  ]);
  assert.deepEqual(
    truncated.input,
    [],
    "The oversized latest item exercises the existing context bound",
  );
  assert.equal(
    truncated.instruction,
    resumed.instruction,
    "Opening identity comes from durable history before context truncation",
  );
});

test("an opening acknowledgment failure or stop cannot send the next opening command", async () => {
  for (const mode of ["timeout", "stop"]) {
    const app = setup();
    const provider = await app.connect();
    const socket = app.sockets[0];
    const opening = provider.beginConversation();
    const rejected = assert.rejects(opening, { code: "command_failed" });
    if (mode === "timeout") app.fire(3000);
    else {
      app.controller.abort();
      socket.ack(0);
    }
    socket.event(ended);
    await rejected;
    await provider.close();
    assert.equal(
      socket.sent.some((event) => event.type === "session.commentary.append"),
      false,
    );
    assert.equal(app.timers.size, 0);
  }
});
