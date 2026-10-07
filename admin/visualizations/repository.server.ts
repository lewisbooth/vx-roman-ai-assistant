import { createHash, randomUUID } from "node:crypto";
import type { Prisma, VisualizationJob } from "@prisma/client";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";
import type { GalleryIdentity } from "./auth.server";
import { readAsset, removeAsset, writeAsset } from "./storage.server";
import {
  ACTIVE_JOB_STATUSES,
  MAX_GALLERY_BYTES,
  MAX_STORE_BYTES,
  MEDIA_CONSENT_VERSION,
  visualizationsEnabled,
} from "./config.server";
import { normalizeRoomPhoto } from "./image.server";
import { kickRoomAnalysis } from "./analysis.server";
import { photoDto } from "./photo-metadata.server";
import { ROOM_ANALYSIS_VERSION } from "../prompts/room-analysis.server";
import { parseProductPath } from "../../shared/product-path";
import {
  MAX_GALLERY_PHOTOS,
  isMediaId,
  isMediaPart,
  windowTitle,
  type GallerySnapshot,
  type MediaPart,
  type VisualizationJobDto,
} from "../../shared/visualizations";

export const requestHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function jobDto(job: VisualizationJob): VisualizationJobDto {
  return {
    id: job.id,
    windowId: job.windowId,
    windowTitle: job.windowTitle,
    productPath: job.productPath,
    productTitle: job.productTitle,
    status: job.status as VisualizationJobDto["status"],
    width: job.width,
    height: job.height,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    error: job.error,
    resultAvailable:
      job.status === "completed" && !!job.resultKey && !job.deletedAt,
  };
}
const notFound = () =>
  new ConversationError(404, "This image is no longer available.");
