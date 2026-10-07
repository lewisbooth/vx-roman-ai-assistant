import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";
import { getCurrentContext } from "../conversations/repository.server";
import { parseProductPath } from "../../shared/product-path";
import { parseProductConfigurationResult } from "../../shared/product-configuration";
import {
  isMediaId,
  type VisualizationPreparation,
} from "../../shared/visualizations";
import { galleryTokenHash, type GalleryIdentity } from "./auth.server";
import {
  ACTIVE_JOB_STATUSES,
  JOB_DEADLINE_MS,
  VISUALIZATION_CONSENT_VERSIONS,
  RESULT_RESERVATION_BYTES,
  visualizationsEnabled,
} from "./config.server";
import { VISUALIZATION_PROMPT_VERSION } from "./prompt.server";
import {
  cleanupDeletedMedia,
  expirePreparations,
  galleryCapacity,
  jobDto,
  mediaEvent,
  ownedJob,
  ownedPhoto,
  requestHash,
} from "./repository.server";
import { readAsset, removeAsset, writeAsset } from "./storage.server";
import { fetchProductReferences } from "./product-images.server";
import {
  FALLBACK_IMAGE_MODEL,
  generateVisualizationAttempt,
  PRIMARY_IMAGE_MODEL,
  type ImageModel,
} from "./provider.server";
import {
  estimateImageUsage,
  imageRateFor,
  parseImageRateSnapshot,
} from "../pricing/image-estimate.server";

