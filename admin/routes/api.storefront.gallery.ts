import type { ActionFunctionArgs } from "react-router";
import { authenticateBootstrap } from "../conversations/auth.server";
import { handleJsonRequest, readJsonObject } from "../conversations/http.server";
import { ConversationError } from "../conversations/errors.server";
import { authorizeGallery, createGalleryOwner } from "../visualizations/auth.server";
import { gallerySnapshot } from "../visualizations/repository.server";
import { recoverImageJobs } from "../visualizations/jobs.server";

export function action({ request }: ActionFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const { shop, origin } = await authenticateBootstrap(request);
    const body = await readJsonObject(request);
    const keys = Object.keys(body);
    let credential;
    if (!keys.length) {
      credential = await createGalleryOwner(shop, origin);
    } else if (keys.length === 2 && typeof body.ownerId === "string" && typeof body.token === "string") {
      await authorizeGallery(body.ownerId, body.token, origin, shop);
      credential = { ownerId: body.ownerId, token: body.token, apiBaseUrl: `${new URL(process.env.SHOPIFY_APP_URL!).origin}/api/gallery` };
    } else throw new ConversationError(400, "Send an empty object or your saved gallery credential.");
    await recoverImageJobs();
    return { credential, gallery: await gallerySnapshot(credential.ownerId) };
  });
}
