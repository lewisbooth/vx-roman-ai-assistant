import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import { VOICE_START_BODY_BYTES, voiceStartInput } from "../voice/http.server";
import { startVoice } from "../voice/service.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const input = voiceStartInput(
      await readJsonObject(request, VOICE_START_BODY_BYTES),
    );
    return startVoice(conversation.id, input);
  });
}

export { handle as loader, handle as action };
