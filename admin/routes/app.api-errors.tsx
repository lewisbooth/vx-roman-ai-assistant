import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ApiErrorsView } from "../api-errors/ApiErrorViews";
import { getApiErrorReport, readApiErrorRange } from "../api-errors/repository.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  let range;
  try {
    range = readApiErrorRange(new URL(request.url).searchParams);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new Response(error.message, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return data(await getApiErrorReport(range), {
    headers: { "Cache-Control": "no-store" },
  });
};

export default function ApiErrorsPage() {
  const report = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <s-page heading="API Errors">
      <s-button slot="secondary-actions" href="/app">Overview</s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => void revalidator.revalidate()}
        loading={revalidator.state !== "idle"}
      >
        Refresh
      </s-button>
      <ApiErrorsView report={report} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
