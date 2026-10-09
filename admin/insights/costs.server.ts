import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { CostSummary, ModelPrice, TokenPrices } from "../pricing/contracts";
import { emptyCostSummary, tokenCostUsd } from "../pricing/estimate.server";
import { MODEL_PRICES } from "../pricing/rates.server";

interface ConversationTotal {
  conversationId: string | null;
}

interface TokenTotal extends ConversationTotal {
  band: bigint | null;
  count: bigint;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
}

interface VoiceTotal extends ConversationTotal {
  band: bigint | null;
  count: bigint;
  seconds: number | null;
}

function period(price: ModelPrice) {
  return Prisma.sql`u."model" = ${price.model}
    AND u."createdAt" >= ${new Date(price.effectiveFrom)}
    ${price.effectiveTo ? Prisma.sql`AND u."createdAt" < ${new Date(price.effectiveTo)}` : Prisma.empty}`;
}

function validCount(column: Prisma.Sql) {
  return Prisma.sql`typeof(${column}) IN ('integer', 'real')
    AND ${column} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    AND ${column} = CAST(${column} AS INTEGER)`;
}

/** One row per configured price/context band, plus one unpriced group.
 * Individual usage and provider payloads never leave SQLite for an overview. */
export async function getShopCostSummary(
  shop: string,
  prices: readonly ModelPrice[] = MODEL_PRICES,
) {
  return (await costSummaries(shop, prices)).get("") ?? emptyCostSummary();
}

/** Only the requested merchant page's accounting groups leave SQLite. */
export async function getConversationCostSummaries(
  shop: string,
  conversationIds: readonly string[],
  prices: readonly ModelPrice[] = MODEL_PRICES,
): Promise<Map<string, CostSummary>> {
  if (!conversationIds.length) return new Map();
  return costSummaries(shop, prices, conversationIds);
}

