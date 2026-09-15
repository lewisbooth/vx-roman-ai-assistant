import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import { voiceClientInput, voiceSessionId } from "../voice/http.server";
import { readyVoice } from "../voice/service.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const voiceId = voiceSessionId(params.voiceId);
    const { clientId } = voiceClientInput(await readJsonObject(request));
    readyVoice(conversation.id, voiceId, clientId);
    return { ok: true };
  });
}

export { handle as loader, handle as action };
