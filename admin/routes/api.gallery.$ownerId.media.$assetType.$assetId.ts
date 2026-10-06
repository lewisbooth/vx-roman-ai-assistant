import type { LoaderFunctionArgs } from "react-router";
import { authenticateGallery } from "../visualizations/auth.server";
import { readGalleryAsset } from "../visualizations/repository.server";
import { allowedOrigin } from "../conversations/auth.server";
import { ConversationError } from "../conversations/errors.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const headers = new Headers({ "Cache-Control": "private, no-store", "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff", Vary: "Origin" });
  const origin = allowedOrigin(request);
  if (origin) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Access-Control-Allow-Methods", "GET, OPTIONS"); headers.set("Access-Control-Allow-Headers", "Authorization"); }
  if (request.method === "OPTIONS" && origin) return new Response(null, { status: 204, headers });
  try {
    const owner = await authenticateGallery(request, params.ownerId);
    const asset = await readGalleryAsset(owner.id, params.assetType ?? "", params.assetId ?? "");
    return new Response(new Uint8Array(asset.bytes), { headers });
  } catch (error) { return new Response(null, { status: error instanceof ConversationError ? error.status : 500, headers }); }
}