async function costSummaries(
  shop: string,
  prices: readonly ModelPrice[],
  conversationIds?: readonly string[],
): Promise<Map<string, CostSummary>> {
  const conversationId = conversationIds
    ? Prisma.sql`c."id"`
    : Prisma.sql`NULL`;
  const scope = Prisma.sql`c."shop" = ${shop}
    ${conversationIds ? Prisma.sql`AND c."id" IN (${Prisma.join(conversationIds)})` : Prisma.empty}`;
  const conversationGroup = conversationIds
    ? Prisma.sql`conversationId,`
    : Prisma.empty;
  const tokenBands: { when: Prisma.Sql; charges: TokenPrices }[] = [];
  const voiceBands: { when: Prisma.Sql; perMinute: number }[] = [];
  for (const price of prices) {
    if (price.kind === "image") continue;
    if (price.kind === "voice") {
      voiceBands.push({ when: period(price), perMinute: price.perMinute });
      continue;
    }
    const tier =
      price.serviceTier === "priority"
        ? Prisma.sql`u."serviceTier" IN ('priority', 'fast')`
        : Prisma.sql`u."serviceTier" = ${price.serviceTier}`;
    const when = Prisma.sql`${period(price)} AND ${tier}`;
    if (price.longContext)
      tokenBands.push({
        when: Prisma.sql`${when} AND u."inputTokens" > ${price.longContext.aboveInputTokens}`,
        charges: price.longContext.prices,
      });
    tokenBands.push({ when, charges: price.prices });
  }
  const tokenBand = tokenBands.length
    ? Prisma.sql`CASE ${Prisma.join(
        tokenBands.map(
          (band, index) => Prisma.sql`WHEN ${band.when} THEN ${index}`,
        ),
        " ",
      )} ELSE NULL END`
    : Prisma.sql`NULL`;
  const voiceBand = voiceBands.length
    ? Prisma.sql`CASE ${Prisma.join(
        voiceBands.map(
          (band, index) => Prisma.sql`WHEN ${band.when} THEN ${index}`,
        ),
        " ",
      )} ELSE NULL END`
    : Prisma.sql`NULL`;
  const validTokens = Prisma.sql`${validCount(Prisma.sql`u."inputTokens"`)}
    AND ${validCount(Prisma.sql`u."cachedInputTokens"`)}
    AND ${validCount(Prisma.sql`u."cacheWriteInputTokens"`)}
    AND ${validCount(Prisma.sql`u."outputTokens"`)}
    AND u."cachedInputTokens" + u."cacheWriteInputTokens" <= u."inputTokens"`;
  // Separate read statements do not hold the connection in an interactive
  // transaction while rows are transferred and priced in JavaScript.
  const [model, images, voice] = await Promise.all([
    prisma.$queryRaw<TokenTotal[]>(Prisma.sql`
      SELECT ${conversationId} AS conversationId,
        CASE WHEN ${validTokens} THEN ${tokenBand} ELSE NULL END AS band,
        COUNT(*) AS count,
        TOTAL(u."inputTokens") AS inputTokens,
        TOTAL(u."cachedInputTokens") AS cachedInputTokens,
        TOTAL(u."cacheWriteInputTokens") AS cacheWriteInputTokens,
        TOTAL(u."outputTokens") AS outputTokens
      FROM "Conversation" c JOIN "ModelUsage" u ON u."conversationId" = c."id"
      WHERE ${scope}
      GROUP BY ${conversationGroup} band`),
    prisma.$queryRaw<
      (ConversationTotal & {
        evidence: string | null;
        count: bigint;
        usd: number | null;
      })[]
    >(Prisma.sql`
      SELECT ${conversationId} AS conversationId,
        CASE WHEN u."usageValid" = 1
        AND typeof(u."costUsd") IN ('integer', 'real')
        AND u."costUsd" BETWEEN 0 AND ${Number.MAX_VALUE}
        AND u."costEvidence" IN ('reported', 'estimated')
        THEN u."costEvidence" ELSE NULL END AS evidence,
        COUNT(*) AS count, TOTAL(u."costUsd") AS usd
      FROM "Conversation" c JOIN "ImageGenerationAttempt" u ON u."conversationId" = c."id"
      WHERE ${scope}
      GROUP BY ${conversationGroup} evidence`),
    prisma.$queryRaw<VoiceTotal[]>(Prisma.sql`
      SELECT ${conversationId} AS conversationId,
        CASE WHEN typeof(u."usageSeconds") IN ('integer', 'real')
        AND u."usageSeconds" BETWEEN 0 AND ${Number.MAX_VALUE}
        THEN ${voiceBand} ELSE NULL END AS band,
        COUNT(*) AS count, TOTAL(u."usageSeconds") AS seconds
      FROM "Conversation" c JOIN "VoiceSession" u ON u."conversationId" = c."id"
      WHERE ${scope}
      GROUP BY ${conversationGroup} band`),
  ]);
  const summaries = new Map<string, CostSummary>();
  function summaryFor(row: ConversationTotal) {
    const id = row.conversationId ?? "";
    let summary = summaries.get(id);
    if (!summary) {
      summary = emptyCostSummary();
      summaries.set(id, summary);
    }
    return summary;
  }
  for (const row of model) {
    const summary = summaryFor(row);
    const count = Number(row.count);
    const band = row.band === null ? undefined : tokenBands[Number(row.band)];
    const usd = band
      ? tokenCostUsd(
          {
            inputTokens: Number(row.inputTokens),
            cachedInputTokens: Number(row.cachedInputTokens),
            cacheWriteInputTokens: Number(row.cacheWriteInputTokens),
            outputTokens: Number(row.outputTokens),
          },
          band.charges,
        )
      : NaN;
    if (!Number.isFinite(usd)) summary.unpricedModelCalls += count;
    else {
      summary.pricedModelCalls += count;
      summary.modelUsd = (summary.modelUsd ?? 0) + usd;
    }
  }
  for (const row of voice) {
    const summary = summaryFor(row);
    const count = Number(row.count);
    const band = row.band === null ? undefined : voiceBands[Number(row.band)];
    const usd = band ? (Number(row.seconds) * band.perMinute) / 60 : NaN;
    if (!Number.isFinite(usd)) summary.unpricedVoiceSessions += count;
    else {
      summary.pricedVoiceSessions += count;
      summary.voiceUsd = (summary.voiceUsd ?? 0) + usd;
    }
  }
  for (const row of images) {
    const summary = summaryFor(row);
    const count = Number(row.count);
    if (row.evidence === null || !Number.isFinite(row.usd))
      summary.unpricedImageAttempts += count;
    else {
      summary.pricedImageAttempts += count;
      if (row.evidence === "estimated") summary.estimatedImageAttempts += count;
      summary.imageUsd = (summary.imageUsd ?? 0) + Number(row.usd);
    }
  }
  for (const summary of summaries.values())
    if (
      summary.modelUsd !== null ||
      summary.voiceUsd !== null ||
      summary.imageUsd !== null
    )
      summary.totalUsd =
        (summary.modelUsd ?? 0) +
        (summary.voiceUsd ?? 0) +
        (summary.imageUsd ?? 0);
  return summaries;
}
