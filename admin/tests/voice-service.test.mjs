import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { setImmediate } from "node:timers";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export * from './admin/voice/service.server';
    export { ConversationError } from './admin/conversations/errors.server';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "voice-boundaries",
      setup(build) {
        build.onResolve(
          {
            filter:
              /repository\.server$|provider\.server$|runner\.server$|^node:timers\/promises$/,
          },
          (args) => ({ path: args.path, namespace: "stub" }),
        );
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
          let contents;
          if (args.path === "node:timers/promises")
            contents = `export const setTimeout = (...args) => mock.delay(...args);`;
          else if (args.path.endsWith("provider.server"))
            contents = `export const createVoiceProvider = (...args) => mock.createProvider(...args);`;
          else if (args.path.endsWith("runner.server"))
            contents = `export const cancelVoiceDelegation = (...args) => mock.cancelDelegation(...args);
        export const runVoiceDelegation = (...args) => mock.delegate(...args);`;
          else if (args.path.includes("conversations"))
            contents = `export const getModelHistory = (...args) => mock.history(...args);
            export const findVoiceQuestionAnswer = (...args) => mock.findAnswer(...args);
            export const appendVoiceQuestionAnswer = (...args) => mock.saveAnswer(...args);`;
          else if (args.path.includes("usage"))
            contents = `export const recordVoiceUsage = (...args) => mock.usage(...args);`;
          else
            contents = `export const reserveVoiceSession = (...args) => mock.reserve(...args);
        export const activateVoiceSession = (...args) => mock.activate(...args);
        export const markVoiceStarted = (...args) => mock.markStarted(...args);
        export const appendVoiceTranscript = (...args) => mock.caption(...args);
        export const cancelVoiceSession = (...args) => mock.cancel(...args);
        export const closeVoiceSession = (...args) => mock.close(...args);
        export const getVoiceState = (...args) => mock.state(...args);
        export const heartbeatVoiceSession = (...args) => mock.heartbeat(...args);`;
          return { contents };
        });
      },
    },
  ],
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
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
  const rows = new Map();
  const captionSequences = new Map();
  const providers = [];
  const logs = [];
  const order = [];
  const timers = new Set();
  const answerReceipts = new Map();
  const calls = {
    reserve: [],
    activate: [],
    started: [],
    caption: [],
    cancel: [],
    close: [],
    delegate: [],
    cancelDelegation: [],
    heartbeat: [],
    usage: [],
    answer: [],
  };
  let api;
  const mock = {
    beforeReserve: undefined,
    usage: async (...args) => {
      await mock.beforeUsage?.(...args);
      calls.usage.push(plain(args));
      order.push("usage-saved");
    },
    beforeCreate: undefined,
    beforeCaption: undefined,
    onProviderClose: undefined,
    onDelegate: undefined,
    onCancelDelegation: undefined,
    delay: async (_ms, _value, options) => {
      options.signal.throwIfAborted();
    },
    reserve: async (conversationId, input) => {
      calls.reserve.push([conversationId, input]);
      await mock.beforeReserve?.();
      const previous = rows.get(input.voiceId);
      if (previous) return { session: previous, created: false };
      const session = {
        id: input.voiceId,
        conversationId,
        clientId: input.clientId,
        status: "starting",
        providerId: null,
        leaseExpiresAt: new Date(Date.now() + 45000),
      };
      rows.set(session.id, session);
      return { session, created: true };
    },
    history: async () => [{ role: "user", text: "My earlier typed message" }],
    findAnswer: async (conversationId, voiceId, input) => {
      const previous = answerReceipts.get(input.requestId);
      if (!previous) return null;
      if (
        previous.voiceId !== voiceId ||
        previous.conversationId !== conversationId ||
        JSON.stringify(previous.input) !== JSON.stringify(input)
      )
        throw new api.ConversationError(400, "Answer conflict");
      return previous.receipt;
    },
    saveAnswer: async (conversationId, voiceId, input) => {
      await mock.beforeAnswerSave?.();
      const receipt = {
        created: true,
        messageId: input.requestId,
        sequence: 100,
        question: "Which room?",
        answer: input.answer,
      };
      answerReceipts.set(input.requestId, {
        conversationId,
        voiceId,
        input,
        receipt,
      });
      calls.answer.push([conversationId, voiceId, input]);
      order.push("answer-saved");
      return receipt;
    },
    createProvider: async (options) => {
      const record = {
        options,
        closed: false,
        closeCount: 0,
        openingCount: 0,
        commentaries: [],
        thoughts: [],
        answers: [],
      };
      const provider = {
        providerId: "live_test",
        sdp: "v=0\r\nanswer",
        beginConversation: async () => {
          order.push("opening-sent");
          record.openingCount++;
          await mock.onOpening?.(record);
        },
        close: async () => {
          order.push("provider-close");
          record.closeCount++;
          await mock.onProviderClose?.(record);
          record.closed = true;
        },
        appendCommentary: async (...args) => record.commentaries.push(args),
        appendThinking: async (...args) => record.thoughts.push(args),
        appendAnswer: async (...args) => {
          record.answers.push(args);
          order.push("answer-sent");
          await mock.onAnswer?.(...args);
        },
      };
      record.provider = provider;
      providers.push(record);
      await mock.beforeCreate?.(options);
      return provider;
    },
    activate: async (conversationId, voiceId, clientId, providerId) => {
      calls.activate.push([conversationId, voiceId, clientId, providerId]);
      await mock.beforeActivate?.();
      const row = rows.get(voiceId);
      if (row.status !== "starting")
        throw new api.ConversationError(409, "Closed");
      row.status = "active";
      row.providerId = providerId;
      return row;
    },
    markStarted: async (...args) => {
      await mock.beforeStarted?.(...args);
      calls.started.push(args);
      order.push("start-saved");
    },
    caption: async (...args) => {
      await mock.beforeCaption?.(...args);
      const row = rows.get(args[1]);
      if (!["starting", "active"].includes(row.status))
        throw new api.ConversationError(409, "Closed");
      calls.caption.push(args);
      order.push("caption-saved");
      const key = `${args[1]}:${args[2].providerEventId}`;
      if (!captionSequences.has(key))
        captionSequences.set(key, captionSequences.size);
      return { sequence: captionSequences.get(key) };
    },
    cancel: async (conversationId, voiceId, clientId) => {
      calls.cancel.push([conversationId, voiceId, clientId]);
      order.push("cancel-persisted");
      const row = rows.get(voiceId) ?? {
        id: voiceId,
        conversationId,
        clientId,
      };
      if (row.conversationId !== conversationId || row.clientId !== clientId)
        throw new api.ConversationError(404, "Not owned");
      row.status = "closed";
      rows.set(voiceId, row);
      return row;
    },
    close: async (conversationId, voiceId, clientId, outcome) => {
      calls.close.push([conversationId, voiceId, clientId, outcome]);
      order.push("failure-persisted");
      const row = rows.get(voiceId);
      Object.assign(row, outcome);
      return row;
    },
    state: async (conversationId) =>
      [...rows.values()].find((row) => row.conversationId === conversationId) ??
      null,
    heartbeat: async (conversationId, voiceId, clientId) => {
      calls.heartbeat.push([conversationId, voiceId, clientId]);
      await mock.beforeHeartbeat?.();
      const row = rows.get(voiceId);
      if (mock.heartbeatError) throw mock.heartbeatError;
      row.leaseExpiresAt = new Date(Date.now() + 45000);
      return row;
    },
    delegate: async (...args) => {
      calls.delegate.push(args);
      return mock.onDelegate
        ? mock.onDelegate(...args)
        : { text: "Here is a verified product result." };
    },
    cancelDelegation: async (...args) => {
      calls.cancelDelegation.push(args);
      order.push("delegate-cancelled");
      await mock.onCancelDelegation?.(...args);
    },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    mock,
    Date,
    AbortController,
    AbortSignal,
    Set,
    Map,
    Promise,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    console: { error: (...args) => logs.push(args) },
  });
  api = module.exports;
  const conversationId = randomUUID();
  const input = {
    requestId: randomUUID(),
    clientId: randomUUID(),
    sdp: "v=0\r\noffer",
  };
  return {
    api,
    mock,
    calls,
    rows,
    providers,
    logs,
    order,
    timers,
    conversationId,
    input,
    start: () => api.startVoice(conversationId, input),
    ready: () =>
      api.readyVoice(conversationId, input.requestId, input.clientId),
    stop: () => api.stopVoice(conversationId, input.requestId, input.clientId),
    emit: (event) => providers[0].options.onEvent(event),
  };
}
function transcript(overrides = {}) {
  return {
    type: "transcript",
    eventId: "event_1",
    role: "user",
    text: "blackout",
    startMs: 0.25,
    endMs: 100.75,
    ...overrides,
  };
}