export async function ownedPhoto(
  ownerId: string,
  id: string,
  transaction: Prisma.TransactionClient = prisma,
) {
  const photo = isMediaId(id)
    ? await transaction.windowPhoto.findFirst({
        where: { id, ownerId, deletedAt: null, uploadStatus: "ready" },
      })
    : null;
  if (!photo) throw notFound();
  return photo;
}
export async function mediaEvent(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  part: MediaPart,
  eventId: string = randomUUID(),
) {
  const exists = await transaction.conversationMessage.findUnique({
    where: { id: eventId },
  });
  if (exists) return;
  const conversation = await transaction.conversation.update({
    where: { id: conversationId },
    data: { nextSequence: { increment: 1 }, revision: { increment: 1 } },
  });
  await transaction.conversationMessage.create({
    data: {
      id: eventId,
      requestId: eventId,
      conversationId,
      sequence: conversation.nextSequence - 1,
      role: "context",
      status: "complete",
      partsJson: JSON.stringify([part]),
      completedAt: new Date(),
    },
  });
}
export async function selectWindow(
  ownerId: string,
  conversationId: string,
  windowId: string,
  customerIntent = true,
) {
  return prisma.$transaction(async (tx) => {
    const photo = await ownedPhoto(ownerId, windowId, tx);
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, galleryOwnerId: ownerId, status: "active" },
    });
    if (!conversation)
      throw new ConversationError(
        409,
        "Start a chat before choosing this window.",
      );
    // Upload already selects its photo. Repeated selection acknowledgements
    // must not add another card or advance the conversation revision.
    if (conversation.selectedWindowPhotoId === photo.id) return photoDto(photo);
    await tx.conversation.update({
      where: { id: conversationId },
      data: { selectedWindowPhotoId: photo.id },
    });
    await mediaEvent(tx, conversationId, {
      type: "media",
      version: 1,
      kind: "window",
      windowId: photo.id,
      title: photo.title,
      customerIntent,
    });
    return photoDto(photo);
  });
}
function cursor(value?: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed.date !== "string" ||
      !Number.isFinite(Date.parse(parsed.date)) ||
      !isMediaId(parsed.id)
    )
      throw new Error();
    return {
      OR: [
        { createdAt: { lt: new Date(parsed.date) } },
        { createdAt: new Date(parsed.date), id: { lt: parsed.id } },
      ],
    };
  } catch {
    throw new ConversationError(400, "Invalid gallery cursor.");
  }
}
function nextCursor<T extends { id: string; createdAt: Date }>(rows: T[]) {
  const last = rows[23];
  return rows.length > 24 && last
    ? Buffer.from(
        JSON.stringify({ date: last.createdAt.toISOString(), id: last.id }),
      ).toString("base64url")
    : null;
}
export async function gallerySnapshot(
  ownerId: string,
  windowsCursor?: string | null,
  jobsCursor?: string | null,
): Promise<GallerySnapshot> {
  const owner = await prisma.galleryOwner.findUniqueOrThrow({
    where: { id: ownerId },
    select: { shop: true },
  });
  const [photos, jobs, livePhotos, liveJobs] = await Promise.all([
    prisma.windowPhoto.findMany({
      where: {
        ownerId,
        deletedAt: null,
        uploadStatus: "ready",
        ...cursor(windowsCursor),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 25,
    }),
    prisma.visualizationJob.findMany({
      where: {
        ownerId,
        deletedAt: null,
        window: { deletedAt: null },
        ...cursor(jobsCursor),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 25,
    }),
    prisma.windowPhoto.findMany({ where: { ownerId, deletedAt: null, uploadStatus: "ready" }, select: { id: true }, take: MAX_GALLERY_PHOTOS }),
    prisma.visualizationJob.findMany({ where: { ownerId, deletedAt: null, window: { deletedAt: null } }, select: { id: true }, take: 500 }),
  ]);
  return {
    enabled: visualizationsEnabled(owner.shop),
    liveWindowIds: livePhotos.map((photo) => photo.id),
    liveVisualizationIds: liveJobs.map((job) => job.id),
    windows: photos.slice(0, 24).map(photoDto),
    visualizations: jobs.slice(0, 24).map(jobDto),
    nextWindowsCursor: nextCursor(photos),
    nextVisualizationsCursor: nextCursor(jobs),
  };
}
/** Product media must include older previews without loading every Gallery page. */
export async function productVisualizations(ownerId: string, input: unknown) {
  let productPath: string;
  try { productPath = parseProductPath(input); }
  catch { throw new ConversationError(400, "Use a canonical /products/handle path."); }
  const jobs = await prisma.visualizationJob.findMany({
    where: {
      ownerId,
      productPath,
      status: "completed",
      resultKey: { not: null },
      deletedAt: null,
      window: { ownerId, deletedAt: null, uploadStatus: "ready" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // The existing owner quota bounds metadata; image bytes are fetched on view.
    take: 500,
  });
  return { productPath, visualizations: jobs.map(jobDto) };
}
export async function galleryCapacity(
  tx: Prisma.TransactionClient,
  owner: GalleryIdentity,
  extra: number,
) {
  const [photos, jobs, allPhotos, allJobs] = await Promise.all([
    tx.windowPhoto.aggregate({
      where: { ownerId: owner.id },
      _sum: { bytes: true },
    }),
    tx.visualizationJob.aggregate({
      where: { ownerId: owner.id },
      _sum: { resultBytes: true, reservedBytes: true },
    }),
    tx.windowPhoto.aggregate({ _sum: { bytes: true } }),
    tx.visualizationJob.aggregate({
      _sum: { resultBytes: true, reservedBytes: true },
    }),
  ]);
  if (
    (photos._sum.bytes ?? 0) +
      (jobs._sum.resultBytes ?? 0) +
      (jobs._sum.reservedBytes ?? 0) +
      extra >
      MAX_GALLERY_BYTES ||
    (allPhotos._sum.bytes ?? 0) +
      (allJobs._sum.resultBytes ?? 0) +
      (allJobs._sum.reservedBytes ?? 0) +
      extra >
      MAX_STORE_BYTES
  )
    throw new ConversationError(
      429,
      "Your photo library is full. Delete an image before adding another.",
    );
}
export async function saveWindow(
  owner: GalleryIdentity,
  conversationId: string,
  input: {
    requestId: string;
    title: string;
    cleanup: boolean;
    consent: boolean;
    bytes: Buffer;
    contentType: string;
  },
) {
  if (!visualizationsEnabled(owner.shop))
    throw new ConversationError(
      503,
      "Image uploads are currently unavailable.",
    );
  if (
    !isMediaId(input.requestId) ||
    input.consent !== true ||
    typeof input.cleanup !== "boolean"
  )
    throw new ConversationError(
      400,
      "A valid upload request and image consent are required.",
    );
  let title: string;
  try {
    title = windowTitle(input.title);
  } catch {
    throw new ConversationError(
      400,
      "Use a window name between 1 and 100 characters.",
    );
  }
  const uploadedHash = createHash("sha256").update(input.bytes).digest("hex");
  const hashForCleanup = (cleanup: boolean) => requestHash({
    title,
    cleanup,
    sha256: uploadedHash,
    consent: MEDIA_CONSENT_VERSION,
  });
  const hash = hashForCleanup(true);
  const existing = await prisma.windowPhoto.findUnique({
    where: {
      ownerId_requestId: { ownerId: owner.id, requestId: input.requestId },
    },
  });
  if (existing) {
    if (existing.requestHash !== hashForCleanup(existing.cleanup))
      throw new ConversationError(
        409,
        "This upload request was already used for another photo.",
      );
    if (existing.uploadStatus !== "ready" || existing.deletedAt)
      throw new ConversationError(
        409,
        "This upload has not completed. Check its status before retrying.",
      );
    return photoDto(existing);
  }
  const { image } = await normalizeRoomPhoto(input.bytes, {
    contentType: input.contentType,
  });
  const reserved = await prisma.$transaction(async (tx) => {
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
        "Start a chat before saving this window.",
      );
    const duplicate = await tx.windowPhoto.findUnique({
      where: {
        ownerId_requestId: { ownerId: owner.id, requestId: input.requestId },
      },
    });
    if (duplicate) {
      if (duplicate.requestHash !== hashForCleanup(duplicate.cleanup))
        throw new ConversationError(
          409,
          "This upload request was already used for another photo.",
        );
      if (duplicate.uploadStatus !== "ready" || duplicate.deletedAt)
        throw new ConversationError(
          409,
          "This upload has not completed. Check its status before retrying.",
        );
      return { photo: duplicate, created: false };
    }
    await galleryCapacity(tx, owner, image.bytes.length);
    if (
      (await tx.windowPhoto.count({
        where: { ownerId: owner.id, deletedAt: null },
      })) >= MAX_GALLERY_PHOTOS
    )
      throw new ConversationError(
        429,
        "Your window library is full. Delete a photo first.",
      );
    const id = randomUUID();
    const photo = await tx.windowPhoto.create({
      data: {
        id,
        ownerId: owner.id,
        conversationId,
        requestId: input.requestId,
        requestHash: hash,
        title,
        assetKey: `${id}.jpg`,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
        bytes: image.bytes.length,
        cleanup: true,
        consentVersion: MEDIA_CONSENT_VERSION,
        consentAt: new Date(),
      },
    });
    return { photo, created: true };
  });
  const { photo } = reserved;
  if (!reserved.created) return photoDto(photo);
  try {
    await writeAsset(image.bytes, photo.assetKey);
    const saved = await prisma.$transaction(async (tx) => {
      const allowed = await tx.windowPhoto.updateMany({
        where: { id: photo.id, deletedAt: null, uploadStatus: "saving" },
        data: {
          uploadStatus: "ready",
          analysisStatus: "queued",
          analysisVersion: ROOM_ANALYSIS_VERSION,
          analysisQueuedAt: new Date(),
        },
      });
      if (!allowed.count) throw notFound();
      const ready = await tx.windowPhoto.findUniqueOrThrow({
        where: { id: photo.id },
      });
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          galleryOwnerId: owner.id,
          status: "active",
        },
        data: { selectedWindowPhotoId: photo.id },
      });
      await mediaEvent(
        tx,
        conversationId,
        {
          type: "media",
          version: 1,
          kind: "window",
          windowId: photo.id,
          title,
          customerIntent: true,
        },
        photo.id,
      );
      return ready;
    });
    kickRoomAnalysis();
    return photoDto(saved);
  } catch (error) {
    // A lost commit acknowledgement is observed, never mistaken for permission
    // to remove a ready photo. An unavailable database leaves durable cleanup intent.
    const latest = await prisma.windowPhoto.findUnique({
      where: { id: photo.id },
    });
    if (latest && !latest.deletedAt && latest.uploadStatus === "ready") {
      kickRoomAnalysis();
      return photoDto(latest);
    }
    await prisma.windowPhoto.updateMany({
      where: { id: photo.id, uploadStatus: { not: "ready" } },
      data: { uploadStatus: "failed", deletedAt: new Date() },
    });
    await removeAsset(photo.assetKey);
    await prisma.windowPhoto.updateMany({
      where: { id: photo.id, deletedAt: { not: null } },
      data: { bytes: 0 },
    });
    throw error;
  }
}
export async function uploadStatus(ownerId: string, requestId: string) {
  const photo = await prisma.windowPhoto.findUnique({
    where: { ownerId_requestId: { ownerId, requestId } },
  });
  return !photo
    ? { status: "not_found", window: null }
    : {
        status: photo.deletedAt ? "failed" : photo.uploadStatus,
        window:
          photo.uploadStatus === "ready" && !photo.deletedAt
            ? photoDto(photo)
            : null,
      };
}
export async function renameWindow(
  ownerId: string,
  id: string,
  titleInput: string,
  revision: number,
) {
  let title: string;
  try {
    title = windowTitle(titleInput);
  } catch {
    throw new ConversationError(
      400,
      "Use a window name between 1 and 100 characters.",
    );
  }
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new ConversationError(
      400,
      "The current window revision is required.",
    );
  return prisma.$transaction(async (tx) => {
    const previous = await ownedPhoto(ownerId, id, tx);
    if (previous.revision !== revision)
      throw new ConversationError(
        409,
        "This window name changed in another tab. Refresh and try again.",
      );
    if (previous.title === title) return photoDto(previous);
    const photo = await tx.windowPhoto.update({
      where: { id },
      data: { title, revision: { increment: 1 } },
    });
    const conversations = await tx.conversation.findMany({
      where: {
        galleryOwnerId: ownerId,
        OR: [
          { id: previous.conversationId },
          { selectedWindowPhotoId: id, status: "active" },
        ],
      },
      select: { id: true },
    });
    for (const conversation of conversations)
      await mediaEvent(
        tx,
        conversation.id,
        {
          type: "media",
          version: 1,
          kind: "renamed",
          windowId: id,
          previousTitle: previous.title,
          title,
        },
        `window-rename-${id}-${photo.revision}-${conversation.id}`,
      );
    return photoDto(photo);
  });
}
export async function deleteWindow(ownerId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    await ownedPhoto(ownerId, id, tx);
    const now = new Date();
    await tx.windowPhoto.update({ where: { id }, data: {
      deletedAt: now, analysisJson: null,
      analysisStatus: "failed", analysisCompletedAt: now,
    } });
    await tx.visualizationJob.updateMany({
      where: { ownerId, windowId: id },
      data: { deletedAt: now },
    });
    await tx.visualizationJob.updateMany({
      where: {
        ownerId,
        windowId: id,
        status: { notIn: ["preparing_assets", "generating", "saving"] },
      },
      data: { status: "cancelled", reservedBytes: 0, completedAt: now },
    });
    await tx.conversation.updateMany({
      where: { galleryOwnerId: ownerId, selectedWindowPhotoId: id },
      data: { selectedWindowPhotoId: null, revision: { increment: 1 } },
    });
  });
  await cleanupDeletedMedia();
}
export async function deleteVisualization(ownerId: string, id: string) {
  const job = await prisma.visualizationJob.findFirst({
    where: { ownerId, id, deletedAt: null },
  });
  if (!job) throw notFound();
  await prisma.visualizationJob.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      ...(!["preparing_assets", "generating", "saving"].includes(job.status)
        ? { status: "cancelled", completedAt: new Date(), reservedBytes: 0 }
        : {}),
    },
  });
  await cleanupDeletedMedia();
}
export async function readGalleryAsset(
  ownerId: string,
  assetType: string,
  id: string,
) {
  if (assetType === "window") {
    const photo = await ownedPhoto(ownerId, id);
    const bytes = await readAsset(photo.assetKey);
    await ownedPhoto(ownerId, id);
    return { bytes, width: photo.width, height: photo.height };
  }
  const job = await prisma.visualizationJob.findFirst({
    where: { ownerId, id, deletedAt: null, window: { deletedAt: null } },
  });
  const key =
    assetType === "before"
      ? job?.sourceAssetKey
      : assetType === "result" && job?.status === "completed"
        ? job.resultKey
        : null;
  if (!job || !key) throw notFound();
  const bytes = await readAsset(key);
  await ownedJob(ownerId, id);
  return { bytes, width: job.width, height: job.height };
}
export async function readAdminAsset(
  shop: string,
  conversationId: string,
  assetType: "window" | "before" | "result",
  assetId: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, shop },
    select: { galleryOwnerId: true },
  });
  if (!conversation?.galleryOwnerId) throw notFound();
  const linked =
    assetType === "window"
      ? await adminWindowReference(
          conversation.galleryOwnerId,
          conversationId,
          assetId,
        )
      : await prisma.visualizationJob.findFirst({
          where: {
            id: assetId,
            ownerId: conversation.galleryOwnerId,
            conversationId,
          },
        });
  if (!linked) throw notFound();
  return readGalleryAsset(conversation.galleryOwnerId, assetType, assetId);
}
async function adminWindowReference(
  ownerId: string,
  conversationId: string,
  id: string,
) {
  if (!isMediaId(id)) return null;
  const photo = await prisma.windowPhoto.findFirst({ where: { id, ownerId } });
  if (!photo || photo.conversationId === conversationId) return photo;
  const [event, job] = await Promise.all([
    prisma.conversationMessage.findFirst({
      where: {
        conversationId,
        status: "complete",
        partsJson: { contains: JSON.stringify(id) },
        OR: [
          { partsJson: { contains: '"kind":"window"' } },
          { partsJson: { contains: '"kind":"windows"' } },
        ],
      },
      orderBy: { sequence: "desc" },
      select: { partsJson: true },
    }),
    prisma.visualizationJob.findFirst({
      where: { ownerId, conversationId, windowId: id },
      select: { id: true },
    }),
  ]);
  if (job) return photo;
  const parts: unknown = event ? JSON.parse(event.partsJson) : null;
  return Array.isArray(parts) &&
    parts.some(
      (part) =>
        isMediaPart(part) &&
        ((part.kind === "window" && part.windowId === id) ||
          (part.kind === "windows" && part.windowIds.includes(id))),
    )
    ? photo
    : null;
}
export async function ownedJob(ownerId: string, id: string) {
  const job = await prisma.visualizationJob.findFirst({
    where: { ownerId, id, deletedAt: null, window: { deletedAt: null } },
  });
  if (!job) throw notFound();
  return job;
}
export async function expirePreparations() {
  await prisma.visualizationJob.updateMany({
    where: {
      status: { in: ["awaiting_product", "preparing_assets"] },
      deadlineAt: { lte: new Date() },
    },
    data: {
      status: "failed",
      error: "Product preparation timed out. Please try again.",
      completedAt: new Date(),
      reservedBytes: 0,
    },
  });
}
export async function cleanupDeletedMedia() {
  const [photos, jobs] = await Promise.all([
    prisma.windowPhoto.findMany({
      where: { deletedAt: { not: null }, bytes: { gt: 0 } },
      orderBy: { deletedAt: "asc" },
      take: 20,
    }),
    prisma.visualizationJob.findMany({
      where: {
        resultKey: { not: null },
        OR: [
          { deletedAt: { not: null } },
          { status: { in: ["failed", "unknown", "cancelled"] } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    }),
  ]);
  for (const photo of photos) {
    try {
      await removeAsset(photo.assetKey);
      await prisma.windowPhoto.updateMany({
        where: { id: photo.id, deletedAt: { not: null } },
        data: { bytes: 0 },
      });
    } catch {
      console.error("[Roman] Deleted window photo cleanup will be retried.", {
        windowId: photo.id,
      });
    }
  }
  for (const job of jobs) {
    try {
      await removeAsset(job.resultKey!);
      await prisma.visualizationJob.updateMany({
        // A cancelled writer may still finish its already-started file I/O.
        // Retain the durable key until it settles so recovery can reclaim it.
        where: {
          id: job.id,
          resultKey: job.resultKey,
          status: { notIn: ["preparing_assets", "generating", "saving"] },
        },
        data: { resultKey: null, resultBytes: 0 },
      });
    } catch {
      console.error("[Roman] Deleted visualization cleanup will be retried.", {
        jobId: job.id,
      });
    }
  }
}
export { ACTIVE_JOB_STATUSES };
