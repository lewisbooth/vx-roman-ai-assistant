import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import type { ConversationMessage, GuidePart } from "../../shared/conversation";
import {
  parseGuidePart,
  PRODUCT_GUIDE_LABELS,
} from "../../shared/product-guides";
import type {
  ConversationInspection,
  ConversationOverview,
  UsageSummary,
} from "./contracts";
import { CostValue } from "../pricing/PricingViews";
import {
  recordedDate,
  recordedNumber,
  serviceTierLabel,
  storefrontHref,
} from "./format";

export function RecordedUsage({ usage }: { usage: UsageSummary }) {
  return (
    <s-stack gap="base">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {[
          ["Input tokens", recordedNumber(usage.inputTokens)],
          ["Cached input tokens", recordedNumber(usage.cachedInputTokens)],
          [
            "Cache-write input tokens",
            recordedNumber(usage.cacheWriteInputTokens),
          ],
          ["Output tokens", recordedNumber(usage.outputTokens)],
          ["Reasoning tokens", recordedNumber(usage.reasoningTokens)],
          ["Total tokens", recordedNumber(usage.totalTokens)],
          ["Voice seconds", recordedNumber(usage.voiceSeconds)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mt-1 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <s-paragraph color="subdued">
        Backend models report tokens for text and delegated work; GPT-Live
        reports audio seconds. Usage reported for {usage.reportedModelCalls} of{" "}
        {usage.modelCalls} backend calls and {usage.reportedVoiceSessions} of{" "}
        {usage.voiceSessions} GPT-Live sessions. Totals include recorded usage
        only. Older or unfinished activity may have no usage report. Cached and
        cache-write input tokens are subsets of input; reasoning tokens are
        included in output. These recorded counts are the basis for the separate
        cost estimates.
      </s-paragraph>
    </s-stack>
  );
}

export function ConversationList({
  overview,
}: {
  overview: ConversationOverview;
}) {
  return (
    <s-stack gap="base">
      {overview.conversations.length === 0 ? (
        <s-paragraph>
          {overview.page === 1
            ? "No conversations yet. Start a chat with Roman on this store to see it here."
            : "No conversations on this page."}
        </s-paragraph>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Conversation</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header>Last updated</s-table-header>
            <s-table-header format="numeric">Turns</s-table-header>
            <s-table-header format="numeric">Voice sessions</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {overview.conversations.map((conversation) => (
              <s-table-row key={conversation.id}>
                <s-table-cell>
                  <s-link href={`/app/conversations/${conversation.id}`}>
                    {recordedDate(conversation.createdAt)}
                  </s-link>
                  <div className="text-xs text-gray-600">
                    {conversation.id.slice(0, 8)}
                  </div>
                </s-table-cell>
                <s-table-cell>{conversation.status}</s-table-cell>
                <s-table-cell>
                  {recordedDate(conversation.updatedAt)}
                </s-table-cell>
                <s-table-cell>{conversation.turnCount}</s-table-cell>
                <s-table-cell>{conversation.voiceSessions}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      )}
      <s-stack direction="inline" gap="base" alignItems="center">
        {overview.page > 1 && (
          <s-button href={`/app?page=${overview.page - 1}`}>Previous</s-button>
        )}
        <s-text>Page {overview.page}</s-text>
        {overview.hasNextPage && (
          <s-button href={`/app?page=${overview.page + 1}`}>Next</s-button>
        )}
      </s-stack>
    </s-stack>
  );
}

function TranscriptLink({
  value,
  origin,
  children,
}: {
  value: string;
  origin: string;
  children: React.ReactNode;
}) {
  const href = storefrontHref(value, origin);
  return href ? (
    <a
      className="underline"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

export function ConversationTimeline({
  messages,
  origin,
}: {
  messages: ConversationMessage[];
  origin: string;
}) {
  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children }) => (
        <TranscriptLink value={href || ""} origin={origin}>
          {children}
        </TranscriptLink>
      ),
    }),
    [origin],
  );

  if (messages.length === 0)
    return (
      <s-paragraph>No messages recorded in this conversation.</s-paragraph>
    );

  return (
    <ol className="space-y-4" aria-label="Conversation transcript">
      {messages.map((message) => (
        <li key={message.id} className="rounded border border-gray-200 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <strong>
              {message.role === "user"
                ? "Customer"
                : message.role === "assistant"
                  ? "Roman"
                  : "Activity"}
            </strong>
            <time dateTime={message.createdAt} className="text-gray-600">
              {recordedDate(message.createdAt)}
            </time>
            {message.status !== "complete" && <span>{message.status}</span>}
          </div>
          <div className="space-y-3 break-words">
            {message.parts.map((part, index) => {
              if (part.type === "page_view")
                return (
                  <p key={index}>
                    Viewed{" "}
                    <TranscriptLink value={part.path} origin={origin}>
                      {part.title || part.path}
                    </TranscriptLink>
                  </p>
                );
              if (part.type === "products")
                return (
                  <div key={index}>
                    <p className="text-sm font-semibold">Product carousel</p>
                    <ul className="list-inside list-disc text-sm">
                      {part.productIds.map((id) => (
                        <li key={id}>{id}</li>
                      ))}
                    </ul>
                    <p className="text-xs text-gray-600">
                      Saved product references; current catalog details are not
                      loaded in this view.
                    </p>
                  </div>
                );
              if (part.type === "guides")
                return (
                  <InspectedGuides key={index} part={part} origin={origin} />
                );
              if (part.type === "voice")
                return (
                  <div key={index}>
                    <span className="text-xs font-semibold text-gray-600">
                      Voice
                    </span>
                    <p className="whitespace-pre-wrap">{part.text}</p>
                  </div>
                );
              return message.role === "assistant" ? (
                <div
                  key={index}
                  className="space-y-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-bold [&_pre]:whitespace-pre-wrap"
                >
                  <Markdown
                    skipHtml
                    allowedElements={[
                      "p",
                      "br",
                      "strong",
                      "em",
                      "ul",
                      "ol",
                      "li",
                      "a",
                      "blockquote",
                      "pre",
                      "code",
                      "hr",
                    ]}
                    unwrapDisallowed
                    components={markdownComponents}
                  >
                    {part.text}
                  </Markdown>
                </div>
              ) : (
                <p key={index} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              );
            })}
            {message.error && <p className="text-red-700">{message.error}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function InspectedGuides({
  part,
  origin,
}: {
  part: GuidePart;
  origin: string;
}) {
  let guides: GuidePart["guides"];
  try {
    guides = parseGuidePart(part, origin).guides;
  } catch {
    return (
      <p className="text-sm text-gray-600">
        These saved product guides are unavailable.
      </p>
    );
  }
  return (
    <div>
      <p className="text-sm font-semibold">Product guides</p>
      <ul className="list-inside list-disc text-sm">
        {guides.map((guide) => (
          <li key={guide.kind}>
            <a
              className="underline"
              href={guide.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PRODUCT_GUIDE_LABELS[guide.kind]}
            </a>{" "}
            <span className="text-gray-600">(PDF, opens in a new tab)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ToolActivity({
  tools,
}: {
  tools: ConversationInspection["tools"];
}) {
  if (tools.length === 0)
    return <s-paragraph>No tool activity recorded.</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Tool</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header>Started</s-table-header>
        <s-table-header>Completed</s-table-header>
        <s-table-header>Failure</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {tools.map((tool) => (
          <s-table-row key={tool.id}>
            <s-table-cell>{tool.name}</s-table-cell>
            <s-table-cell>{tool.status}</s-table-cell>
            <s-table-cell>{recordedDate(tool.createdAt)}</s-table-cell>
            <s-table-cell>{recordedDate(tool.completedAt)}</s-table-cell>
            <s-table-cell>{tool.error || "—"}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export function ModelActivity({
  usage,
}: {
  usage: ConversationInspection["modelUsage"];
}) {
  if (usage.length === 0)
    return <s-paragraph>No model call records available.</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Model / service tier</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header>Started</s-table-header>
        <s-table-header format="numeric">
          Input / cached / cache-write
        </s-table-header>
        <s-table-header format="numeric">Output / reasoning</s-table-header>
        <s-table-header format="numeric">Total tokens</s-table-header>
        <s-table-header>Estimated cost</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {usage.map((call) => (
          <s-table-row key={call.id}>
            <s-table-cell>
              {call.model} / {serviceTierLabel(call.serviceTier)}
            </s-table-cell>
            <s-table-cell>{call.status}</s-table-cell>
            <s-table-cell>{recordedDate(call.createdAt)}</s-table-cell>
            <s-table-cell>
              {recordedNumber(call.inputTokens)} /{" "}
              {recordedNumber(call.cachedInputTokens)} /{" "}
              {recordedNumber(call.cacheWriteInputTokens)}
            </s-table-cell>
            <s-table-cell>
              {recordedNumber(call.outputTokens)} /{" "}
              {recordedNumber(call.reasoningTokens)}
            </s-table-cell>
            <s-table-cell>{recordedNumber(call.totalTokens)}</s-table-cell>
            <s-table-cell>
              <CostValue cost={call.cost} />
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

export function VoiceActivity({
  sessions,
}: {
  sessions: ConversationInspection["voiceSessions"];
}) {
  if (sessions.length === 0)
    return <s-paragraph>No voice sessions recorded.</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Model</s-table-header>
        <s-table-header listSlot="inline">Status</s-table-header>
        <s-table-header>Started</s-table-header>
        <s-table-header>Closed</s-table-header>
        <s-table-header format="numeric">Reported seconds</s-table-header>
        <s-table-header>Estimated cost</s-table-header>
        <s-table-header>Failure</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {sessions.map((session) => (
          <s-table-row key={session.id}>
            <s-table-cell>{session.model || "Not recorded"}</s-table-cell>
            <s-table-cell>{session.status}</s-table-cell>
            <s-table-cell>{recordedDate(session.createdAt)}</s-table-cell>
            <s-table-cell>{recordedDate(session.closedAt)}</s-table-cell>
            <s-table-cell>{recordedNumber(session.usageSeconds)}</s-table-cell>
            <s-table-cell>
              <CostValue cost={session.cost} />
            </s-table-cell>
            <s-table-cell>{session.error || "—"}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
