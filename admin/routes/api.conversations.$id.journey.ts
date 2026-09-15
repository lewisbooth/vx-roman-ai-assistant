import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import {
  handleJsonRequest,
  journeyInput,
  readJsonObject,
} from "../conversations/http.server";
import { appendJourney } from "../conversations/repository.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    return appendJourney(
      conversation.id,
      journeyInput(await readJsonObject(request)),
    );
  });
}

export { handle as loader, handle as action };
