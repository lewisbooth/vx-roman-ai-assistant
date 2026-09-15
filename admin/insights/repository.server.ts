import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { conversationTimeline } from "../conversations/repository.server";
import type {
  ConversationInspection,
  ConversationListItem,
  ConversationOverview,
  UsageSummary,
} from "./contracts";

const pageSize = 25;
const conversationSummary = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  turnCount: true,
  _count: { select: { voiceSessions: true } },
} satisfies Prisma.ConversationSelect;

function listItem(
  row: Prisma.ConversationGetPayload<{ select: typeof conversationSummary }>,
): ConversationListItem {
  if (row.status !== "active" && row.status !== "ended")
    throw new Error("Invalid stored conversation status.");
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    turnCount: row.turnCount,
    voiceSessions: row._count.voiceSessions,
  };
}

async function usageSummary(
  transaction: Prisma.TransactionClient,
  shop: string,
  conversationId?: string,
): Promise<UsageSummary> {
  // Every aggregate is independently scoped to the authenticated merchant.
  const where = {
    conversation: { shop, ...(conversationId ? { id: conversationId } : {}) },
  };
  const [model, reportedModelCalls, voice, reportedVoiceSessions] =
    await Promise.all([
      transaction.modelUsage.aggregate({
        where,
        _count: true,
        _sum: {
          inputTokens: true,
          cachedInputTokens: true,
          outputTokens: true,
          reasoningTokens: true,
          totalTokens: true,
        },
      }),
      transaction.modelUsage.count({
        where: { ...where, totalTokens: { not: null } },
      }),
      transaction.voiceSession.aggregate({
        where,
        _count: true,
        _sum: { usageSeconds: true },
      }),
      transaction.voiceSession.count({
        where: { ...where, usageSeconds: { not: null } },
      }),
    ]);
  return {
    ...model._sum,
    modelCalls: model._count,
    reportedModelCalls,
    voiceSeconds: voice._sum.usageSeconds,
    voiceSessions: voice._count,
    reportedVoiceSessions,
  };
}

export async function getConversationOverview(
  shop: string,
  page = 1,
): Promise<ConversationOverview> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
    throw new RangeError("Invalid conversation page.");
  return prisma.$transaction(async (transaction) => {
    const [rows, conversations, endedConversations, failedReplies, usage] =
      await Promise.all([
        transaction.conversation.findMany({
          where: { shop },
          select: conversationSummary,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize + 1,
        }),
        transaction.conversation.count({ where: { shop } }),
        transaction.conversation.count({ where: { shop, status: "ended" } }),
        transaction.conversationMessage.count({
          where: {
            conversation: { shop },
            role: { in: ["assistant", "context"] },
            status: "failed",
          },
        }),
        usageSummary(transaction, shop),
      ]);
    return {
      page,
      hasNextPage: rows.length > pageSize,
      summary: { conversations, endedConversations, failedReplies, usage },
      conversations: rows.slice(0, pageSize).map(listItem),
    };
  });
}

export async function getConversationInspection(
  shop: string,
  id: string,
): Promise<ConversationInspection | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return null;
  return prisma.$transaction(async (transaction) => {
    const row = await transaction.conversation.findFirst({
      where: { id, shop },
      select: {
        ...conversationSummary,
        origin: true,
        messages: { orderBy: { sequence: "asc" } },
        voiceTranscripts: { orderBy: { sequence: "asc" } },
        toolInvocations: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            completedAt: true,
            error: true,
          },
        },
        modelUsage: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            assistantId: true,
            model: true,
            serviceTier: true,
            status: true,
            inputTokens: true,
            cachedInputTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            totalTokens: true,
            createdAt: true,
            completedAt: true,
          },
        },
        voiceSessions: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            model: true,
            status: true,
            createdAt: true,
            closedAt: true,
            usageSeconds: true,
            error: true,
          },
        },
      },
    });
    if (!row) return null;
    return {
      conversation: { ...listItem(row), origin: row.origin },
      messages: conversationTimeline(row).filter(
        (message) => message.parts.length > 0 || message.status === "failed",
      ),
      tools: row.toolInvocations.map((tool) => ({
        ...tool,
        createdAt: tool.createdAt.toISOString(),
        completedAt: tool.completedAt?.toISOString() ?? null,
      })),
      modelUsage: row.modelUsage.map((usage) => ({
        ...usage,
        createdAt: usage.createdAt.toISOString(),
        completedAt: usage.completedAt?.toISOString() ?? null,
      })),
      voiceSessions: row.voiceSessions.map((voice) => ({
        ...voice,
        createdAt: voice.createdAt.toISOString(),
        closedAt: voice.closedAt?.toISOString() ?? null,
      })),
      usage: await usageSummary(transaction, shop, id),
    };
  });
}
