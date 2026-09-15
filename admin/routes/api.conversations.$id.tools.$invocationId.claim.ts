import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  claimInput,
  handleJsonRequest,
  readJsonObject,
  toolInvocationId,
} from "../conversations/http.server";
import { claimBrowserTool } from "../conversations/browser-tools.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    return claimBrowserTool(
      conversation.id,
      toolInvocationId(params.invocationId),
      claimInput(await readJsonObject(request)),
    );
  });
}

export { handle as loader, handle as action };