test("voice starts once per exact owner, voice and SDP, resuming duplicate HTTP requests safely", async () => {
  const state = setup();
  const createGate = deferred();
  state.mock.beforeCreate = () => createGate.promise;
  const first = state.start();
  const second = state.start();
  await flush();
  assert.equal(state.calls.reserve.length, 1);
  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0].options.voice, "marin");
  await assert.rejects(
    state.api.startVoice(state.conversationId, {
      ...state.input,
      voice: "gleam",
    }),
    { status: 409 },
  );
  await assert.rejects(
    state.api.startVoice(state.conversationId, {
      ...state.input,
      sdp: "different",
    }),
    { status: 409 },
  );
  await assert.rejects(
    state.api.startVoice(state.conversationId, {
      ...state.input,
      clientId: randomUUID(),
    }),
    { status: 409 },
  );
  createGate.resolve();
  assert.deepEqual(plain(await first), {
    voiceId: state.input.requestId,
    sdp: "v=0\r\nanswer",
  });
  assert.deepEqual(await second, await first);
  assert.deepEqual(plain(state.providers[0].options.history), [
    { role: "user", text: "My earlier typed message" },
  ]);
  assert.equal(state.calls.activate.length, 1);
  await state.stop();
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.timers.size, 0);
});

test("voice returns SDP before readiness and opens once after both transports are ready", async () => {
  const state = setup();
  const answer = await state.start();
  assert.equal(answer.sdp, "v=0\r\nanswer");
  assert.equal(state.calls.started.length, 0);
  assert.equal(state.providers[0].openingCount, 0);
  state.emit({ type: "started", eventId: "started_1" });
  state.emit({ type: "started", eventId: "started_1" });
  state.emit({ type: "started", eventId: "started_2" });
  assert.equal(state.providers[0].openingCount, 0);
  state.ready();
  state.ready();
  await state.start();
  await flush();
  assert.equal(state.providers[0].openingCount, 1);
  assert.deepEqual(state.calls.started, [
    [state.conversationId, state.input.requestId, state.input.clientId],
  ]);
  assert.ok(
    state.order.indexOf("start-saved") < state.order.indexOf("opening-sent"),
  );
  assert.equal(state.calls.delegate.length, 0);
  assert.equal(state.calls.caption.length, 0);
  await state.stop();
});

