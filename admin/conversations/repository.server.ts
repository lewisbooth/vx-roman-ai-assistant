import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  Conversation,
  ConversationMessage as StoredMessage,
} from "@prisma/client";
import type {
  ConversationBootstrap,
  ConversationMessage,
  ConversationSnapshot,
  SendMessageInput,
} from "../../shared/conversation";
import { MAX_MESSAGE_LENGTH } from "../../shared/conversation";
import prisma from "../db.server";
import { ConversationError } from "./errors.server";

const processStartedAt = new Date();
const credentialLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const creationWindowMs = 24 * 60 * 60 * 1000;
const maxDailyConversationsPerShop = 100;
const maxTurns = 40;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StoredConversation = Conversation & { messages: StoredMessage[] };

function snapshot(conversation: StoredConversation): ConversationSnapshot {
  const messages = conversation.messages.map((message): ConversationMessage => {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      !["pending", "complete", "failed"].includes(message.status)
    ) {
      throw new Error("Invalid stored conversation message.");
    }
    return {
      id: message.id,
      role: message.role,
      status: message.status as ConversationMessage["status"],
      parts: [{ type: "text", text: message.text }],
      createdAt: message.createdAt.toISOString(),
      ...(message.error ? { error: message.error } : {}),
    };
  });
  return {
    id: conversation.id,
    messages,
    busy: messages.some((message) => message.status === "pending"),
  };
}

const withMessages = { messages: { orderBy: { sequence: "asc" as const } } };

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function unauthorized(): never {
  throw new ConversationError(
    401,
    "This chat has expired. Start a new chat to continue.",
  );
}

export function conversationApiBaseUrl(): string {
  const configuredUrl = process.env.SHOPIFY_APP_URL;
  if (!configuredUrl)
    throw new Error("SHOPIFY_APP_URL is required for storefront chat.");
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Storefront chat requires a public HTTPS SHOPIFY_APP_URL.");
  }
  return `${url.origin}/api/conversations`;
}

export async function createConversation(
  shop: string,
  origin: string,
): Promise<ConversationBootstrap> {
  const apiBaseUrl = conversationApiBaseUrl();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const conversation = await prisma.$transaction(async (transaction) => {
    const recentCount = await transaction.conversation.count({
      where: {
        shop,
        createdAt: { gte: new Date(now.getTime() - creationWindowMs) },
      },
    });
    if (recentCount >= maxDailyConversationsPerShop) {
      throw new ConversationError(
        429,
        "The daily chat limit has been reached. Please try again tomorrow.",
      );
    }
    return transaction.conversation.create({
      data: {
        id: randomUUID(),
        shop,
        origin,
        credentialHash: tokenHash(token),
        credentialExpiresAt: new Date(now.getTime() + credentialLifetimeMs),
      },
      include: withMessages,
    });
  });
  return {
    conversationId: conversation.id,
    token,
    expiresAt: conversation.credentialExpiresAt.toISOString(),
    apiBaseUrl,
    conversation: snapshot(conversation),
  };
}

export async function authorizeCredential(id: string, token: string) {
  if (!uuidPattern.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
    unauthorized();
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      origin: true,
      credentialHash: true,
      credentialExpiresAt: true,
    },
  });
  const suppliedHash = Buffer.from(tokenHash(token), "hex");
  const expectedHash = Buffer.from(
    conversation?.credentialHash ?? "0".repeat(64),
    "hex",
  );
  if (
    expectedHash.length !== suppliedHash.length ||
    !timingSafeEqual(expectedHash, suppliedHash) ||
    !conversation ||
    conversation.credentialExpiresAt.getTime() <= Date.now()
  )
    unauthorized();
  const installation = await prisma.session.findFirst({
    where: { shop: conversation.shop, isOnline: false },
    select: { accessToken: true, scope: true },
  });
  if (
    !installation?.accessToken ||
    !installation.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("write_app_proxy")
  )
    unauthorized();
  return {
    id: conversation.id,
    shop: conversation.shop,
    origin: conversation.origin,
    expiresAt: conversation.credentialExpiresAt,
  };
}

export async function getSnapshot(id: string): Promise<ConversationSnapshot> {
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: withMessages,
  });
  if (!conversation)
    throw new ConversationError(
      404,
      "This chat could not be found. Start a new chat.",
    );
  return snapshot(conversation);
}

