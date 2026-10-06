import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  readAdminAsset,
  deleteWindow,
  deleteVisualization,
} from "../visualizations/repository.server";
import prisma from "../db.server";
import { ConversationError } from "../conversations/errors.server";

const missing = () =>
  new Response("Image not found.", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { id, assetType, assetId } = params;
  if (
    !id ||
    !assetId ||
    (assetType !== "window" && assetType !== "before" && assetType !== "result")
  )
    throw new Response("Image not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  let asset;
  try {
    asset = await readAdminAsset(session.shop, id, assetType, assetId);
  } catch (error) {
    if (error instanceof ConversationError && error.status === 404)
      throw missing();
    throw error;
  }
  if (!asset)
    throw new Response("Image not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (request.method !== "DELETE")
    throw new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "DELETE" },
    });
  const { id, assetId, assetType } = params;
  if (!id || !assetId || (assetType !== "window" && assetType !== "result"))
    throw missing();
  const conversation = await prisma.conversation.findFirst({
    where: { id, shop: session.shop },
    select: { galleryOwnerId: true },
  });
  if (!conversation?.galleryOwnerId) throw missing();
  const linked =
    assetType === "window"
      ? await prisma.windowPhoto.findFirst({
          where: {
            id: assetId,
            ownerId: conversation.galleryOwnerId,
            conversationId: id,
          },
          select: { id: true },
        })
      : await prisma.visualizationJob.findFirst({
          where: {
            id: assetId,
            ownerId: conversation.galleryOwnerId,
            conversationId: id,
          },
          select: { id: true },
        });
  if (!linked) throw missing();
  try {
    if (assetType === "window")
      await deleteWindow(conversation.galleryOwnerId, assetId);
    else await deleteVisualization(conversation.galleryOwnerId, assetId);
  } catch (error) {
    if (error instanceof ConversationError && error.status === 404)
      throw missing();
    throw error;
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
};