test("browser readiness waits for native startup and cannot target a foreign or closed connection", async () => {
  const state = setup();
  state.input.voice = "cedar";
  assert.throws(state.ready, { status: 409 });
  await state.start();
  assert.equal(state.providers[0].options.voice, "cedar");
  for (const [conversationId, voiceId, clientId] of [
    [randomUUID(), state.input.requestId, state.input.clientId],
    [state.conversationId, randomUUID(), state.input.clientId],
    [state.conversationId, state.input.requestId, randomUUID()],
  ]) {
    assert.throws(
      () => state.api.readyVoice(conversationId, voiceId, clientId),
      { status: 409 },
    );
  }
  state.ready();
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.calls.started.length, 0);
  state.emit({ type: "started", eventId: "late_native_start" });
  await flush();
  assert.equal(state.providers[0].openingCount, 1);
  await state.stop();
  assert.throws(state.ready, { status: 409 });
  assert.equal(state.providers[0].openingCount, 1);
});

test("stop drains final trusted usage before closing the durable voice session", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeUsage = () => gate.promise;
  state.mock.onProviderClose = async (record) =>
    record.options.onEvent({
      type: "closed",
      reason: "close_requested",
      confirmed: true,
      usage: { model: "gpt-live-1", seconds: 12.125 },
    });
  await state.start();
  const stopped = state.stop();
  await flush();
  assert.equal(state.calls.cancel.length, 0);
  gate.resolve();
  await stopped;
  assert.deepEqual(state.calls.usage, [
    [
      state.conversationId,
      state.input.requestId,
      { model: "gpt-live-1", seconds: 12.125 },
    ],
  ]);
  assert.ok(
    state.order.indexOf("usage-saved") <
      state.order.indexOf("cancel-persisted"),
  );
});

test("an early native started event waits for provider creation and activation without blocking SDP on the opening", async () => {
  const state = setup();
  const createGate = deferred();
  const activateGate = deferred();
  const openingGate = deferred();
  state.mock.beforeCreate = async (options) => {
    options.onEvent({ type: "started", eventId: "early_started" });
    await createGate.promise;
  };
  state.mock.beforeActivate = () => activateGate.promise;
  state.mock.onOpening = () => openingGate.promise;
  const started = state.start();
  await flush();
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.calls.started.length, 0);
  createGate.resolve();
  await flush();
  assert.equal(state.calls.activate.length, 1);
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.calls.started.length, 0);
  activateGate.resolve();
  assert.equal((await started).sdp, "v=0\r\nanswer");
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.calls.started.length, 0);
  state.ready();
  await flush();
  assert.equal(state.providers[0].openingCount, 1);
  openingGate.resolve();
  await state.stop();
});

