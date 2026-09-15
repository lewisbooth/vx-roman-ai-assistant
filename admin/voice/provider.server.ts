import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { VoiceUsage } from "../usage/contracts";
import { SidebandWS } from "openai/resources/live/sideband/ws";
import type { ConnectServerEvent } from "openai/resources/live/sideband/sideband";
import type { InitialItem } from "openai/resources/live/live";
import {
  ROMAN_VOICE_PROMPT,
  ROMAN_VOICE_OPENING_PROMPTS,
  ROMAN_VOICE_OPENING_CUE,
} from "../prompts/roman.server";

export const VOICE_MODEL = "gpt-live-1";
const STARTUP_MS = 15_000;
const COMMAND_MS = 3_000;
const MAX_CONTEXT_CHARACTERS = 1_200;
const consumedEventTypes = new Set([
  "session.started",
  "session.closed",
  "session.input_transcript.delta",
  "session.output_transcript.delta",
  "session.delegation.created",
  "session.instructions.appended",
  "session.thinking.appended",
  "session.commentary.appended",
  "error",
]);

export interface VoiceHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export type VoiceProviderErrorCode =
  | "connection_failed"
  | "invalid_event"
  | "command_failed"
  | "startup_timeout"
  | "close_unconfirmed";

export type VoiceProviderEvent =
  | { type: "started"; eventId: string }
  | {
      type: "transcript";
      eventId: string;
      role: "user" | "assistant";
      text: string;
      startMs: number;
      endMs: number;
    }
  | {
      type: "delegation";
      eventId: string;
      delegationId: string;
      offsetMs: number;
    }
  | { type: "closed"; reason: string; confirmed: boolean; usage?: VoiceUsage }
  | { type: "error"; code: VoiceProviderErrorCode };

