import type { LoaderFunctionArgs } from "react-router";
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
    if (!input) {
      throttleConversationCreation(shop);
      return createConversation(shop, origin);
    }
    const credential = await authorizeStorefrontCredential(
      input.conversationId,
      input.token,
      origin,
      shop,
    );
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
