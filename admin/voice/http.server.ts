import {
  DEFAULT_LIVE_VOICE,
  isLiveVoice,
  type LiveVoice,
} from "../../shared/voice";
import { UUID_PATTERN } from "../conversations/auth.server";
import { ConversationError } from "../conversations/errors.server";
import type { VoiceSelectionInput } from "../../shared/questions";
import { parseProductChoice } from "../../shared/product-choice";

export const VOICE_START_BODY_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 48 * 1024;

export function voiceStartInput(value: Record<string, unknown>): {
  requestId: string;
  clientId: string;
  sdp: string;
  voice: LiveVoice;
} {
  if (
    Object.keys(value).some(
      (key) => !["requestId", "clientId", "sdp", "voice"].includes(key),
    ) ||
    ("voice" in value && !isLiveVoice(value.voice)) ||
    typeof value.requestId !== "string" ||
    !UUID_PATTERN.test(value.requestId) ||
    typeof value.clientId !== "string" ||
    !UUID_PATTERN.test(value.clientId) ||
    typeof value.sdp !== "string" ||
    !value.sdp.trim() ||
    Buffer.byteLength(value.sdp, "utf8") > MAX_SDP_BYTES
  ) {
    throw new ConversationError(
      400,
      "Send requestId and clientId UUIDs, a voice connection offer up to 48 KiB, and an optional built-in Live voice.",
    );
  }
  return {
    requestId: value.requestId,
    clientId: value.clientId,
    sdp: value.sdp,
    voice:
      value.voice === undefined
        ? DEFAULT_LIVE_VOICE
        : (value.voice as LiveVoice),
  };
}

export function voiceClientInput(value: Record<string, unknown>): {
  clientId: string;
} {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.clientId !== "string" ||
    !UUID_PATTERN.test(value.clientId)
  ) {
    throw new ConversationError(400, "Send only a clientId UUID.");
  }
  return { clientId: value.clientId };
}

export function voiceStopInput(value: Record<string, unknown>): {
  clientId: string;
  reason?: "connection_lost";
} {
  if (
    Object.keys(value).some((key) => !["clientId", "reason"].includes(key)) ||
    ("reason" in value && value.reason !== "connection_lost")
  )
    throw new ConversationError(
      400,
      "Send a clientId UUID and an optional connection_lost stop reason.",
    );
  return {
    ...voiceClientInput({ clientId: value.clientId }),
    ...(value.reason === "connection_lost"
      ? { reason: "connection_lost" as const }
      : {}),
  };
}

export function voiceSessionId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new ConversationError(400, "Send a valid voice session ID.");
  }
  return value;
}

export function voiceAnswerInput(
  value: Record<string, unknown>,
): VoiceSelectionInput {
  if ("carouselId" in value) {
    const { clientId, requestId, ...choice } = value;
    try {
      if (
        typeof clientId !== "string" ||
        !UUID_PATTERN.test(clientId) ||
        typeof requestId !== "string" ||
        !UUID_PATTERN.test(requestId)
      )
        throw new Error("Invalid request identity.");
      return { clientId, requestId, ...parseProductChoice(choice) };
    } catch {
      throw new ConversationError(
        400,
        "Send a valid carousel product choice and request identity.",
      );
    }
  }
  if (
    Object.keys(value).length !== 4 ||
    !["clientId", "requestId", "questionId"].every(
      (key) => typeof value[key] === "string" && UUID_PATTERN.test(value[key]),
    ) ||
    typeof value.answer !== "string" ||
    !value.answer.trim() ||
    value.answer.length > 80
  )
    throw new ConversationError(
      400,
      "Send clientId, requestId and questionId UUIDs with an offered answer.",
    );
  return {
    clientId: value.clientId as string,
    requestId: value.requestId as string,
    questionId: value.questionId as string,
    answer: value.answer,
  };
}
