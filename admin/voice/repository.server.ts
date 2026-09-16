import { randomUUID } from "node:crypto";
import type { Prisma, VoiceSession, VoiceTranscript } from "@prisma/client";
import type { VoiceTranscriptFragment } from "../../shared/voice-transcript";
import type { VoiceEventPart } from "../../shared/voice";
import type { QuestionPart } from "../../shared/questions";
import { ROMAN_WELCOME_QUESTION } from "../prompts/shared.server";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";

export const VOICE_LEASE_MS = 45_000;
export const MAX_VOICE_DURATION_MS = 10 * 60_000;
export const MAX_VOICE_SESSIONS = 10;
// Conversation totals bound polling and later text-model history across reconnects.
export const MAX_VOICE_FRAGMENTS = 1200;
const maxVoiceCharacters = 60_000;
const processStartedAt = new Date();
const activeStatuses = ["starting", "active"];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string) {
  if (!uuidPattern.test(value))
    throw new ConversationError(400, "Invalid voice session identifier.");
}

async function requireConversation(
  transaction: Prisma.TransactionClient,
  id: string,
) {
  requireUuid(id);
  const conversation = await transaction.conversation.findUnique({
    where: { id },
  });
  if (!conversation)
    throw new ConversationError(404, "This chat could not be found.");
  return conversation;
}

async function requireSession(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  voiceId: string,
  clientId?: string,
) {
  requireUuid(voiceId);
  if (clientId !== undefined) requireUuid(clientId);
  const session = await transaction.voiceSession.findUnique({
    where: { id: voiceId },
  });
  if (
    !session ||
    session.conversationId !== conversationId ||
    (clientId !== undefined && session.clientId !== clientId)
  )
    throw new ConversationError(404, "This voice session could not be found.");
  return session;
}

function requireActiveSession(session: VoiceSession) {
  if (!activeStatuses.includes(session.status))
    throw new ConversationError(
      409,
      "This voice session has ended. Start voice again to reconnect.",
    );
}

function requireActiveConversation(status: string) {
  if (status !== "active")
    throw new ConversationError(
      409,
      "This chat has ended. Start a new chat to continue.",
    );
}

/** Reusable inside text-turn transactions so mode changes share the same DB lock. */
export function expiredVoiceSessionWhere(
  now = new Date(),
): Prisma.VoiceSessionWhereInput {
  return {
    status: { in: activeStatuses },
    OR: [
      { leaseExpiresAt: { lte: now } },
      { createdAt: { lte: new Date(now.getTime() - MAX_VOICE_DURATION_MS) } },
      { createdAt: { lt: processStartedAt } },
    ],
  };
}

export async function expireVoiceSessions(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  now = new Date(),
) {
  const expired = await transaction.voiceSession.findMany({
    where: {
      conversationId,
      ...expiredVoiceSessionWhere(now),
    },
  });
  for (const session of expired)
    await closeSession(
      transaction,
      session,
      {
        status: "failed",
        error: "Voice disconnected. Start voice again to reconnect.",
      },
      now,
    );
}

/** Healthy reads never acquire a writer; the transaction rechecks a stale probe. */
export async function recoverVoiceSessions(conversationId: string) {
  const stale = await prisma.voiceSession.findFirst({
    where: { conversationId, ...expiredVoiceSessionWhere() },
    select: { id: true },
  });
  if (stale)
    await prisma.$transaction((transaction) =>
      expireVoiceSessions(transaction, conversationId),
    );
}

// Commit expiry recovery even when the requested operation then reports a conflict.
// Other failures roll back. Each operation validates before making its own writes.
async function voiceTransaction<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await prisma.$transaction(async (transaction) => {
    try {
      return { value: await operation(transaction) };
    } catch (error) {
      if (error instanceof ConversationError) return { error };
      throw error;
    }
  });
  if ("error" in result) throw result.error;
  return result.value;
}

