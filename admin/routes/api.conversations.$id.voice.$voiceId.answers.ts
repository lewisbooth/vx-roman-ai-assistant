import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import { readConversation } from "../conversations/runner.server";
import { voiceAnswerInput, voiceSessionId } from "../voice/http.server";
import { answerVoiceQuestion } from "../voice/service.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const voiceId = voiceSessionId(params.voiceId);
    const input = voiceAnswerInput(await readJsonObject(request));
    await answerVoiceQuestion(conversation.id, voiceId, input);
    return readConversation(conversation.id);
  });
}

export { handle as loader, handle as action };
