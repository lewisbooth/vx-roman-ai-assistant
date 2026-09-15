import type { LoaderFunctionArgs } from "react-router";
import { authenticateConversation } from "../conversations/auth.server";
import { handleJsonRequest } from "../conversations/http.server";
import { readConversation } from "../conversations/runner.server";
import { ConversationError } from "../conversations/errors.server";
import type { ConversationReadVersion } from "../../shared/conversation";

function readVersion(request: Request): ConversationReadVersion | undefined {
  const query = new URL(request.url).searchParams;
  if (!query.has("revision") && !query.has("streamRevision")) return;
  const revision = query.getAll("revision");
  const stream = query.getAll("streamRevision");
  if (
    revision.length !== 1 ||
    stream.length !== 1 ||
    !/^\d{1,16}$/.test(revision[0]) ||
    !/^\d{1,16}$/.test(stream[0]) ||
    !Number.isSafeInteger(Number(revision[0])) ||
    !Number.isSafeInteger(Number(stream[0]))
  )
    throw new ConversationError(400, "Send a valid conversation read version.");
  return { revision: Number(revision[0]), streamRevision: Number(stream[0]) };
}

function handle({ request, params }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "GET", async () => {
    const conversation = await authenticateConversation(request, params.id);
    return readConversation(conversation.id, readVersion(request));
  });
}

export { handle as loader, handle as action };