export async function reserveVoiceSession(
  conversationId: string,
  { voiceId, clientId }: { voiceId: string; clientId: string },
): Promise<{ session: VoiceSession; created: boolean }> {
  requireUuid(voiceId);
  requireUuid(clientId);
  return voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    const now = new Date();
    await expireVoiceSessions(transaction, conversationId, now);
    requireActiveConversation(conversation.status);
    const existing = await transaction.voiceSession.findUnique({
      where: { id: voiceId },
    });
    if (existing) {
      if (
        existing.conversationId !== conversationId ||
        existing.clientId !== clientId
      )
        throw new ConversationError(
          409,
          "That voice request belongs to another session.",
        );
      return { session: existing, created: false };
    }
    if (conversation.pendingRequestId)
      throw new ConversationError(
        409,
        "Wait for Roman's reply before starting voice.",
      );
    if (
      await transaction.voiceSession.findFirst({
        where: { conversationId, status: { in: activeStatuses } },
      })
    )
      throw new ConversationError(409, "Voice is already active in this chat.");
    if (
      (await transaction.voiceSession.count({ where: { conversationId } })) >=
      MAX_VOICE_SESSIONS
    )
      throw new ConversationError(
        429,
        "This chat has reached its voice session limit. Start a new chat.",
      );
    const session = await transaction.voiceSession.create({
      data: {
        id: voiceId,
        conversationId,
        clientId,
        createdAt: now,
        leaseExpiresAt: new Date(now.getTime() + VOICE_LEASE_MS),
      },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { revision: { increment: 1 } },
    });
    return { session, created: true };
  });
}

/** Prefer a live connection; otherwise retain the latest terminal state for its owner. */
export async function getVoiceState(
  conversationId: string,
): Promise<VoiceSession | null> {
  await requireConversation(prisma, conversationId);
  await recoverVoiceSessions(conversationId);
  return (
    (await prisma.voiceSession.findFirst({
      where: { conversationId, status: { in: activeStatuses } },
    })) ??
    prisma.voiceSession.findFirst({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
  );
}

export async function activateVoiceSession(
  conversationId: string,
  voiceId: string,
  clientId: string,
  providerId: string,
): Promise<VoiceSession> {
  if (typeof providerId !== "string" || !/^[\w.-]{1,200}$/.test(providerId))
    throw new ConversationError(400, "Invalid voice provider session.");
  return voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    await expireVoiceSessions(transaction, conversationId);
    const session = await requireSession(
      transaction,
      conversationId,
      voiceId,
      clientId,
    );
    requireActiveConversation(conversation.status);
    requireActiveSession(session);
    if (session.providerId && session.providerId !== providerId)
      throw new ConversationError(
        409,
        "This voice session is already connected.",
      );
    if (session.status === "active") return session;
    const updated = await transaction.voiceSession.update({
      where: { id: voiceId },
      data: { status: "active", providerId },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { revision: { increment: 1 } },
    });
    return updated;
  });
}

function voiceEventRequestId(voiceId: string, event: "started" | "ended") {
  return `voice:${voiceId}:${event}`;
}

async function appendVoiceEvent(
  transaction: Prisma.TransactionClient,
  session: VoiceSession,
  event: VoiceEventPart["event"],
  occurredAt = new Date(),
) {
  const terminal = event !== "started";
  const requestId = voiceEventRequestId(
    session.id,
    terminal ? "ended" : "started",
  );
  const identity = {
    conversationId: session.conversationId,
    requestId,
    role: "context",
  };
  if (
    await transaction.conversationMessage.findUnique({
      where: { conversationId_requestId_role: identity },
    })
  )
    return false;
  if (
    terminal &&
    !(await transaction.conversationMessage.findUnique({
      where: {
        conversationId_requestId_role: {
          ...identity,
          requestId: voiceEventRequestId(session.id, "started"),
        },
      },
    }))
  )
    return;
  const conversation = await transaction.conversation.update({
    where: { id: session.conversationId },
    data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
  });
  await transaction.conversationMessage.create({
    data: {
      id: randomUUID(),
      ...identity,
      sequence: conversation.nextSequence - 1,
      status: "complete",
      partsJson: JSON.stringify([
        { type: "voice_event", version: 1, voiceId: session.id, event },
      ]),
      createdAt: occurredAt,
      completedAt: occurredAt,
    },
  });
  return true;
}