test("a cancelled connection never opens even when native readiness arrives during activation or after stop", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeActivate = () => gate.promise;
  const starting = state.start().catch((error) => error);
  await flush();
  state.emit({ type: "started", eventId: "started_before_stop" });
  const stopped = state.stop();
  gate.resolve();
  await stopped;
  assert.equal((await starting).status, 503);
  state.emit({ type: "started", eventId: "started_after_stop" });
  await flush();
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.calls.started.length, 0);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("voice persists readiness before opening without blocking caption writes on its acknowledgement", async () => {
  const state = setup();
  const saved = deferred();
  const opening = deferred();
  state.mock.beforeStarted = () => saved.promise;
  state.mock.onOpening = () => opening.promise;
  await state.start();
  state.emit({ type: "started", eventId: "native_started" });
  state.ready();
  state.ready();
  await flush();
  assert.equal(state.calls.started.length, 0);
  assert.equal(state.providers[0].openingCount, 0);
  saved.resolve();
  await flush();
  assert.equal(state.calls.started.length, 1);
  assert.equal(state.providers[0].openingCount, 1);
  state.emit(transcript());
  await flush();
  assert.equal(state.calls.caption.length, 1);
  opening.resolve();
  await state.stop();
});

test("stop before the queued readiness write skips the start event and opening", async () => {
  const state = setup();
  const caption = deferred();
  state.mock.beforeCaption = () => caption.promise;
  await state.start();
  state.emit(transcript());
  await flush();
  state.emit({ type: "started", eventId: "native_started" });
  state.ready();
  const stopped = state.stop();
  await flush();
  assert.equal(state.calls.cancel.length, 0);
  caption.resolve();
  await stopped;
  assert.equal(state.calls.caption.length, 1);
  assert.equal(state.calls.started.length, 0);
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("stop drains an in-flight readiness write before durable close without sending a late opening", async () => {
  const state = setup();
  const saved = deferred();
  state.mock.beforeStarted = () => saved.promise;
  await state.start();
  state.emit({ type: "started", eventId: "native_started" });
  state.ready();
  await flush();
  const stopped = state.stop();
  await flush();
  assert.equal(state.calls.cancel.length, 0);
  saved.resolve();
  await stopped;
  assert.equal(state.calls.started.length, 1);
  assert.equal(state.providers[0].openingCount, 0);
  assert.ok(
    state.order.indexOf("start-saved") <
      state.order.indexOf("cancel-persisted"),
  );
  assert.deepEqual(state.logs, []);
});

test("readiness persistence failures close once without speaking or leaking the error", async () => {
  const state = setup();
  state.mock.beforeStarted = async () => {
    throw new Error("private persistence payload");
  };
  await state.start();
  state.emit({ type: "started", eventId: "native_started" });
  state.ready();
  state.ready();
  await flush();
  assert.equal(state.calls.started.length, 0);
  assert.equal(state.providers[0].openingCount, 0);
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.calls.close.length, 1);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /conversation event could not be saved/,
  );
  assert.match(JSON.stringify(state.logs), /start_persistence_failed/);
  assert.ok(
    !JSON.stringify(state.logs).includes("private persistence payload"),
  );
  assert.equal(state.calls.caption.length, 0);
  assert.equal(state.calls.delegate.length, 0);
});

test("opening failures close voice categorically without fabricating a greeting or invoking Terra", async () => {
  const state = setup();
  state.mock.onOpening = async () => {
    throw new Error("private opening payload");
  };
  await state.start();
  state.ready();
  state.emit({ type: "started", eventId: "started_1" });
  await flush();
  assert.equal(state.providers[0].openingCount, 1);
  assert.equal(state.providers[0].closed, true);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /could not begin speaking/,
  );
  assert.equal(state.calls.delegate.length, 0);
  assert.equal(state.calls.caption.length, 0);
  assert.ok(!JSON.stringify(state.logs).includes("private opening payload"));
});

test("stopping during opening suppresses its late rejection and preserves the closed outcome", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.onOpening = () => gate.promise;
  await state.start();
  state.ready();
  state.emit({ type: "started", eventId: "started_1" });
  await flush();
  assert.equal(state.providers[0].openingCount, 1);
  await state.stop();
  gate.reject(new Error("opening cancelled"));
  await flush();
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
  assert.equal(state.calls.close.length, 0);
  assert.deepEqual(state.logs, []);
});

