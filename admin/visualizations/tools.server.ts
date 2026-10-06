import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";
import {
  isMediaId,
  parsePhotoPresentation,
  windowTitle,
  type PhotoPresentation,
} from "../../shared/visualizations";
import { isStorefrontPagePath } from "../../shared/journey";
import { visualizationsEnabled } from "./config.server";
import { ownedPhoto, photoDto, renameWindow } from "./repository.server";
import { startVisualization } from "./jobs.server";

import { isVisualizationTool } from "./tool-definitions";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new ConversationError(400, "Invalid photo tool arguments.");
}

/** Private domain operations never enter the browser executor's operation guard. */
export async function createVisualizationTurn(
  conversationId: string,
  assistantId: string,
  signal: AbortSignal,
) {
  if (!visualizationsEnabled()) return undefined;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      shop: true,
      origin: true,
      status: true,
      galleryOwnerId: true,
      selectedWindowPhotoId: true,
      galleryOwner: { select: { id: true, revokedAt: true } },
    },
  });
  if (
    !conversation ||
    !visualizationsEnabled(conversation.shop) ||
    conversation.status !== "active" ||
    !conversation.galleryOwnerId ||
    conversation.galleryOwner?.revokedAt
  )
    return undefined;
  const owner = {
    id: conversation.galleryOwnerId,
    shop: conversation.shop,
    origin: conversation.origin,
  };
  const verified = new Set<string>();
  if (conversation.selectedWindowPhotoId)
    verified.add(conversation.selectedWindowPhotoId);
  let calls = 0;
  const validatePresentation = async (
    input: unknown,
  ): Promise<PhotoPresentation | null> => {
    const selection = parsePhotoPresentation(input);
    if (selection?.kind === "windows") {
      if (selection.windowIds.some((id) => !verified.has(id)))
        throw new Error(
          "Present only saved photo IDs verified by list_windows in this turn or the current selected window.",
        );
      const count = await prisma.windowPhoto.count({
        where: {
          ownerId: owner.id,
          id: { in: selection.windowIds },
          uploadStatus: "ready",
          deletedAt: null,
        },
      });
      if (count !== selection.windowIds.length)
        throw new Error(
          "A selected photo is no longer available. Use current saved photos.",
        );
    }
    return selection;
  };
  return {
    allows: () => calls < 4 && !signal.aborted,
    validatePresentation,
    async execute(
      callId: string,
      name: string,
      raw: unknown,
    ): Promise<unknown> {
      signal.throwIfAborted();
      if (!isVisualizationTool(name) || ++calls > 4)
        throw new Error("Roman reached the photo tool budget for this reply.");
      if (!callId || callId.length > 200 || !object(raw))
        throw new ConversationError(400, "Invalid photo tool request.");
      const active = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          status: "active",
          galleryOwnerId: owner.id,
        },
      });
      if (!active)
        throw new ConversationError(
          409,
          "This photo request belongs to an ended chat.",
        );
      const previous = await prisma.toolInvocation.findUnique({
        where: {
          conversationId_providerCallId: {
            conversationId,
            providerCallId: callId,
          },
        },
      });
      if (previous) {
        if (
          previous.assistantId !== assistantId ||
          previous.name !== name ||
          previous.argumentsJson !== JSON.stringify(raw)
        )
          throw new ConversationError(409, "This photo request has changed.");
        if (previous.status === "complete" && previous.resultJson) {
          const result = JSON.parse(previous.resultJson);
          if (name === "list_windows" && Array.isArray(result.windows))
            for (const photo of result.windows)
              if (isMediaId(photo?.id)) verified.add(photo.id);
          return result;
        }
        return {
          error:
            previous.error ??
            "The earlier photo request's result is unconfirmed. It was not repeated.",
        };
      }
      const receipt = await prisma.toolInvocation.create({
        data: {
          id: randomUUID(),
          conversationId,
          assistantId,
          providerCallId: callId,
          name,
          argumentsJson: JSON.stringify(raw),
        },
      });
      try {
        let result: unknown;
        if (name === "list_windows") {
          exact(raw, ["query", "cursor"]);
          if (
            (raw.query !== null &&
              (typeof raw.query !== "string" || raw.query.length > 100)) ||
            (raw.cursor !== null && !isMediaId(raw.cursor))
          )
            throw new ConversationError(
              400,
              "Send a valid window title query and photo cursor.",
            );
          const cursor = raw.cursor
            ? await ownedPhoto(owner.id, raw.cursor as string)
            : undefined;
          const where = {
            ownerId: owner.id,
            uploadStatus: "ready",
            deletedAt: null,
            ...(raw.query
              ? { title: { contains: (raw.query as string).trim() } }
              : {}),
          };
          const [photos, total] = await Promise.all([
            prisma.windowPhoto.findMany({
              where: {
                ...where,
                ...(cursor
                  ? {
                      OR: [
                        { createdAt: { lt: cursor.createdAt } },
                        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                      ],
                    }
                  : {}),
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 11,
            }),
            prisma.windowPhoto.count({ where }),
          ]);
          const windows = photos.slice(0, 10).map(photoDto);
          for (const photo of windows) verified.add(photo.id);
          result = {
            windows,
            total,
            nextCursor: photos.length > 10 ? windows.at(-1)!.id : null,
          };
        } else {
          const id = raw.windowId;
          if (!isMediaId(id) || !verified.has(id))
            throw new ConversationError(
              400,
              "Use a known saved window from current application state or list_windows first.",
            );
          const photo = await ownedPhoto(owner.id, id);
          if (name === "rename_window") {
            exact(raw, ["windowId", "title"]);
            const title = windowTitle(raw.title);
            result = await renameWindow(owner.id, id, title, photo.revision);
          } else {
            exact(raw, [
              "windowId",
              "productPath",
              "cleanup",
              "targetDescription",
            ]);
            if (
              typeof raw.productPath !== "string" ||
              !isStorefrontPagePath(raw.productPath, owner.origin) ||
              (raw.cleanup !== null && typeof raw.cleanup !== "boolean") ||
              (raw.targetDescription !== null &&
                typeof raw.targetDescription !== "string")
            )
              throw new ConversationError(
                400,
                "Send the active product path, cleanup preference and optional target description.",
              );
            result = await startVisualization(owner, conversationId, {
              requestId: receipt.id,
              windowId: id,
              productPath: raw.productPath,
              cleanup:
                raw.cleanup === null ? photo.cleanup : (raw.cleanup as boolean),
              ...(raw.targetDescription
                ? { targetDescription: raw.targetDescription as string }
                : {}),
            });
          }
        }
        await prisma.toolInvocation.update({
          where: { id: receipt.id },
          data: {
            status: "complete",
            resultJson: JSON.stringify(result),
            completedAt: new Date(),
          },
        });
        return result;
      } catch (error) {
        const message =
          error instanceof ConversationError
            ? error.message
            : signal.aborted
              ? "The photo request was interrupted; its result may already have been saved."
              : "The photo request could not be completed.";
        await prisma.toolInvocation.update({
          where: { id: receipt.id },
          data: { status: "failed", error: message, completedAt: new Date() },
        });
        signal.throwIfAborted();
        return { error: message };
      }
    },
  };
}
export type VisualizationTurn = NonNullable<
  Awaited<ReturnType<typeof createVisualizationTurn>>
>;
