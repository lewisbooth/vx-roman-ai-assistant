import prisma from "../db.server";
import type { ModelUsageUpdate, VoiceUsage } from "./contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modelName = /^[a-zA-Z0-9._:-]{1,100}$/;
const statuses = new Set([
  "pending",
  "completed",
  "failed",
  "incomplete",
  "unavailable",
]);

function tokenCount(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 2_147_483_647)
  );
}

/** Independent of reply status: cancellation must not discard reported usage. */
export async function recordModelUsage(
  conversationId: string,
  assistantId: string,
  usage: ModelUsageUpdate,
): Promise<void> {
  const counts = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ];
  if (
    !uuid.test(usage.id) ||
    !modelName.test(usage.model) ||
    (usage.serviceTier !== null &&
      !/^[a-z0-9_-]{1,40}$/.test(usage.serviceTier)) ||
    !statuses.has(usage.status) ||
    !counts.every(tokenCount) ||
    (usage.status === "pending" && counts.some((count) => count !== null)) ||
    (usage.cachedInputTokens !== null &&
      usage.inputTokens !== null &&
      usage.cachedInputTokens > usage.inputTokens) ||
    (usage.reasoningTokens !== null &&
      usage.outputTokens !== null &&
      usage.reasoningTokens > usage.outputTokens)
  ) {
    throw new Error("Invalid model usage.");
  }
  await prisma.$transaction(async (transaction) => {
    const assistant = await transaction.conversationMessage.findFirst({
      where: {
        id: assistantId,
        conversationId,
        role: { in: ["assistant", "context"] },
      },
      select: { id: true },
    });
    if (!assistant) throw new Error("Usage owner could not be found.");
    const previous = await transaction.modelUsage.findUnique({
      where: { id: usage.id },
    });
    if (
      previous &&
      (previous.conversationId !== conversationId ||
        previous.assistantId !== assistantId)
    )
      throw new Error("Usage owner does not match.");
    // A terminal record is immutable. Repeated callbacks never add usage twice
    // or let a late initial record overwrite a completed request.
    if (previous && previous.status !== "pending") return;
    const data = {
      ...usage,
      completedAt: usage.status === "pending" ? null : new Date(),
    };
    if (previous)
      await transaction.modelUsage.update({ where: { id: usage.id }, data });
    else
      await transaction.modelUsage.create({
        data: { ...data, conversationId, assistantId },
      });
  });
}

/** Only the trusted Live sideband supplies these final cumulative seconds. */
export async function recordVoiceUsage(
  conversationId: string,
  voiceId: string,
  usage: VoiceUsage,
): Promise<void> {
  if (
    !modelName.test(usage.model) ||
    (usage.seconds !== null &&
      (typeof usage.seconds !== "number" ||
        !Number.isFinite(usage.seconds) ||
        usage.seconds < 0 ||
        usage.seconds > Number.MAX_SAFE_INTEGER))
  )
    throw new Error("Invalid voice usage.");
  const owner = await prisma.voiceSession.findFirst({
    where: { id: voiceId, conversationId },
    select: { id: true },
  });
  if (!owner) throw new Error("Usage owner could not be found.");
  await prisma.voiceSession.updateMany({
    where: { id: voiceId, conversationId, usageSeconds: null },
    data: { model: usage.model, usageSeconds: usage.seconds },
  });
}
