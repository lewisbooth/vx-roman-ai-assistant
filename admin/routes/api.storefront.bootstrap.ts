import type { LoaderFunctionArgs } from "react-router";
import {
  authorizeGallery,
  linkGalleryConversation,
} from "../visualizations/auth.server";
import {
  authenticateBootstrap,
  authorizeStorefrontCredential,
  throttleConversationCreation,
} from "../conversations/auth.server";
import {
  bootstrapInput,
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import {
  conversationApiBaseUrl,
  createConversation,
  getSnapshot,
} from "../conversations/repository.server";

function handle({ request }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const { shop, origin } = await authenticateBootstrap(request);
    const input = bootstrapInput(await readJsonObject(request));
    const gallery = input?.gallery
      ? await authorizeGallery(
          input.gallery.ownerId,
          input.gallery.token,
          origin,
          shop,
        )
      : undefined;
    if (!input?.conversationId) {
      throttleConversationCreation(shop);
      const created = await createConversation(shop, origin);
      if (!gallery) return created;
      await linkGalleryConversation(
        gallery,
        created.conversationId,
        created.token,
      );
      return {
        ...created,
        conversation: await getSnapshot(created.conversationId),
      };
    }
    const credential = await authorizeStorefrontCredential(
      input.conversationId,
      input.token,
      origin,
      shop,
    );
    if (gallery)
      await linkGalleryConversation(gallery, credential.id, input.token);
    return {
      conversationId: credential.id,
      token: input.token,
      expiresAt: credential.expiresAt.toISOString(),
      apiBaseUrl: conversationApiBaseUrl(),
      conversation: await getSnapshot(credential.id),
    };
  });
}

export { handle as loader, handle as action };
