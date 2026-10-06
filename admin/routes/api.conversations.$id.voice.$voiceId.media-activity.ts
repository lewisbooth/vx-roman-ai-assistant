import type { ActionFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { handleJsonRequest, readJsonObject } from "../conversations/http.server";
import { voiceClientInput, voiceSessionId } from "../voice/http.server";
import { noteVoiceMediaActivity } from "../voice/service.server";

export function action({ request, params }: ActionFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const { clientId } = voiceClientInput(await readJsonObject(request));
    const idleExpiresAt = noteVoiceMediaActivity(conversation.id, voiceSessionId(params.voiceId), clientId);
    return { idleExpiresAt, idleRemainingMs: idleExpiresAt ? Math.max(0, Date.parse(idleExpiresAt) - Date.now()) : null };
  });
}