test("each new voice connection opens once while actual provider captions remain the only transcript", async () => {
  const state = setup();
  await state.start();
  state.ready();
  state.emit({ type: "started", eventId: "started_1" });
  await flush();
  assert.equal(state.calls.caption.length, 0);
  state.emit(
    transcript({
      role: "assistant",
      text: "Hello, what room can I help with?",
    }),
  );
  await flush();
  assert.equal(state.calls.caption.length, 1);
  await state.stop();
  const next = { ...state.input, requestId: randomUUID() };
  await state.api.startVoice(state.conversationId, next);
  state.api.readyVoice(state.conversationId, next.requestId, next.clientId);
  state.providers[1].options.onEvent({ type: "started", eventId: "started_2" });
  await flush();
  assert.deepEqual(
    state.providers.map((provider) => provider.openingCount),
    [1, 1],
  );
  assert.equal(state.calls.caption.length, 1);
  assert.equal(state.calls.delegate.length, 0);
  await state.api.stopVoice(
    state.conversationId,
    next.requestId,
    next.clientId,
  );
});

test("a stop that arrives before start leaves a durable cancellation and creates no provider", async () => {
  const state = setup();
  await state.stop();
  await assert.rejects(state.start(), { status: 409 });
  assert.equal(state.providers.length, 0);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("cancellation while reservation is pending prevents provider creation", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeReserve = () => gate.promise;
  const result = state.start().catch((error) => error);
  await flush();
  const stopped = state.stop();
  gate.resolve();
  await stopped;
  assert.equal((await result).status, 503);
  assert.equal(state.providers.length, 0);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("cancellation during provider handshake closes the partial provider without activating it", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeCreate = () => gate.promise;
  const result = state.start().catch((error) => error);
  await flush();
  const stopped = state.stop();
  assert.equal(state.providers[0].options.signal.aborted, true);
  gate.resolve();
  await stopped;
  assert.equal((await result).status, 503);
  assert.equal(state.calls.activate.length, 0);
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("a provider error emitted before handshake settles cannot deadlock shared startup cleanup", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeCreate = async (options) => {
    options.onEvent({ type: "error", code: "startup_fault" });
    await gate.promise;
  };
  const result = state.start().catch((error) => error);
  await flush();
  gate.resolve();
  assert.equal((await result).status, 503);
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.equal(state.calls.activate.length, 0);
  assert.equal(state.timers.size, 0);
});

test("failed reservation does not close a durable session that this start never acquired", async () => {
  const state = setup();
  state.rows.set(state.input.requestId, {
    id: state.input.requestId,
    conversationId: state.conversationId,
    clientId: state.input.clientId,
    status: "active",
  });
  await assert.rejects(state.start(), { status: 409 });
  assert.equal(state.rows.get(state.input.requestId).status, "active");
  assert.equal(state.calls.close.length, 0);
  assert.equal(state.calls.cancel.length, 0);
  assert.equal(state.providers.length, 0);
});

test("stop during durable activation never returns an SDP success after cancellation", async () => {
  const state = setup();
  const gate = deferred();
  state.mock.beforeActivate = () => gate.promise;
  const result = state.start().catch((error) => error);
  await flush();
  assert.equal(state.calls.activate.length, 1);
  const stopped = state.stop();
  gate.resolve();
  await stopped;
  assert.equal((await result).status, 503);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
  assert.equal(state.providers[0].closeCount, 1);
});

test("stop drains trusted final captions before marking voice terminal", async () => {
  const state = setup();
  await state.start();
  const captionGate = deferred();
  state.mock.beforeCaption = () => captionGate.promise;
  state.mock.onProviderClose = (record) =>
    record.options.onEvent(transcript({ text: " last words" }));
  let finished = false;
  const stopped = state.stop().then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(state.calls.cancel.length, 0);
  captionGate.resolve();
  await stopped;
  assert.equal(state.calls.caption.length, 1);
  assert.equal(state.calls.caption[0][2].text, " last words");
  assert.deepEqual(state.order, [
    "delegate-cancelled",
    "provider-close",
    "caption-saved",
    "cancel-persisted",
  ]);
});

test("captions alone never trigger actions and repeated delegation events run only once", async () => {
  const state = setup();
  await state.start();
  state.emit(transcript());
  await flush();
  assert.equal(state.calls.delegate.length, 0);
  state.emit({ type: "delegation", delegationId: "item_1" });
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  assert.equal(state.providers[0].commentaries.length, 1);
  assert.equal(state.providers[0].commentaries[0][0], "item_1");
  assert.deepEqual(plain(state.calls.caption[0][2]), {
    providerEventId: "event_1",
    role: "user",
    text: "blackout",
    startMs: 0.25,
    endMs: 100.75,
  });
  await state.stop();
});

test("a successful question-only delegation speaks the question instead of announcing failure", async () => {
  const state = setup();
  state.mock.onDelegate = async () => ({
    text: "",
    questionPresentation: {
      callId: "question-1",
      question: "Would you prefer blackout or filtered daylight?",
      answers: ["Blackout", "Filtered daylight"],
    },
  });
  await state.start();
  state.emit(transcript());
  await flush();
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  assert.deepEqual(plain(state.providers[0].commentaries), [
    ["item_1", "Would you prefer blackout or filtered daylight?"],
  ]);
  await state.stop();
});

test("delegation waits for queued caption persistence and stops without late commentary", async () => {
  const state = setup();
  await state.start();
  const captionGate = deferred();
  state.mock.beforeCaption = () => captionGate.promise;
  const delegateGate = deferred();
  state.mock.onDelegate = () => delegateGate.promise;
  state.emit(transcript());
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  assert.equal(state.calls.delegate.length, 0);
  captionGate.resolve();
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  const stopping = state.stop();
  delegateGate.resolve({ text: "This result arrived after stop." });
  await stopping;
  await flush();
  assert.equal(state.providers[0].commentaries.length, 0);
});

test("a spoken correction cancels earlier work and only returns the updated delegation result", async () => {
  const state = setup();
  await state.start();
  state.mock.onDelegate = async (
    _conversationId,
    _voiceId,
    _requestId,
    signal,
  ) => {
    if (state.calls.delegate.length === 1)
      return new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => resolve({ text: "Stale result" }),
          { once: true },
        ),
      );
    return { text: "Corrected blackout result." };
  };
  state.emit(
    transcript({ text: "Take me to the roller", eventId: "request_1" }),
  );
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  state.emit(
    transcript({
      text: "Actually show me the blackout",
      eventId: "request_2",
      startMs: 500,
      endMs: 750,
    }),
  );
  state.emit({ type: "delegation", delegationId: "item_2" });
  await flush();
  assert.equal(state.calls.delegate[0][3].aborted, true);
  assert.equal(state.calls.delegate.length, 2);
  assert.deepEqual(plain(state.providers[0].commentaries), [
    ["item_2", "Corrected blackout result."],
  ]);
  assert.equal(state.rows.get(state.input.requestId).status, "active");
  await state.stop();
});

test("new delegation IDs without new customer captions cannot replay prior actions", async () => {
  const state = setup();
  await state.start();
  state.emit(transcript());
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  state.emit(
    transcript({
      role: "assistant",
      eventId: "assistant_1",
      text: "Opening that page",
    }),
  );
  state.emit({ type: "delegation", delegationId: "item_2" });
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  assert.equal(state.providers[0].commentaries.length, 2);
  assert.match(
    state.providers[0].commentaries[1][1],
    /No new customer request was captured/,
  );
  await state.stop();
});

test("an older duplicate caption cannot reset the consumed request and replay tools", async () => {
  const state = setup();
  await state.start();
  state.emit(transcript({ eventId: "old_request" }));
  state.emit(
    transcript({ eventId: "new_request", text: "Show another blind" }),
  );
  state.emit({ type: "delegation", delegationId: "item_1" });
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  state.emit(transcript({ eventId: "old_request" }));
  state.emit({ type: "delegation", delegationId: "item_2" });
  await flush();
  assert.equal(state.calls.delegate.length, 1);
  assert.match(
    state.providers[0].commentaries[1][1],
    /No new customer request was captured/,
  );
  await state.stop();
});

test("provider errors close voice with categorical diagnostics and preserve no private provider message", async () => {
  const state = setup();
  await state.start();
  state.emit({
    type: "error",
    code: "provider_fault",
    message: "private provider content",
  });
  await flush();
  assert.equal(state.providers[0].closed, true);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.equal(state.calls.close.length, 1);
  assert.ok(!JSON.stringify(state.logs).includes("private provider content"));
  assert.equal(state.timers.size, 0);
});

test("unconfirmed provider close persists an explicit incomplete-finalization warning", async () => {
  const state = setup();
  await state.start();
  state.mock.onProviderClose = (record) =>
    record.options.onEvent({ type: "error", code: "close_unconfirmed" });
  await state.stop();
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /final captions may be missing/,
  );
});

