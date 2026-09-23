import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  journeyInput,
  readJsonObject,
} from "../conversations/http.server";
import { appendJourney } from "../conversations/repository.server";
import { noteVoicePageView } from "../voice/service.server";
import { assertServiceAvailable } from "../conversations/availability.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    await assertServiceAvailable();
    const input = journeyInput(await readJsonObject(request));
    const snapshot = await appendJourney(conversation.id, input);
    noteVoicePageView(conversation.id, input);
    return snapshot;
  });
}

export { handle as loader, handle as action };