export async function beginTurn(
  id: string,
  input: SendMessageInput,
): Promise<{
  snapshot: ConversationSnapshot;
  assistantId: string | null;
  history: { role: "user" | "assistant"; text: string }[];
}> {
  if (
    !uuidPattern.test(input.requestId) ||
    !input.text.trim() ||
    input.text.length > MAX_MESSAGE_LENGTH
  ) {
    throw new ConversationError(
      400,
      "Send a message of up to 4,000 characters with a valid request ID.",
    );
  }
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.findUnique({
      where: { id },
      include: withMessages,
    });
    if (!conversation)
      throw new ConversationError(
        404,
        "This chat could not be found. Start a new chat.",
      );
    const existing = conversation.messages.find(
      (message) =>
        message.requestId === input.requestId && message.role === "user",
    );
    if (existing) {
      if (existing.text !== input.text)
        throw new ConversationError(
          400,
          "This request ID was already used for a different message.",
        );
      return {
        snapshot: snapshot(conversation),
        assistantId: null,
        history: [],
      };
    }
    if (
      conversation.pendingRequestId ||
      conversation.messages.some((message) => message.status === "pending")
    ) {
      throw new ConversationError(
        409,
        "Roman is still replying. Wait for that reply before sending another message.",
      );
    }
    if (conversation.turnCount >= maxTurns) {
      throw new ConversationError(
        429,
        "This chat has reached its 40-message limit. Start a new chat to continue.",
      );
    }
    const claimed = await transaction.conversation.updateMany({
      where: { id, pendingRequestId: null, turnCount: conversation.turnCount },
      data: { pendingRequestId: input.requestId, turnCount: { increment: 1 } },
    });
    if (!claimed.count)
      throw new ConversationError(
        409,
        "Roman is still replying. Wait for that reply before sending another message.",
      );
    const assistantId = randomUUID();
    const now = new Date();
    await transaction.conversationMessage.createMany({
      data: [
        {
          id: randomUUID(),
          conversationId: id,
          requestId: input.requestId,
          sequence: conversation.turnCount * 2,
          role: "user",
          status: "complete",
          text: input.text,
          createdAt: now,
          completedAt: now,
        },
        {
          id: assistantId,
          conversationId: id,
          requestId: input.requestId,
          sequence: conversation.turnCount * 2 + 1,
          role: "assistant",
          status: "pending",
          createdAt: now,
        },
      ],
    });
    const updated = await transaction.conversation.findUniqueOrThrow({
      where: { id },
      include: withMessages,
    });
    return {
      snapshot: snapshot(updated),
      assistantId,
      history: updated.messages.flatMap((message) =>
        message.role === "user" ||
        (message.role === "assistant" && message.status === "complete")
          ? [{ role: message.role as "user" | "assistant", text: message.text }]
          : [],
      ),
    };
  });
}

export async function finishTurn(
  id: string,
  assistantId: string,
  result: {
    text: string;
    status: "complete" | "failed";
    error?: string;
    model?: string;
    serviceTier?: string;
  },
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const message = await transaction.conversationMessage.findFirst({
      where: {
        id: assistantId,
        conversationId: id,
        role: "assistant",
        status: "pending",
      },
    });
    if (!message) return;
    const finished = await transaction.conversationMessage.updateMany({
      where: { id: assistantId, conversationId: id, status: "pending" },
      data: { ...result, error: result.error ?? null, completedAt: new Date() },
    });
    if (finished.count) {
      await transaction.conversation.updateMany({
        where: { id, pendingRequestId: message.requestId },
        data: { pendingRequestId: null },
      });
    }
  });
}

export async function failPending(id: string): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const abandoned = await transaction.conversationMessage.findMany({
      where: {
        conversationId: id,
        role: "assistant",
        status: "pending",
        createdAt: { lt: processStartedAt },
      },
      select: { requestId: true },
    });
    if (!abandoned.length) return;
    await transaction.conversationMessage.updateMany({
      where: {
        conversationId: id,
        role: "assistant",
        status: "pending",
        createdAt: { lt: processStartedAt },
      },
      data: {
        status: "failed",
        error:
          "The server restarted before this reply finished. Please send your message again.",
        completedAt: new Date(),
      },
    });
    await transaction.conversation.updateMany({
      where: {
        id,
        pendingRequestId: { in: abandoned.map((message) => message.requestId) },
      },
      data: { pendingRequestId: null },
    });
  });
}