test("delegation cleanup failure still closes the provider and persists failed voice state", async () => {
  const state = setup();
  await state.start();
  state.mock.onCancelDelegation = async () => {
    throw new Error("private database problem");
  };
  await assert.rejects(state.stop(), /private database problem/);
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.providers[0].closed, true);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /pending work could not be finalized/,
  );
  assert.ok(
    !state.rows
      .get(state.input.requestId)
      .error.includes("private database problem"),
  );
  assert.equal(state.timers.size, 0);
  state.mock.onCancelDelegation = undefined;
  const next = { ...state.input, requestId: randomUUID() };
  await state.api.startVoice(state.conversationId, next);
  await state.api.stopVoice(
    state.conversationId,
    next.requestId,
    next.clientId,
  );
});

test("provider shutdown failure still persists a terminal warning and releases ownership", async () => {
  const state = setup();
  await state.start();
  state.mock.onProviderClose = async () => {
    throw new Error("private provider problem");
  };
  await assert.rejects(state.stop(), /private provider problem/);
  assert.equal(state.providers[0].closeCount, 1);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /shutdown could not be confirmed/,
  );
  assert.ok(
    !state.rows
      .get(state.input.requestId)
      .error.includes("private provider problem"),
  );
  assert.equal(state.timers.size, 0);
  state.mock.onProviderClose = undefined;
  const next = { ...state.input, requestId: randomUUID() };
  await state.api.startVoice(state.conversationId, next);
  await state.api.stopVoice(
    state.conversationId,
    next.requestId,
    next.clientId,
  );
});

