import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { readSpendRange, type SessionMetrics, type SpendRange } from "./spend";

interface SessionTotals {
  sessions: bigint;
  voiceSessions: bigint;
  visualizerSessions: bigint;
  sampleCartSessions: bigint;
  productCartSessions: bigint;
}

/** Creation-date cohort, counting each confirmed activity at most once per
 * conversation. Existing durable receipts are authoritative, including actions
 * completed after the range and previews later deleted or failed. */
export async function getSessionMetrics(
  shop: string,
  requestedRange: SpendRange,
): Promise<SessionMetrics> {
  const range = readSpendRange(
    new URLSearchParams({
      from: requestedRange.from,
      to: requestedRange.to,
    }),
  );
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const toExclusive = new Date(
    new Date(`${range.to}T00:00:00.000Z`).getTime() + 86_400_000,
  );
  const [total] = await prisma.$queryRaw<SessionTotals[]>(Prisma.sql`
    SELECT COUNT(*) AS sessions,
      COALESCE(SUM(EXISTS (
        SELECT 1 FROM "VoiceSession" v
        WHERE v."conversationId" = c."id" AND (
          EXISTS (
            SELECT 1 FROM "ConversationMessage" m
            WHERE m."conversationId" = c."id" AND m."role" = 'context'
              AND m."requestId" = 'voice:' || v."id" || ':started'
              AND m."status" = 'complete'
          ) OR EXISTS (
            SELECT 1 FROM "VoiceTranscript" x WHERE x."voiceId" = v."id"
          )
        )
      )), 0) AS voiceSessions,
      COALESCE(SUM(EXISTS (
        SELECT 1 FROM "VisualizationJob" j
        WHERE j."conversationId" = c."id"
      )), 0) AS visualizerSessions,
      COALESCE(SUM(${addedToCart("add_sample_to_cart")}), 0) AS sampleCartSessions,
      COALESCE(SUM(${addedToCart("add_to_cart")}), 0) AS productCartSessions
    FROM "Conversation" c
    WHERE c."shop" = ${shop}
      AND c."createdAt" >= ${from} AND c."createdAt" < ${toExclusive}`);
  const sessions = Number(total.sessions);
  const voiceSessions = Number(total.voiceSessions);
  return {
    sessions,
    voiceSessions,
    textSessions: sessions - voiceSessions,
    visualizerSessions: Number(total.visualizerSessions),
    sampleCartSessions: Number(total.sampleCartSessions),
    productCartSessions: Number(total.productCartSessions),
  };
}

function addedToCart(name: "add_to_cart" | "add_sample_to_cart") {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ToolInvocation" t
    WHERE t."conversationId" = c."id" AND t."name" = ${name}
      AND t."status" = 'complete' AND t."error" IS NULL
      AND json_extract(CASE WHEN json_valid(t."resultJson")
        THEN t."resultJson" ELSE '{}' END, '$.status') = 'added'
  )`;
}
