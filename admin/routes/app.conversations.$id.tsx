import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getConversationInspection } from "../insights/repository.server";
import {
  ConversationTimeline,
  ModelActivity,
  RecordedUsage,
  ToolActivity,
  VoiceActivity,
} from "../insights/ConversationViews";
import { recordedDate } from "../insights/format";
import { EstimatedCosts } from "../pricing/PricingViews";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const inspection = params.id
    ? await getConversationInspection(session.shop, params.id)
    : null;
  if (!inspection) {
    throw new Response("Conversation not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return data({ inspection }, { headers: { "Cache-Control": "no-store" } });
};

export default function ConversationDetail() {
  const { inspection } = useLoaderData<typeof loader>();
  const { conversation } = inspection;
  const revalidator = useRevalidator();

  return (
    <s-page heading={`Conversation ${conversation.id.slice(0, 8)}`}>
      <s-link slot="breadcrumb-actions" href="/app">
        Conversations
      </s-link>
      <s-button
        slot="secondary-actions"
        onClick={() => void revalidator.revalidate()}
        loading={revalidator.state !== "idle"}
      >
        Refresh
      </s-button>
      <s-section heading="Session">
        <s-stack gap="base">
          <s-paragraph>
            {conversation.status} · {conversation.turnCount} turns ·{" "}
            {conversation.voiceSessions} voice sessions
          </s-paragraph>
          <s-paragraph>
            Started {recordedDate(conversation.createdAt)}. Updated{" "}
            {recordedDate(conversation.updatedAt)}.
          </s-paragraph>
          <s-paragraph color="subdued">{conversation.origin}</s-paragraph>
        </s-stack>
      </s-section>
      <s-section heading="Recorded usage">
        <RecordedUsage usage={inspection.usage} />
      </s-section>
      <s-section heading="Estimated costs">
        <EstimatedCosts cost={inspection.cost} />
      </s-section>
      <s-section heading="Transcript">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Text, voice captions, page visits and product references in their
            saved order. Voice captions do not confirm which audio the customer
            heard.
          </s-paragraph>
          <ConversationTimeline
            messages={inspection.messages}
            origin={conversation.origin}
          />
        </s-stack>
      </s-section>
      <s-section heading="Tool activity">
        <ToolActivity tools={inspection.tools} />
      </s-section>
      <s-section heading="Model calls">
        <ModelActivity usage={inspection.modelUsage} />
      </s-section>
      <s-section heading="Voice sessions">
        <VoiceActivity sessions={inspection.voiceSessions} />
      </s-section>
    </s-page>
  );
}
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
