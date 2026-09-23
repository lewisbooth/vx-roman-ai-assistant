import type { LoaderFunctionArgs } from "react-router";
import { authenticateBootstrap } from "../conversations/auth.server";
import { getAvailabilityStatus } from "../conversations/availability.server";
import { handleJsonRequest } from "../conversations/http.server";

function handle({ request }: LoaderFunctionArgs) {
  return handleJsonRequest(request, "GET", async () => {
    await authenticateBootstrap(request);
    return { status: await getAvailabilityStatus() };
  });
}

export { handle as loader, handle as action };
