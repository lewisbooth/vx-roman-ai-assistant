import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { APP_NAME } from "../../shared/brand";
import { authenticate } from "../shopify.server";
import { getConversationOverview } from "../insights/repository.server";
import { ConversationList, RecordedUsage } from "../insights/ConversationViews";
import { EstimatedCosts, PricingHistory } from "../pricing/PricingViews";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const pages = new URL(request.url).searchParams.getAll("page");
  const page = pages.length === 0 ? 1 : Number(pages[0]);
  if (
    pages.length > 1 ||
    (pages.length === 1 && !/^[1-9]\d*$/.test(pages[0])) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000
  ) {
    throw new Response("Invalid conversation page.", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const overview = await getConversationOverview(session.shop, page);
  const themeEditorUrl = new URL(
    `https://${session.shop}/admin/themes/current/editor`,
  );
  themeEditorUrl.searchParams.set("context", "apps");
  themeEditorUrl.searchParams.set(
    "activateAppId",
    `${process.env.SHOPIFY_API_KEY}/roman-assistant`,
  );

  return data(
    { overview, themeEditorUrl: themeEditorUrl.toString() },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
};

export default function Home() {
  const { overview, themeEditorUrl } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  return (
    <s-page heading={APP_NAME}>
      <s-button
        slot="secondary-actions"
        onClick={() => void revalidator.revalidate()}
        loading={revalidator.state !== "idle"}
      >
        Refresh
      </s-button>
      <s-section heading="Conversations">
        <s-stack gap="base">
          <s-paragraph>
            {overview.summary.conversations} conversations ·{" "}
            {overview.summary.endedConversations} ended ·{" "}
            {overview.summary.failedReplies} failed replies
          </s-paragraph>
          <ConversationList overview={overview} />
          <s-paragraph color="subdued">
            Showing this store only, newest first. Active means the conversation
            has not been ended, not that a customer is online.
          </s-paragraph>
        </s-stack>
      </s-section>
      <s-section heading="Recorded usage — this store">
        <RecordedUsage usage={overview.summary.usage} />
      </s-section>
      <s-section heading="Estimated costs — this store">
        <EstimatedCosts cost={overview.summary.cost} />
      </s-section>
      <s-section heading="Pricing history">
        <PricingHistory prices={overview.prices} />
      </s-section>
      <s-section heading="Storefront assistant">
        <s-paragraph>
          Enable the Assistant icon app embed in your theme and save your
          changes to show the R icon beside Profile in the storefront header.
          On other themes, it appears at the bottom left.
        </s-paragraph>
        <s-button href={themeEditorUrl} target="_blank">
          Open theme editor
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
