import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { handleJsonRequest } from "../conversations/http.server";
import { getHistoryPage } from "../conversations/repository.server";
import { ConversationError } from "../conversations/errors.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "GET", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const values = new URL(request.url).searchParams.getAll("before");
    if (values.length !== 1 || !/^\d{1,16}$/.test(values[0]))
      throw new ConversationError(400, "Send a valid history cursor.");
    return getHistoryPage(conversation.id, Number(values[0]));
  });
}

export { handle as loader, handle as action };
