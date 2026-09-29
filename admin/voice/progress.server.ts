import type { VoiceQuestionAnswerReceipt } from "../conversations/repository.server";

/** Task status for Live to express naturally, never a line for Roman to recite. */
export function voiceToolProgress(name: string): string | undefined {
  switch (name) {
    case "search_products":
    case "lookup_catalog":
      return "The current store range is being searched for the customer's latest requirements; matches are not yet verified.";
    case "get_product":
      return "The chosen blind's current details are being checked; suitability is not yet verified.";
    case "get_product_guides":
    case "discover_guides":
    case "read_library_guides":
      return "The relevant guide is being checked for this customer's measuring or fitting step; no new instruction is verified yet.";
    case "get_product_configuration":
    case "configure_product":
    case "apply_measurements":
    case "set_measurements":
      return "The chosen blind's current options and quote are being checked; no change or price is confirmed yet.";
    case "get_cart":
      return "The store basket is being read; its contents are not yet confirmed.";
    case "add_to_cart":
    case "add_sample_to_cart":
    case "remove_from_cart":
    case "set_cart_quantity":
    case "clear_cart":
      return "The requested basket change is being checked with the store; success is not yet confirmed.";
    case "navigate":
      return "The selected blind's current page is being prepared; it is not yet confirmed.";
    case "get_store_support":
      return "The store's current contact details are being checked.";
    case "open_checkout":
      return "Checkout is being prepared; it has not opened yet.";
    default:
      return undefined;
  }
}

/** Unverified task status while a clicked or typed request is being reasoned through. */
export function voiceInputProgress(
  input: VoiceQuestionAnswerReceipt,
): string | undefined {
  if (input.productChoice) return "The chosen blind's details are being checked; its selection is not yet confirmed.";
  // A quick measurement or fitting answer needs the verified next step, not a
  // generic spoken acknowledgement. A genuinely slow named tool can still
  // provide its own progress status.
  if (input.measurement) return;
  return `Pending customer request; no research or action result is confirmed yet. ${JSON.stringify({ question: input.question || undefined, answer: input.answer || input.customerText })}`;
}

/** A clicked choice is explicit input; Live interprets its context without a keyword router. */
export function voiceAnswerProgress(
  input: VoiceQuestionAnswerReceipt,
): string | undefined {
  if (!input.question || input.productChoice || input.customerText || input.measurement) return;
  return voiceInputProgress(input);
}
