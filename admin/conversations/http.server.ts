import {
  parseProductChoice,
  productChoiceText,
} from "../../shared/product-choice";
import {
  MAX_MESSAGE_LENGTH,
  type SendMessageInput,
  type JourneyInput,
  type ToolClaim,
  type ToolClaimInput,
} from "../../shared/conversation";
import { allowedOrigin, UUID_PATTERN } from "./auth.server";
import {
  ConversationError,
  ServiceUnavailableError,
} from "./errors.server";

const MAX_BODY_BYTES = 32768;
const errorCodes: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
  409: "busy",
  429: "limit",
  503: "unavailable",
};

function headersFor(request: Request) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  });
  const origin = allowedOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
  return headers;
}

export async function handleJsonRequest(
  request: Request,
  method: "GET" | "POST",
  operation: () => Promise<unknown>,
  status = 200,
): Promise<Response> {
  const headers = headersFor(request);
  try {
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(request))
        throw new ConversationError(
          401,
          "Storefront origin is not authorized.",
        );
      // Cache only permission to make the cross-origin request. Every actual
      // request still authenticates independently and its response is no-store.
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== method) {
      headers.set("Allow", `${method}, OPTIONS`);
      return Response.json(
        { error: { code: "invalid_request", message: "Method not allowed." } },
        { status: 405, headers },
      );
    }
    return Response.json(await operation(), { status, headers });
  } catch (error) {
    const known =
      error instanceof ConversationError && error.status in errorCodes;
    if (!known)
      console.error("[Roman] Conversation request failed.", {
        route:
          [
            "messages",
            "journey",
            "end",
            "claim",
            "result",
            "bootstrap",
            "voice",
            "ready",
            "heartbeat",
            "stop",
          ].find((route) =>
            new URL(request.url).pathname.endsWith(`/${route}`),
          ) ?? "conversation",
        category: error instanceof Error ? error.name : "UnknownError",
      });
    return Response.json(
      {
        error: {
          code:
            error instanceof ServiceUnavailableError
              ? "SERVICE_UNAVAILABLE"
              : known
                ? errorCodes[error.status]
                : "server_error",
          message: known
            ? error.message
            : "Roman is temporarily unavailable. Please try again later.",
        },
      },
      { status: known ? error.status : 500, headers },
    );
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new ConversationError(400, "Send an application/json request body.");
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    throw new ConversationError(400, "The request body is too large.");
  if (!request.body)
    throw new ConversationError(400, "A JSON request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationError(400, "The request body is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    throw new ConversationError(400, "The request body could not be read.");
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConversationError(400, "Send a valid JSON request body.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConversationError(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}

export function bootstrapInput(value: Record<string, unknown>) {
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  if (
    keys.length !== 2 ||
    !keys.includes("conversationId") ||
    !keys.includes("token") ||
    typeof value.conversationId !== "string" ||
    !UUID_PATTERN.test(value.conversationId) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token)
  )
    throw new ConversationError(
      400,
      "Send an empty object or the saved conversationId and token.",
    );
  return { conversationId: value.conversationId, token: value.token };
}

export function messageInput(value: Record<string, unknown>): SendMessageInput {
  const keys = Object.keys(value);
  if (
    keys.length !== (value.productChoice === undefined ? 2 : 3) ||
    !keys.includes("requestId") ||
    !keys.includes("text") ||
    typeof value.requestId !== "string" ||
    !UUID_PATTERN.test(value.requestId) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > MAX_MESSAGE_LENGTH
  )
    throw new ConversationError(
      400,
      `Send a requestId UUID and 1â€“${MAX_MESSAGE_LENGTH} characters of text.`,
    );
  let productChoice;
  if (value.productChoice !== undefined) {
    try {
      productChoice = parseProductChoice(value.productChoice);
      if (value.text.trim() !== productChoiceText(productChoice))
        throw new Error();
    } catch {
      throw new ConversationError(
        400,
        "Send a valid carousel choice and its matching message.",
      );
    }
  }
  return {
    requestId: value.requestId,
    text: value.text.trim(),
    ...(productChoice ? { productChoice } : {}),
  };
}

export function journeyInput(value: Record<string, unknown>): JourneyInput {
  if (
    Object.keys(value).length !== 4 ||
    typeof value.requestId !== "string" ||
    !UUID_PATTERN.test(value.requestId) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 200 ||
    typeof value.path !== "string" ||
    value.path.length > 2048 ||
    typeof value.occurredAt !== "string" ||
    value.occurredAt.length > 40 ||
    !Number.isFinite(Date.parse(value.occurredAt))
  )
    throw new ConversationError(
      400,
      "Send a requestId UUID, page title, storefront path and occurredAt timestamp.",
    );
  return {
    requestId: value.requestId,
    title: value.title.trim(),
    path: value.path,
    occurredAt: value.occurredAt,
  };
}

function parseClaim(value: Record<string, unknown>): ToolClaim {
  if (
    typeof value.clientId !== "string" ||
    !UUID_PATTERN.test(value.clientId) ||
    typeof value.claimToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.claimToken)
  )
    throw new ConversationError(400, "Send a valid catalog executor claim.");
  return { clientId: value.clientId, claimToken: value.claimToken };
}

export function claimInput(value: Record<string, unknown>): ToolClaimInput {
  const confirmed = value.confirmed;
  if (
    Object.keys(value).length !== (confirmed === undefined ? 2 : 3) ||
    (confirmed !== undefined && typeof confirmed !== "boolean")
  )
    throw new ConversationError(
      400,
      "Send clientId, claimToken and an optional shopper confirmation boolean.",
    );
  return {
    ...parseClaim(value),
    ...(confirmed === undefined ? {} : { confirmed }),
  };
}

export function toolResultInput(value: Record<string, unknown>): {
  claim: ToolClaim;
  result?: unknown;
  error?: string;
} {
  const claim = parseClaim(value);
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.includes("result") === keys.includes("error"))
    throw new ConversationError(
      400,
      "Send a catalog result or an error with the executor claim.",
    );
  if (keys.includes("error")) {
    if (
      typeof value.error !== "string" ||
      !value.error.trim() ||
      value.error.length > 500
    )
      throw new ConversationError(
        400,
        "Send a catalog error of up to 500 characters.",
      );
    return { claim, error: value.error.trim() };
  }
  return { claim, result: value.result };
}

export function emptyInput(value: Record<string, unknown>): void {
  if (Object.keys(value).length)
    throw new ConversationError(400, "Send an empty JSON object.");
}

export function toolInvocationId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value))
    throw new ConversationError(400, "Send a valid catalog invocation ID.");
  return value;
}
