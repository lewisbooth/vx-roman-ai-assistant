import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { ConversationError } from "../conversations/errors.server";
import {
  handleJsonRequest,
  readJsonObject,
} from "../conversations/http.server";
import { executeManualMeasurementTool } from "../measurements/service.server";

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "POST", async () => {
    const conversation = await authenticateConversation(request, params.id);
    const body = await readJsonObject(request);
    if (
      Object.keys(body).length !== 3 ||
      typeof body.requestId !== "string" ||
      typeof body.name !== "string" ||
      !Object.hasOwn(body, "arguments")
    )
      throw new ConversationError(
        400,
        "Send only requestId, name and arguments.",
      );
    const result = await executeManualMeasurementTool(
      conversation.id,
      body.requestId,
      body.name,
      body.arguments,
    );
    return { result };
  });
}

export { handle as loader, handle as action };
