import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  messageInput,
  readJsonObject,
} from "../conversations/http.server";
import { startTurn } from "../conversations/runner.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(
    request,
    "POST",
    async () => {
      const conversation = await authenticateConversation(request, params.id);
      const input = messageInput(await readJsonObject(request));
      return startTurn(conversation.id, input);
    },
    202,
  );
}

export { handle as loader, handle as action };