export interface VoiceProvider {
  providerId: string;
  sdp: string;
  beginConversation(): Promise<void>;
  appendThinking(text: string): Promise<void>;
  appendCommentary(delegationId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export class VoiceProviderError extends Error {
  constructor(readonly code: VoiceProviderErrorCode) {
    super(`Voice provider ${code}.`);
    this.name = "VoiceProviderError";
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function initialHistory(
  history: readonly VoiceHistoryMessage[],
): InitialItem[] {
  const selected: InitialItem[] = [];
  let remaining = 6_000;
  // A conservative UTF-8 byte budget leaves room for message framing within
  // Live's 8,192-token history limit, including non-English conversation.
  for (
    let index = history.length - 1;
    index >= 0 && selected.length < 128;
    index--
  ) {
    const message = history[index];
    if (!message.text.trim()) continue;
    const bytes = Buffer.byteLength(message.text, "utf8");
    if (bytes > remaining) break;
    selected.unshift(
      message.role === "assistant"
        ? { role: "assistant", content: [{ type: "text", text: message.text }] }
        : {
            role: "user",
            content: [{ type: "input_text", text: message.text }],
          },
    );
    remaining -= bytes;
  }
  return selected;
}

let client: OpenAI | undefined;

export async function createVoiceProvider(options: {
  sdp: string;
  history: readonly VoiceHistoryMessage[];
  onEvent(event: VoiceProviderEvent): void;
  signal: AbortSignal;
}): Promise<VoiceProvider> {
  options.signal.throwIfAborted();
  // Choose before truncating Live's context; page observations alone are not a
  // previous exchange with Roman.
  const openingPrompt = options.history.some(
    (message) => message.role === "assistant" && message.text.trim(),
  )
    ? ROMAN_VOICE_OPENING_PROMPTS.resumedConversation
    : ROMAN_VOICE_OPENING_PROMPTS.newConversation;
  try {
    client ??= new OpenAI({ maxRetries: 0, timeout: STARTUP_MS });
  } catch {
    throw new VoiceProviderError("connection_failed");
  }
  const startup = new AbortController();
  let timedOut = false;
  let sideband: SidebandWS | undefined;
  let closing = false;
  let closed = false;
  const providerModel = VOICE_MODEL;
  let closePromise: Promise<void> | undefined;
  let finishClose: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let failOpen: ((error: Error) => void) | undefined;
  const commands = new Map<
    string,
    {
      type: string;
      timer: ReturnType<typeof setTimeout>;
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  const knownDelegations = new Set<string>();

  const emit = (event: VoiceProviderEvent) => {
    options.onEvent(event);
  };
  const stop = (
    reason: string,
    confirmed: boolean,
    usage: VoiceUsage = { model: providerModel, seconds: null },
  ) => {
    if (closed) return;
    closed = true;
    closing = true;
    if (closeTimer) clearTimeout(closeTimer);
    options.signal.removeEventListener("abort", abort);
    failOpen?.(new VoiceProviderError("connection_failed"));
    for (const command of commands.values()) {
      clearTimeout(command.timer);
      command.reject(new VoiceProviderError("command_failed"));
    }
    commands.clear();
    knownDelegations.clear();
    // Keep the SDK error listener until the socket dies: it turns an unhandled
    // socket error into a rejected promise when no listener is registered.
    sideband?.off("event", onEvent);
    sideband?.off("close", onSocketClose);
    sideband?.socket.off("open", sendClose);
    sideband?.close();
    sideband?.socket.platformSocket.terminate();
    finishClose?.();
    emit({ type: "closed", reason, confirmed, usage });
  };
  const sendClose = () => {
    if (!closed && sideband?.socket.readyState === 1) {
      sideband.send({ type: "session.close", event_id: randomUUID() });
    }
  };
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise<void>((resolve) => {
      finishClose = resolve;
      closeTimer = setTimeout(() => {
        emit({ type: "error", code: "close_unconfirmed" });
        stop("close_timeout", false);
      }, COMMAND_MS);
      if (sideband?.socket.readyState === 0)
        sideband.socket.on("open", sendClose);
      else sendClose();
    });
    return closePromise;
  };
  const fail = (code: VoiceProviderErrorCode) => {
    if (closed || closing) return;
    failOpen?.(new VoiceProviderError(code));
    emit({ type: "error", code });
    void close();
  };
  const abort = () => {
    startup.abort();
    failOpen?.(new VoiceProviderError("connection_failed"));
    if (sideband) void close();
  };
  const onSocketClose = () => {
    if (!closed) {
      emit({ type: "error", code: "connection_failed" });
      stop("connection_lost", false);
    }
  };
  const onError = () => fail("connection_failed");
  const onEvent = (event: ConnectServerEvent) => {
    if (closed) return;
    const eventType: string | undefined = event?.type;
    // Live reflects audio to trusted sidebands without event_id. Those frames
    // are documented by the native Live schema but absent from this SDK's
    // sideband union. WebRTC owns playback; Roman never stores reflected audio.
    if (
      eventType === "session.input_audio.append" ||
      eventType === "session.output_audio.delta"
    )
      return;
    // Validate the events we consume, not every future provider event envelope.
    if (!eventType || !consumedEventTypes.has(eventType)) return;
    let invalidField = "event_id";
    try {
      if (!identifier(event.event_id))
        throw new VoiceProviderError("invalid_event");
      if (event.type === "session.closed") {
        invalidField = "reason";
        const reasons = [
          "close_requested",
          "expired",
          "content",
          "remote_hangup",
          "connection_lost",
        ];
        if (!reasons.includes(event.reason))
          throw new VoiceProviderError("invalid_event");
        const seconds = event.usage?.seconds;
        const validSeconds =
          typeof seconds === "number" &&
          Number.isFinite(seconds) &&
          seconds >= 0 &&
          seconds <= Number.MAX_SAFE_INTEGER;
        if (seconds !== undefined && !validSeconds)
          console.error("[Roman] Provider usage was unavailable.", {
            provider: "live",
            field: "usage.seconds",
          });
        const model = event.session?.model;
        invalidField = "event_handler";
        stop(event.reason, true, {
          model:
            typeof model === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(model)
              ? model
              : providerModel,
          seconds: validSeconds ? seconds : null,
        });
      } else if (event.type === "session.started") {
        invalidField = "event_handler";
        emit({ type: "started", eventId: event.event_id });
      } else if (
        event.type === "session.input_transcript.delta" ||
        event.type === "session.output_transcript.delta"
      ) {
        invalidField = "delta";
        if (typeof event.delta !== "string" || event.delta.length > 2_000) {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "start_ms";
        if (!timestamp(event.start_ms)) {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "end_ms";
        if (!timestamp(event.end_ms) || event.end_ms < event.start_ms) {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "event_handler";
        if (event.delta)
          emit({
            type: "transcript",
            eventId: event.event_id,
            role:
              event.type === "session.input_transcript.delta"
                ? "user"
                : "assistant",
            text: event.delta,
            startMs: event.start_ms,
            endMs: event.end_ms,
          });
      } else if (event.type === "session.delegation.created" && !closing) {
        invalidField = "delegation.id";
        if (!identifier(event.delegation?.id)) {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "delegation.target";
        if (event.delegation.target !== "client") {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "offset_ms";
        if (!timestamp(event.offset_ms)) {
          throw new VoiceProviderError("invalid_event");
        }
        invalidField = "delegation_limit";
        if (
          knownDelegations.size >= 128 &&
          !knownDelegations.has(event.delegation.id)
        ) {
          throw new VoiceProviderError("invalid_event");
        }
        knownDelegations.add(event.delegation.id);
        invalidField = "event_handler";
        emit({
          type: "delegation",
          eventId: event.event_id,
          delegationId: event.delegation.id,
          offsetMs: event.offset_ms,
        });
      } else if (
        event.type === "session.instructions.appended" ||
        event.type === "session.thinking.appended" ||
        event.type === "session.commentary.appended"
      ) {
        invalidField = "client_event_id";
        if (
          event.client_event_id !== undefined &&
          !identifier(event.client_event_id)
        ) {
          throw new VoiceProviderError("invalid_event");
        }
        const command = event.client_event_id
          ? commands.get(event.client_event_id)
          : undefined;
        if (command?.type === event.type) {
          clearTimeout(command.timer);
          commands.delete(event.client_event_id!);
          command.resolve();
        }
      } else if (event.type === "error") {
        fail("command_failed");
      }
    } catch {
      console.error("[Roman] Voice provider event rejected.", {
        type: eventType,
        field: invalidField,
      });
      fail("invalid_event");
    }
  };

  options.signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    startup.abort();
    failOpen?.(new VoiceProviderError("startup_timeout"));
  }, STARTUP_MS);
  try {
    const created = await client.live.create(
      {
        session: {
          model: VOICE_MODEL,
          audio: { output: { voice: "ballad" } },
          store: false,
          delegation: { type: "client" },
          instructions: ROMAN_VOICE_PROMPT,
          input: initialHistory(options.history),
          client: {
            data_channel: {
              allowed_client_events: [],
              allowed_server_events: [
                { type: "session.started" },
                { type: "session.closed" },
                { type: "error" },
              ],
            },
          },
        },
        transport: { type: "webrtc", sdp: options.sdp },
      },
      { signal: startup.signal },
    );
    if (!identifier(created.session?.id)) {
      throw new VoiceProviderError("invalid_event");
    }
    sideband = new SidebandWS(
      client,
      { session_id: created.session.id, graceful_close: true },
      {
        reconnect: null,
        maxQueueSize: 8_192,
        handshakeTimeout: STARTUP_MS,
        maxPayload: 131_072,
      },
    );
    sideband.on("error", onError);
    sideband.on("event", onEvent);
    sideband.on("close", onSocketClose);
    if (
      created.transport?.type !== "webrtc" ||
      typeof created.transport.sdp !== "string" ||
      !created.transport.sdp ||
      created.transport.sdp.length > 65_536
    ) {
      throw new VoiceProviderError("invalid_event");
    }
    // Attach the trusted observer before returning the SDP answer. Waiting for
    // session.started here can deadlock startup until the browser applies it.
    await new Promise<void>((resolve, reject) => {
      const socket = sideband!.socket;
      const open = () => {
        socket.off("open", open);
        failOpen = undefined;
        resolve();
      };
      failOpen = (error) => {
        socket.off("open", open);
        reject(error);
      };
      if (startup.signal.aborted || options.signal.aborted) {
        failOpen(
          new VoiceProviderError(
            timedOut ? "startup_timeout" : "connection_failed",
          ),
        );
      } else if (socket.readyState === 1) open();
      else socket.on("open", open);
    });
    options.signal.throwIfAborted();
    if (timedOut || closing)
      throw new VoiceProviderError(
        timedOut ? "startup_timeout" : "connection_failed",
      );

    const append = (
      type: "instructions" | "thinking" | "commentary",
      delegationId: string | null,
      text: string,
    ) => {
      if (
        closed ||
        closing ||
        options.signal.aborted ||
        sideband?.socket.readyState !== 1 ||
        !text.trim() ||
        text.length > MAX_CONTEXT_CHARACTERS ||
        commands.size >= 4 ||
        (delegationId !== null && !knownDelegations.has(delegationId))
      ) {
        return Promise.reject(new VoiceProviderError("command_failed"));
      }
      const eventId = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          commands.delete(eventId);
          reject(new VoiceProviderError("command_failed"));
          fail("command_failed");
        }, COMMAND_MS);
        commands.set(eventId, {
          type: `session.${type}.appended`,
          timer,
          resolve,
          reject,
        });
        sideband!.send({
          type: `session.${type}.append`,
          event_id: eventId,
          delegation_id: delegationId,
          content: text,
        });
      });
    };
    return {
      providerId: created.session.id,
      sdp: created.transport.sdp,
      beginConversation: async () => {
        await append("instructions", null, openingPrompt);
        await append("commentary", null, ROMAN_VOICE_OPENING_CUE);
      },
      appendThinking: (text) => append("thinking", null, text),
      appendCommentary: (delegationId, text) =>
        append("commentary", delegationId, text),
      close,
    };
  } catch (error) {
    if (sideband) await close();
    else options.signal.removeEventListener("abort", abort);
    if (options.signal.aborted)
      throw new VoiceProviderError("connection_failed");
    throw error instanceof VoiceProviderError
      ? error
      : new VoiceProviderError(
          timedOut ? "startup_timeout" : "connection_failed",
        );
  } finally {
    clearTimeout(deadline);
    failOpen = undefined;
  }
}
