import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { handleJsonRequest } from "../conversations/http.server";
import { readConversation } from "../conversations/runner.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "GET", async () => {
    const conversation = await authenticateConversation(request, params.id);
    return readConversation(conversation.id);
  });
}

export { handle as loader, handle as action };