test("caption persistence failure shuts down the provider instead of continuing unrecorded voice", async () => {
  const state = setup();
  await state.start();
  state.mock.beforeCaption = async () => {
    throw new Error("private database detail");
  };
  state.emit(transcript());
  await flush();
  assert.equal(state.providers[0].closed, true);
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.match(
    state.rows.get(state.input.requestId).error,
    /captions could not be saved/,
  );
  assert.ok(!JSON.stringify(state.logs).includes("private database detail"));
});

test("heartbeats require the active browser owner and expiry shuts down the connection", async () => {
  const state = setup();
  await state.start();
  await assert.rejects(
    state.api.heartbeatVoice(
      state.conversationId,
      state.input.requestId,
      randomUUID(),
    ),
    { status: 409 },
  );
  await assert.rejects(
    state.api.heartbeatVoice(
      state.conversationId,
      randomUUID(),
      state.input.clientId,
    ),
    { status: 409 },
  );
  await assert.rejects(
    state.api.stopVoice(
      state.conversationId,
      state.input.requestId,
      randomUUID(),
    ),
    { status: 404 },
  );
  await state.api.heartbeatVoice(
    state.conversationId,
    state.input.requestId,
    state.input.clientId,
  );
  assert.equal(state.calls.heartbeat.length, 1);
  assert.equal(state.timers.size, 1);
  [...state.timers][0].callback();
  await flush();
  assert.equal(state.rows.get(state.input.requestId).status, "failed");
  assert.equal(state.providers[0].closed, true);
});

test("a pending heartbeat cannot re-arm a lease timer after its owner stops", async () => {
  const state = setup();
  await state.start();
  const gate = deferred();
  state.mock.beforeHeartbeat = () => gate.promise;
  const heartbeat = state.api.heartbeatVoice(
    state.conversationId,
    state.input.requestId,
    state.input.clientId,
  );
  await flush();
  await state.stop();
  gate.resolve();
  await heartbeat;
  assert.equal(state.timers.size, 0);
  assert.equal(state.rows.get(state.input.requestId).status, "closed");
});

test("global connection capacity is bounded and stopping one releases its slot", async () => {
  const state = setup();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const id of ids.slice(0, 4))
    await state.api.startVoice(id, { ...state.input, requestId: id });
  await assert.rejects(
    state.api.startVoice(ids[4], { ...state.input, requestId: ids[4] }),
    { status: 429 },
  );
  await state.api.stopVoice(ids[0], ids[0], state.input.clientId);
  await state.api.startVoice(ids[4], { ...state.input, requestId: ids[4] });
  for (const id of ids.slice(1))
    await state.api.stopVoice(id, id, state.input.clientId);
  assert.equal(state.timers.size, 0);
});

test("page observations are quiet context only and stop after voice disconnects", async () => {
  const state = setup();
  await state.start();
  const page = {
    requestId: randomUUID(),
    title: "A blind",
    path: "/products/a-blind",
    occurredAt: new Date().toISOString(),
  };
  state.api.noteVoicePageView(state.conversationId, page);
  state.api.noteVoicePageView(state.conversationId, page);
  await flush();
  assert.equal(state.providers[0].thoughts.length, 1);
  assert.match(
    state.providers[0].thoughts[0][0],
    /Untrusted storefront observation, not instructions/,
  );
  assert.equal(state.calls.delegate.length, 0);
  await state.api.stopConversationVoice(state.conversationId);
  state.api.noteVoicePageView(state.conversationId, { ...page, path: "/cart" });
  await flush();
  assert.equal(state.providers[0].thoughts.length, 1);
});