/** Only the service's provider-started + browser-ready gate calls this. */
export async function markVoiceStarted(
  conversationId: string,
  voiceId: string,
  clientId: string,
  offerWelcome = false,
): Promise<void> {
  await voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    await expireVoiceSessions(transaction, conversationId);
    const session = await requireSession(
      transaction,
      conversationId,
      voiceId,
      clientId,
    );
    requireActiveConversation(conversation.status);
    if (session.status !== "active" || !session.providerId)
      throw new ConversationError(409, "Voice is not connected.");
    const started = await appendVoiceEvent(transaction, session, "started");
    if (!started || !offerWelcome) return;
    const messages = await transaction.conversationMessage.findMany({
      where: { conversationId },
      select: { role: true, partsJson: true },
    });
    if (
      messages.some(
        (message) =>
          message.role === "user" ||
          message.role === "assistant" ||
          (JSON.parse(message.partsJson) as { type: string }[]).some(
            (part) => part.type === "question",
          ),
      ) ||
      (await transaction.voiceTranscript.findFirst({
        where: {
          conversationId,
          OR: [{ role: "user" }, { voiceId: { not: voiceId } }],
        },
      }))
    )
      return;
    const updated = await transaction.conversation.update({
      where: { id: conversationId },
      data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
    });
    const invocationId = randomUUID();
    const messageId = randomUUID();
    const now = new Date();
    const question: QuestionPart = {
      type: "question",
      version: 1,
      invocationId,
      question: ROMAN_WELCOME_QUESTION.question,
      answers: [...ROMAN_WELCOME_QUESTION.answers],
      voiceReply: { voiceId, afterSequence: updated.nextSequence },
    };
    await transaction.conversationMessage.create({
      data: {
        id: messageId,
        conversationId,
        requestId: `voice:${voiceId}:welcome`,
        sequence: updated.nextSequence - 1,
        role: "context",
        status: "complete",
        partsJson: JSON.stringify([question]),
        createdAt: now,
        completedAt: now,
      },
    });
    await transaction.toolInvocation.create({
      data: {
        id: invocationId,
        conversationId,
        assistantId: messageId,
        providerCallId: `voice:${voiceId}:welcome`,
        name: "ask_question",
        argumentsJson: JSON.stringify(ROMAN_WELCOME_QUESTION),
        status: "complete",
        completedAt: now,
      },
    });
  });
}

export async function heartbeatVoiceSession(
  conversationId: string,
  voiceId: string,
  clientId: string,
): Promise<VoiceSession> {
  return voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    const now = new Date();
    await expireVoiceSessions(transaction, conversationId, now);
    const session = await requireSession(
      transaction,
      conversationId,
      voiceId,
      clientId,
    );
    requireActiveConversation(conversation.status);
    requireActiveSession(session);
    return transaction.voiceSession.update({
      where: { id: voiceId },
      data: {
        leaseExpiresAt: new Date(
          Math.min(
            now.getTime() + VOICE_LEASE_MS,
            session.createdAt.getTime() + MAX_VOICE_DURATION_MS,
          ),
        ),
      },
    });
  });
}

export async function closeVoiceSession(
  conversationId: string,
  voiceId: string,
  clientId: string,
  outcome: { status: "closed" | "failed"; error?: string } = {
    status: "closed",
  },
): Promise<VoiceSession> {
  if (
    !["closed", "failed"].includes(outcome.status) ||
    (outcome.error !== undefined &&
      (typeof outcome.error !== "string" || outcome.error.length > 500))
  )
    throw new ConversationError(400, "Invalid voice session outcome.");
  return voiceTransaction(async (transaction) => {
    await requireConversation(transaction, conversationId);
    const session = await requireSession(
      transaction,
      conversationId,
      voiceId,
      clientId,
    );
    return closeSession(transaction, session, outcome);
  });
}

async function closeSession(
  transaction: Prisma.TransactionClient,
  session: VoiceSession,
  outcome: { status: "closed" | "failed"; error?: string },
  closedAt = new Date(),
): Promise<VoiceSession> {
  if (!activeStatuses.includes(session.status)) return session;
  const updated = await transaction.voiceSession.update({
    where: { id: session.id },
    data: {
      status: outcome.status,
      error: outcome.error ?? null,
      closedAt,
    },
  });
  await transaction.conversation.update({
    where: { id: session.conversationId },
    data: { revision: { increment: 1 } },
  });
  await appendVoiceEvent(
    transaction,
    updated,
    outcome.status === "closed" ? "ended" : "disconnected",
    closedAt,
  );
  return updated;
}

/** End chat shares the same terminal event owner as stop and lease recovery. */
export async function closeConversationVoiceSessions(
  transaction: Prisma.TransactionClient,
  conversationId: string,
) {
  const sessions = await transaction.voiceSession.findMany({
    where: { conversationId, status: { in: activeStatuses } },
  });
  for (const session of sessions)
    await closeSession(transaction, session, { status: "closed" });
}

