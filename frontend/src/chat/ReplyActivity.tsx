import { useLayoutEffect } from "react";
import type { BrowserToolName } from "../../../shared/conversation";
import type { ConversationClientState } from "../session/types";

const toolLabels: Record<BrowserToolName, string> = {
  open_checkout: "Opening checkout?",
  show_view: "Opening your Roman view…",
  search_products: "Finding suitable products…",
  get_product: "Checking product details…",
  lookup_catalog: "Checking product details…",
  get_product_guides: "Finding measuring and fitting guides…",
  discover_guides: "Finding the store's measuring guidance…",
  get_store_support: "Finding the store's contact details…",
  navigate: "Opening the page…",
  get_cart: "Checking your cart…",
  add_to_cart: "Adding to your cart…",
  add_sample_to_cart: "Adding your sample to the cart…",
  get_product_configuration: "Checking the product choices…",
  configure_product: "Updating the product choice…",
  remove_from_cart: "Updating your cart…",
  set_cart_quantity: "Updating your cart…",
  clear_cart: "Updating your cart…",
  apply_measurements: "Entering your measurements…",
};

function activityLabel(state: ConversationClientState, ending: boolean) {
  const conversation = state.conversation;
  if (
    ending ||
    state.restoring ||
    state.error ||
    state.approval ||
    state.voice.status === "starting" ||
    state.voice.status === "stopping" ||
    conversation?.status === "ended"
  )
    return null;

  const tools = conversation?.tools ?? [];
  const tool = tools.find((item) => item.status === "running") ?? tools[0];
  const pending = conversation?.messages.filter(
    (message) => message.role === "assistant" && message.status === "pending",
  );
  if (!state.pending && !conversation?.busy && !tool && !pending?.length)
    return null;

  const writing = pending?.some((message) =>
    message.parts.some((part) => part.type === "text" && part.text.trim()),
  );
  const reading = conversation?.busy ? conversation.readingGuides : undefined;
  return tool
    ? toolLabels[tool.name]
    : reading?.length
      ? reading.length === 2
        ? "Roman is reading the measuring and fitting guides…"
        : `Roman is reading the ${reading[0]} guide…`
      : writing
        ? "Roman is replying…"
        : "Roman is thinking…";
}

/** Transient feedback for actual work; an open voice connection can be idle. */
export function ReplyActivity({
  state,
  ending,
  onContentChange,
}: {
  state: ConversationClientState;
  ending: boolean;
  onContentChange: () => void;
}) {
  const label = activityLabel(state, ending);
  useLayoutEffect(onContentChange, [label, onContentChange]);
  if (!label) return null;

  return (
    <p className="roman-reply-activity" role="status" aria-atomic="true">
      <span>{label}</span>
    </p>
  );
}