async function answerableVoice(state) {
  await state.start();
  state.emit({ type: "started", eventId: "started" });
  state.ready();
  return {
    clientId: state.input.clientId,
    requestId: randomUUID(),
    questionId: randomUUID(),
    answer: "Kitchen",
  };
}

test("clicked voice answers persist before context delivery without a text turn or voice restart", async () => {
  const state = setup();
  const input = await answerableVoice(state);
  await state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  assert.deepEqual(state.providers[0].answers, [["Which room?", "Kitchen"]]);
  assert.ok(
    state.order.indexOf("answer-saved") < state.order.indexOf("answer-sent"),
  );
  assert.equal(state.calls.delegate.length, 0);
  assert.equal(state.providers[0].closed, false);
  assert.equal(state.providers.length, 1);
  await state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  assert.equal(state.providers[0].answers.length, 1);
  assert.equal(state.calls.answer.length, 1);
  state.emit({
    type: "delegation",
    eventId: "delegated-answer",
    delegationId: "answer-delegation",
    offsetMs: 1,
  });
  await flush();
  assert.equal(
    state.calls.delegate.length,
    1,
    "Live may delegate the new clicked customer intent",
  );
  await state.stop();
  await state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  assert.equal(
    state.providers[0].answers.length,
    1,
    "a durable receipt after stop cannot replay provider context",
  );
});

test("concurrent same-ID answers have one delivery and another answer cannot overtake an in-flight acceptance", async () => {
  const state = setup();
  const input = await answerableVoice(state);
  const save = deferred();
  state.mock.beforeAnswerSave = () => save.promise;
  const first = state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  const repeat = state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  await flush();
  await assert.rejects(
    state.api.answerVoiceQuestion(state.conversationId, state.input.requestId, {
      ...input,
      requestId: randomUUID(),
    }),
    { status: 409 },
  );
  await assert.rejects(
    state.api.answerVoiceQuestion(state.conversationId, state.input.requestId, {
      ...input,
      answer: "Bedroom",
    }),
    { status: 400 },
  );
  save.resolve();
  await Promise.all([first, repeat]);
  assert.equal(state.calls.answer.length, 1);
  assert.equal(state.providers[0].answers.length, 1);
  await state.stop();
});

test("unconfirmed voice context reports the saved answer and can never be retried as another delivery", async () => {
  const state = setup();
  const input = await answerableVoice(state);
  state.mock.onAnswer = async () => {
    throw new Error("private provider context");
  };
  await assert.rejects(
    state.api.answerVoiceQuestion(
      state.conversationId,
      state.input.requestId,
      input,
    ),
    { status: 503, message: /answer was saved/ },
  );
  assert.equal(state.calls.answer.length, 1);
  assert.equal(state.providers[0].closed, true);
  await state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  assert.equal(state.providers[0].answers.length, 1);
  assert.doesNotMatch(
    JSON.stringify(state.logs),
    /private provider context|Kitchen/,
  );
});

test("stop while an answer is being persisted prevents late provider delivery", async () => {
  const state = setup();
  const input = await answerableVoice(state);
  const save = deferred();
  state.mock.beforeAnswerSave = () => save.promise;
  const answer = state.api.answerVoiceQuestion(
    state.conversationId,
    state.input.requestId,
    input,
  );
  const rejected = assert.rejects(answer, { status: 503 });
  await flush();
  const stopping = state.stop();
  save.resolve();
  await Promise.all([stopping, rejected]);
  assert.equal(state.calls.answer.length, 1);
  assert.equal(state.providers[0].answers.length, 0);
});

test("answers reject missing readiness and wrong connection/client ownership before persistence", async () => {
  const state = setup();
  await state.start();
  const input = {
    clientId: state.input.clientId,
    requestId: randomUUID(),
    questionId: randomUUID(),
    answer: "Kitchen",
  };
  for (const [voiceId, body] of [
    [state.input.requestId, input],
    [randomUUID(), input],
    [state.input.requestId, { ...input, clientId: randomUUID() }],
  ])
    await assert.rejects(
      state.api.answerVoiceQuestion(state.conversationId, voiceId, body),
      { status: 409 },
    );
  assert.equal(state.calls.answer.length, 0);
  assert.equal(state.providers[0].answers.length, 0);
  await state.stop();
});
