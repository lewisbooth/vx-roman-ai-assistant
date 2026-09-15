import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { ModelPrice, TokenPrices } from "../pricing/contracts";
import { emptyCostSummary, tokenCostUsd } from "../pricing/estimate.server";
import { MODEL_PRICES } from "../pricing/rates.server";

interface TokenTotal {
  band: bigint | null;
  count: bigint;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
}

interface VoiceTotal {
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
  const tokenBands: { when: Prisma.Sql; charges: TokenPrices }[] = [];
  const voiceBands: { when: Prisma.Sql; perMinute: number }[] = [];
  for (const price of prices) {
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
  const [model, voice] = await Promise.all([
    prisma.$queryRaw<TokenTotal[]>(Prisma.sql`
      SELECT CASE WHEN ${validTokens} THEN ${tokenBand} ELSE NULL END AS band,
        COUNT(*) AS count,
        TOTAL(u."inputTokens") AS inputTokens,
        TOTAL(u."cachedInputTokens") AS cachedInputTokens,
        TOTAL(u."cacheWriteInputTokens") AS cacheWriteInputTokens,
        TOTAL(u."outputTokens") AS outputTokens
      FROM "Conversation" c JOIN "ModelUsage" u ON u."conversationId" = c."id"
      WHERE c."shop" = ${shop}
      GROUP BY band`),
    prisma.$queryRaw<VoiceTotal[]>(Prisma.sql`
      SELECT CASE WHEN typeof(u."usageSeconds") IN ('integer', 'real')
        AND u."usageSeconds" BETWEEN 0 AND ${Number.MAX_VALUE}
        THEN ${voiceBand} ELSE NULL END AS band,
        COUNT(*) AS count, TOTAL(u."usageSeconds") AS seconds
      FROM "Conversation" c JOIN "VoiceSession" u ON u."conversationId" = c."id"
      WHERE c."shop" = ${shop}
      GROUP BY band`),
  ]);
  const summary = emptyCostSummary();
  for (const row of model) {
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
    const count = Number(row.count);
    const band = row.band === null ? undefined : voiceBands[Number(row.band)];
    const usd = band ? (Number(row.seconds) * band.perMinute) / 60 : NaN;
    if (!Number.isFinite(usd)) summary.unpricedVoiceSessions += count;
    else {
      summary.pricedVoiceSessions += count;
      summary.voiceUsd = (summary.voiceUsd ?? 0) + usd;
    }
  }
  if (summary.modelUsd !== null || summary.voiceUsd !== null)
    summary.totalUsd = (summary.modelUsd ?? 0) + (summary.voiceUsd ?? 0);
  return summary;
}