/** A stop may arrive before start. Persist that request so a late start cannot reconnect. */
export async function cancelVoiceSession(
  conversationId: string,
  voiceId: string,
  clientId: string,
): Promise<VoiceSession | null> {
  requireUuid(voiceId);
  requireUuid(clientId);
  return voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    const existing = await transaction.voiceSession.findUnique({
      where: { id: voiceId },
    });
    if (existing) {
      if (
        existing.conversationId !== conversationId ||
        existing.clientId !== clientId
      )
        throw new ConversationError(
          404,
          "This voice session could not be found.",
        );
      return closeSession(transaction, existing, { status: "closed" });
    }
    requireActiveConversation(conversation.status);
    if (
      (await transaction.voiceSession.count({ where: { conversationId } })) >=
      MAX_VOICE_SESSIONS
    )
      // No session rows are removed during a chat, so a future start is already
      // permanently denied. Stopping that unknown request needs no tombstone.
      return null;
    const now = new Date();
    const cancelled = await transaction.voiceSession.create({
      data: {
        id: voiceId,
        conversationId,
        clientId,
        status: "closed",
        createdAt: now,
        closedAt: now,
        leaseExpiresAt: now,
      },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { revision: { increment: 1 } },
    });
    return cancelled;
  });
}

export interface VoiceTranscriptInput {
  providerEventId: string;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

function parseTranscript(value: unknown): VoiceTranscriptInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConversationError(400, "Invalid voice caption.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 5 ||
    typeof input.providerEventId !== "string" ||
    !/^[\w.:-]{1,200}$/.test(input.providerEventId) ||
    (input.role !== "user" && input.role !== "assistant") ||
    typeof input.text !== "string" ||
    !input.text.length ||
    input.text.length > 2000 ||
    typeof input.startMs !== "number" ||
    !Number.isFinite(input.startMs) ||
    input.startMs < 0 ||
    typeof input.endMs !== "number" ||
    !Number.isFinite(input.endMs) ||
    input.endMs < input.startMs ||
    input.endMs > MAX_VOICE_DURATION_MS
  )
    throw new ConversationError(400, "Invalid voice caption.");
  return input as unknown as VoiceTranscriptInput;
}

function fragment(row: VoiceTranscript): VoiceTranscriptFragment {
  if (row.role !== "user" && row.role !== "assistant")
    throw new Error("Invalid stored voice caption role.");
  return {
    id: row.id,
    voiceId: row.voiceId,
    providerEventId: row.providerEventId,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Server sideband only. Customer API routes must never accept transcript uploads. */
export async function appendVoiceTranscript(
  conversationId: string,
  voiceId: string,
  value: unknown,
): Promise<VoiceTranscriptFragment> {
  const input = parseTranscript(value);
  return voiceTransaction(async (transaction) => {
    const conversation = await requireConversation(transaction, conversationId);
    await expireVoiceSessions(transaction, conversationId);
    const session = await requireSession(transaction, conversationId, voiceId);
    requireActiveConversation(conversation.status);
    requireActiveSession(session);
    const existing = await transaction.voiceTranscript.findUnique({
      where: {
        voiceId_providerEventId: {
          voiceId,
          providerEventId: input.providerEventId,
        },
      },
    });
    if (existing) {
      if (
        existing.role !== input.role ||
        existing.text !== input.text ||
        existing.startMs !== input.startMs ||
        existing.endMs !== input.endMs
      )
        throw new ConversationError(
          409,
          "A voice caption ID was reused with different content.",
        );
      return fragment(existing);
    }
    const previous = await transaction.voiceTranscript.findMany({
      where: { conversationId },
      select: { text: true },
    });
    if (
      previous.length >= MAX_VOICE_FRAGMENTS ||
      previous.reduce(
        (length, caption) => length + caption.text.length,
        input.text.length,
      ) > maxVoiceCharacters
    )
      throw new ConversationError(
        429,
        "This chat has reached its voice transcript limit. Start a new chat.",
      );
    const row = await transaction.voiceTranscript.create({
      data: {
        id: randomUUID(),
        voiceId,
        conversationId,
        sequence: conversation.nextSequence,
        ...input,
      },
    });
    await transaction.conversation.update({
      where: { id: conversationId },
      data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
    });
    return fragment(row);
  });
}

export async function listVoiceTranscripts(
  conversationId: string,
): Promise<VoiceTranscriptFragment[]> {
  requireUuid(conversationId);
  return (
    await prisma.voiceTranscript.findMany({
      where: { conversationId },
      orderBy: { sequence: "asc" },
    })
  ).map(fragment);
}
