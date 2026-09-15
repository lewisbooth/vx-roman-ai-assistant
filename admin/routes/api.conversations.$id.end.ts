import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  emptyInput,
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import { endTurn } from "../conversations/runner.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    emptyInput(await readJsonObject(request));
    return endTurn(conversation.id);
  });
}

export { handle as loader, handle as action };
