import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { submitBrowserToolResult } from "../conversations/browser-tools.server";
import {
  handleJsonRequest,
  readJsonObject,
  toolInvocationId,
  toolResultInput,
} from "../conversations/http.server";
import { readConversation } from "../conversations/runner.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const invocationId = toolInvocationId(params.invocationId);
    const input = toolResultInput(await readJsonObject(request, 128 * 1024));
    await submitBrowserToolResult(
      conversation.id,
      invocationId,
      input.claim,
      input.result,
      input.error,
    );
    return readConversation(conversation.id);
  });
}

export { handle as loader, handle as action };
