import { UUID_PATTERN } from "../conversations/auth.server";
import { ConversationError } from "../conversations/errors.server";

export const VOICE_START_BODY_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 48 * 1024;

export function voiceStartInput(value: Record<string, unknown>): {
  requestId: string;
  clientId: string;
  sdp: string;
} {
  if (
    Object.keys(value).length !== 3 ||
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
      "Send requestId and clientId UUIDs and a voice connection offer up to 48 KiB.",
    );
  }
  return {
    requestId: value.requestId,
    clientId: value.clientId,
    sdp: value.sdp,
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

export function voiceSessionId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new ConversationError(400, "Send a valid voice session ID.");
  }
  return value;
}