// Single-process Docker deployment: durable reservations precede in-process work.
// Restart recovery never replays a possibly dispatched paid request.
const tasks = new Map<string, Promise<void>>();
let recovering: Promise<void> | undefined;
export async function recoverImageJobs() {
  recovering ??= (async () => {
    await prisma.visualizationJob.updateMany({
      where: { status: { in: ["generating", "saving"] } },
      data: {
        status: "unknown",
        error:
          "Generation was interrupted. Check its status before creating another preview.",
        reservedBytes: 0,
        completedAt: new Date(),
      },
    });
    await prisma.visualizationJob.updateMany({
      where: { status: "preparing_assets" },
      data: {
        status: "failed",
        error: "Product preparation was interrupted. Please try a new preview.",
        reservedBytes: 0,
        completedAt: new Date(),
      },
    });
    await prisma.imageGenerationAttempt.updateMany({
      where: { status: "dispatched", completedAt: null },
      data: {
        status: "unknown",
        errorCode: "process_interrupted",
        completedAt: new Date(),
      },
    });
    await prisma.windowPhoto.updateMany({
      where: { uploadStatus: "saving" },
      data: { uploadStatus: "failed", deletedAt: new Date() },
    });
  })().catch((error) => {
    recovering = undefined;
    throw error;
  });
  await recovering;
  await expirePreparations();
  await cleanupDeletedMedia();
}
export async function startVisualization(
  owner: GalleryIdentity,
  conversationId: string,
  input: {
    requestId: string;
    windowId: string;
    productPath: string;
    cleanup: boolean;
    targetDescription?: string;
  },
) {
  await recoverImageJobs();
  if (!visualizationsEnabled(owner.shop))
    throw new ConversationError(
      503,
      "Visualizations are currently unavailable.",
    );
  if (
    !isMediaId(input.requestId) ||
    !isMediaId(input.windowId) ||
    typeof input.cleanup !== "boolean" ||
    (input.targetDescription !== undefined &&
      (typeof input.targetDescription !== "string" ||
        input.targetDescription.length > 300 ||
        /\p{Cc}/u.test(input.targetDescription)))
  )
    throw new ConversationError(
      400,
      "Send a valid window and visualization request.",
    );
  const productPath = parseProductPath(input.productPath);
  const hash = requestHash({
    windowId: input.windowId,
    productPath,
    cleanup: input.cleanup,
    targetDescription: input.targetDescription ?? null,
  });
  const existing = await prisma.visualizationJob.findUnique({
    where: {
      ownerId_requestId: { ownerId: owner.id, requestId: input.requestId },
    },
  });
  if (existing) {
    if (existing.requestHash !== hash || existing.deletedAt)
      throw new ConversationError(
        409,
        "This request was already used for a different visualization.",
      );
    return jobDto(existing);
  }
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: {
        id: conversationId,
        galleryOwnerId: owner.id,
        shop: owner.shop,
        status: "active",
      },
    });
    if (!conversation)
      throw new ConversationError(
        409,
        "Start a chat before visualizing a blind.",
      );
    const duplicate = await tx.visualizationJob.findUnique({
      where: {
        ownerId_requestId: { ownerId: owner.id, requestId: input.requestId },
      },
    });
    if (duplicate) {
      if (duplicate.requestHash !== hash || duplicate.deletedAt)
        throw new ConversationError(
          409,
          "This request was already used for a different visualization.",
        );
      return jobDto(duplicate);
    }
    const context = await getCurrentContext(conversationId, tx);
    const product = context.current.activeProduct;
    if (!product || product.path !== productPath)
      throw new ConversationError(
        409,
        "Choose this blind before visualizing it.",
      );
    const photo = await ownedPhoto(owner.id, input.windowId, tx);
    if (!VISUALIZATION_CONSENT_VERSIONS.includes(photo.consentVersion))
      throw new ConversationError(
        409,
        "This photo needs updated image consent. Upload it again.",
      );
    const [activeOwner, activeGlobal, hourly, total] = await Promise.all([
      tx.visualizationJob.count({
        where: { ownerId: owner.id, status: { in: ACTIVE_JOB_STATUSES } },
      }),
      tx.visualizationJob.count({
        where: { status: { in: ACTIVE_JOB_STATUSES } },
      }),
      tx.visualizationJob.count({
        where: {
          ownerId: owner.id,
          createdAt: { gte: new Date(Date.now() - 3_600_000) },
        },
      }),
      tx.visualizationJob.count({
        where: { ownerId: owner.id, deletedAt: null },
      }),
    ]);
    if (activeOwner || activeGlobal >= 4)
      throw new ConversationError(
        429,
        "A preview is already being prepared. Please try again when it finishes.",
      );
    if (hourly >= 10 || total >= 500)
      throw new ConversationError(
        429,
        "Your visualization limit has been reached. Try later or delete an old preview.",
      );
    await galleryCapacity(tx, owner, RESULT_RESERVATION_BYTES);
    const configuration = await tx.toolInvocation.findFirst({
      where: {
        conversationId,
        name: "get_product_configuration",
        status: "complete",
        argumentsJson: { contains: JSON.stringify(productPath) },
      },
      orderBy: { completedAt: "desc" },
      select: { resultJson: true },
    });
    let configurationSummary: string | undefined;
    if (configuration?.resultJson) {
      const observed = parseProductConfigurationResult(
        "get_product_configuration",
        JSON.parse(configuration.resultJson),
      );
      if (
        observed.status === "available" &&
        observed.productPath === productPath
      ) {
        const selections = observed.controls
          .filter(
            (control) =>
              control.purpose !== "measurement_guarantee" &&
              !/remote|battery|charger|hub|warranty|guarantee|insurance/i.test(
                control.label,
              ),
          )
          .flatMap((control) =>
            control.options
              .filter((option) => option.selected)
              .map((option) => `${control.label}: ${option.label}`),
          );
        configurationSummary =
          selections.join("; ").slice(0, 1200) || undefined;
      }
    }
    const job = await tx.visualizationJob.create({
      data: {
        id: randomUUID(),
        ownerId: owner.id,
        conversationId,
        windowId: photo.id,
        requestId: input.requestId,
        requestHash: hash,
        windowRevision: photo.revision,
        windowTitle: photo.title,
        sourceAssetKey: photo.assetKey,
        productPath,
        productTitle: product.title,
        productJson: JSON.stringify({ ...product, configurationSummary }),
        cleanup: input.cleanup,
        targetDescription: input.targetDescription?.trim() || null,
        promptVersion: VISUALIZATION_PROMPT_VERSION,
        width: photo.width,
        height: photo.height,
        deadlineAt: new Date(Date.now() + JOB_DEADLINE_MS),
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { selectedWindowPhotoId: photo.id },
    });
    await mediaEvent(
      tx,
      conversationId,
      {
        type: "media",
        version: 1,
        kind: "visualization",
        jobId: job.id,
        customerIntent: true,
      },
      job.id,
    );
    return jobDto(job);
  });
}
export async function claimPreparation(
  ownerId: string,
  jobId: string,
  clientId: string,
) {
  const owner = await prisma.galleryOwner.findUniqueOrThrow({
    where: { id: ownerId },
    select: { shop: true },
  });
  if (!visualizationsEnabled(owner.shop))
    throw new ConversationError(
      503,
      "Visualizations are currently unavailable.",
    );
  if (!isMediaId(clientId))
    throw new ConversationError(
      400,
      "A valid image preparation client is required.",
    );
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const claimed = await prisma.visualizationJob.updateMany({
    where: {
      id: jobId,
      ownerId,
      deletedAt: null,
      window: { deletedAt: null },
      status: "awaiting_product",
      deadlineAt: { gt: now },
      OR: [
        { claimExpiresAt: null },
        { claimExpiresAt: { lte: now } },
        { claimClientId: clientId },
      ],
    },
    data: {
      claimClientId: clientId,
      claimTokenHash: galleryTokenHash(token),
      claimExpiresAt: new Date(
        Math.min(
          Date.now() + 45_000,
          (await ownedJob(ownerId, jobId)).deadlineAt.getTime(),
        ),
      ),
    },
  });
  if (!claimed.count) return { claim: null };
  return {
    claim: { token, productPath: (await ownedJob(ownerId, jobId)).productPath },
  };
}
export async function completePreparation(
  owner: GalleryIdentity,
  jobId: string,
  token: string,
  preparation?: VisualizationPreparation,
  error?: string,
) {
  const job = await ownedJob(owner.id, jobId);
  if (job.status !== "awaiting_product") return jobDto(job);
  if (!visualizationsEnabled(owner.shop))
    throw new ConversationError(
      503,
      "Visualizations are currently unavailable.",
    );
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    job.claimTokenHash !== galleryTokenHash(token) ||
    !job.claimExpiresAt ||
    job.claimExpiresAt.getTime() <= Date.now()
  )
    throw new ConversationError(
      409,
      "This product preparation claim has expired.",
    );
  if (error) {
    if (typeof error !== "string" || error.length > 300)
      throw new ConversationError(
        400,
        "Send a valid product preparation result.",
      );
    await prisma.visualizationJob.updateMany({
      where: {
        id: jobId,
        ownerId: owner.id,
        deletedAt: null,
        window: { deletedAt: null },
        status: "awaiting_product",
        claimTokenHash: job.claimTokenHash,
        claimExpiresAt: { gt: new Date() },
      },
      data: {
        status: "failed",
        error: "The product images could not be prepared. Please try again.",
        reservedBytes: 0,
        completedAt: new Date(),
      },
    });
    return jobDto(await ownedJob(owner.id, jobId));
  }
  if (
    !preparation ||
    preparation.productPath !== job.productPath ||
    !Array.isArray(preparation.references) ||
    preparation.references.length < 1 ||
    preparation.references.length > 4 ||
    preparation.references.some(
      (ref) =>
        typeof ref.url !== "string" ||
        ref.url.length > 2048 ||
        !["installation", "detail", "unknown"].includes(ref.role) ||
        typeof ref.alt !== "string" ||
        ref.alt.length > 200,
    )
  )
    throw new ConversationError(
      400,
      "Product references do not match the accepted visualization.",
    );
  const accepted = await prisma.visualizationJob.updateMany({
    where: {
      id: jobId,
      ownerId: owner.id,
      deletedAt: null,
      window: { deletedAt: null },
      status: "awaiting_product",
      claimTokenHash: job.claimTokenHash,
      claimExpiresAt: { gt: new Date() },
      deadlineAt: { gt: new Date() },
    },
    data: {
      status: "preparing_assets",
      referencesJson: JSON.stringify(preparation.references),
      claimTokenHash: null,
      claimExpiresAt: null,
    },
  });
  if (accepted.count) launchJob(jobId, owner.origin);
  return jobDto(await ownedJob(owner.id, jobId));
}
function launchJob(id: string, origin: string) {
  if (tasks.has(id)) return;
  const task = executeJob(id, origin)
    .catch(async () => {
      const latest = await prisma.imageGenerationAttempt.findFirst({
        where: { jobId: id },
        orderBy: { ordinal: "desc" },
      });
      await finishJob(
        id,
        latest && ["dispatched", "unknown"].includes(latest.status)
          ? "unknown"
          : "failed",
        "The visualization could not finish. Please check its status.",
      );
    })
    .finally(async () => {
      try {
        await cleanupDeletedMedia();
      } finally {
        tasks.delete(id);
      }
    });
  tasks.set(id, task);
  // Task lifetime belongs to this process, never a storefront request signal.
  void task.catch(() =>
    console.error("[Roman] Visualization recovery could not be persisted.", {
      jobId: id,
    }),
  );
}
async function finishJob(
  id: string,
  status: "failed" | "unknown" | "completed",
  error: string | null,
  resultKey?: string,
  resultBytes?: number,
) {
  const published = await prisma.$transaction(async (tx) => {
    const job = await tx.visualizationJob.findUnique({
      where: { id },
      include: { window: { select: { deletedAt: true } } },
    });
    if (!job) return false;
    if (job.deletedAt || job.window.deletedAt) {
      await tx.visualizationJob.update({
        where: { id },
        data: {
          status: "cancelled",
          reservedBytes: 0,
          completedAt: new Date(),
        },
      });
      return false;
    }
    if (!ACTIVE_JOB_STATUSES.includes(job.status))
      return job.status === "completed" && job.resultKey === resultKey;
    await tx.visualizationJob.update({
      where: { id },
      data: {
        status,
        error,
        resultKey,
        resultBytes,
        reservedBytes: 0,
        completedAt: new Date(),
      },
    });
    await mediaEvent(
      tx,
      job.conversationId,
      { type: "media", version: 1, kind: "outcome", jobId: id, status },
      `visualization-outcome-${id}`,
    );
    return true;
  });
  if (!published && resultKey) await removeAsset(resultKey);
}
async function executeJob(id: string, origin: string) {
  const job = await prisma.visualizationJob.findUniqueOrThrow({
    where: { id },
    include: { owner: { select: { shop: true } } },
  });
  if (job.deletedAt) {
    await finishJob(id, "failed", "This visualization was cancelled.");
    return;
  }
  if (job.status !== "preparing_assets") return;
  if (!visualizationsEnabled(job.owner.shop)) {
    await finishJob(
      id,
      "failed",
      "Visualizations are currently unavailable. Your window photo is saved.",
    );
    return;
  }
  const photo = await ownedPhoto(job.ownerId, job.windowId);
  if (
    photo.assetKey !== job.sourceAssetKey ||
    photo.width !== job.width ||
    photo.height !== job.height
  )
    throw new Error("The saved window photo changed.");
  const signal = AbortSignal.timeout(
    Math.max(1, job.deadlineAt.getTime() - Date.now()),
  );
  const bytes = await readAsset(job.sourceAssetKey);
  if (createHash("sha256").update(bytes).digest("hex") !== photo.sha256)
    throw new Error("The saved window photo changed.");
  const room = {
    bytes,
    width: job.width,
    height: job.height,
    sha256: photo.sha256,
  };
  const references = await fetchProductReferences(
    JSON.parse(job.referencesJson),
    { allowedOrigins: [origin, "https://cdn.shopify.com"], signal },
  );
  if (!references.length) {
    await finishJob(
      id,
      "failed",
      "This blind has no usable product image. Please choose another blind.",
    );
    return;
  }
  await prisma.visualizationJob.update({
    where: { id },
    data: {
      referencesJson: JSON.stringify(
        references.map((ref) => ({
          url: ref.url,
          role: ref.role,
          sha256: ref.image.sha256,
          width: ref.image.width,
          height: ref.image.height,
        })),
      ),
    },
  });
  for (const [index, model] of [
    PRIMARY_IMAGE_MODEL,
    FALLBACK_IMAGE_MODEL,
  ].entries()) {
    signal.throwIfAborted();
    if (!visualizationsEnabled(job.owner.shop)) {
      await finishJob(
        id,
        "failed",
        "Visualizations are currently unavailable. Your window photo is saved.",
      );
      return;
    }
    const active = await prisma.visualizationJob.findFirst({
      where: { id, deletedAt: null, window: { deletedAt: null } },
    });
    if (!active) {
      await finishJob(id, "failed", "This visualization was cancelled.");
      return;
    }
    const now = new Date();
    const rate = imageRateFor(model, now);
    if (!rate) {
      await finishJob(
        id,
        "failed",
        "Visualizations are temporarily unavailable. Your window photo is saved.",
      );
      return;
    }
    const attempt = await prisma.$transaction(async (tx) => {
      const allowed = await tx.visualizationJob.updateMany({
        where: {
          id,
          deletedAt: null,
          status: { in: ["preparing_assets", "generating"] },
          deadlineAt: { gt: now },
          window: { deletedAt: null },
        },
        data: {
          status: "generating",
          ...(index === 0 ? { startedAt: now } : {}),
        },
      });
      if (!allowed.count) return null;
      return tx.imageGenerationAttempt.create({
        data: {
          id: randomUUID(),
          jobId: id,
          conversationId: job.conversationId,
          ordinal: index + 1,
          model,
          status: "dispatched",
          rateSnapshotJson: JSON.stringify(rate),
        },
      });
    });
    if (!attempt) {
      await finishJob(id, "failed", "This visualization could not be started.");
      return;
    }
    if (!visualizationsEnabled(job.owner.shop)) {
      await prisma.imageGenerationAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "failed",
          errorCode: "feature_disabled_before_dispatch",
          completedAt: new Date(),
        },
      });
      await finishJob(
        id,
        "failed",
        "Visualizations are currently unavailable. Your window photo is saved.",
      );
      return;
    }
    const result = await generateVisualizationAttempt(
      {
        model: model as ImageModel,
        requestId: attempt.id,
        ownerId: job.ownerId,
        room,
        references,
        productTitle: job.productTitle,
        cleanup: job.cleanup,
        targetDescription: job.targetDescription ?? undefined,
        configurationSummary: JSON.parse(job.productJson).configurationSummary,
        signal,
        onReceipt: async (receipt) => {
          const cost = estimateImageUsage(
            {
              ...receipt.usage,
              usageValid: receipt.usageValid,
              model,
              createdAt: attempt.createdAt,
            },
            parseImageRateSnapshot(attempt.rateSnapshotJson),
          );
          await prisma.imageGenerationAttempt.update({
            where: { id: attempt.id },
            data: {
              status: receipt.outcome,
              providerRequestId: receipt.providerRequestId,
              errorCode: receipt.errorCode,
              ...receipt.usage,
              usageValid: receipt.usageValid,
              usageJson: receipt.usageEvidenceJson,
              costUsd: cost.usd,
              costEvidence: cost.evidence,
              costReason: cost.reason,
              completedAt: new Date(),
            },
          });
        },
      },
      { apiKey: process.env.OPENAI_API_KEY! },
    );
    if (result.image) {
      const key = `${id}.jpg`;
      const saving = await prisma.visualizationJob.updateMany({
        where: {
          id,
          deletedAt: null,
          window: { deletedAt: null },
          status: "generating",
        },
        data: {
          status: "saving",
          resultKey: key,
          resultBytes: result.image.bytes.length,
        },
      });
      if (!saving.count) {
        await finishJob(id, "failed", "This visualization was cancelled.");
        return;
      }
      await writeAsset(result.image.bytes, key);
      await finishJob(id, "completed", null, key, result.image.bytes.length);
      return;
    }
    if (index === 0 && result.receipt.fallbackEligible) {
      const delay = (result.receipt.retryAfterSeconds ?? 0) * 1000;
      if (delay < job.deadlineAt.getTime() - Date.now() - 1000) {
        if (delay) await pause(delay, undefined, { signal });
        continue;
      }
    }
    await finishJob(
      id,
      result.receipt.outcome === "unknown" ? "unknown" : "failed",
      result.imageErrorCode
        ? "The returned image could not be saved. Please try a new preview."
        : "Image generation is currently unavailable. Your window photo is saved.",
    );
    return;
  }
}
