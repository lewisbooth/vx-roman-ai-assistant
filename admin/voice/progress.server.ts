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
  const answer = (input.answer || input.customerText || "").toLowerCase();
  const context = `${input.question} ${answer}`.toLowerCase();
  // A quick measurement or fitting answer needs the verified next step, not a
  // generic spoken acknowledgement. A genuinely slow named tool can still
  // provide its own progress status.
  if (input.question && /\b(measur\w*|width|drop|height|size|units?|recess|frame|handle|bead|fit|fitting)\b/i.test(input.question))
    return;
  if (/\b(show me more|more options|browse|explore|different (?:colou?rs?|styles?|blinds?|products?)|another (?:blind|product))\b/.test(answer))
    return "More product options are being considered for the customer's current preferences; no new matches are verified yet.";
  if (/\b(measur\w*|width|drop|height|size|units?)\b/.test(context))
    return "The next step for this window's measurement is being checked against established guidance; no order dimensions are confirmed yet.";
  if (/\b(recess|frame|handle|bead|fit|fitting)\b/.test(context))
    return "The chosen blind's fit guidance is being checked for the customer's latest answer; suitability is not yet confirmed.";
  if (/\b(cart|basket|sample|checkout|order|guarantee|insur\w*)\b/.test(context))
    return "The customer's basket or order request is being checked with the store; no action is confirmed yet.";
  if (/\b(blinds?|styles?|colou?r|rooms?|privacy|light|blackout)\b/.test(context))
    return "Product options are being narrowed around the customer's latest preferences; no matches are verified yet.";
  return "The customer's latest request is being worked through; no result is confirmed yet.";
}

/** Context for an immediate Live acknowledgement of a discovery choice. */
export function voiceDiscoveryProgress(
  input: VoiceQuestionAnswerReceipt,
): string | undefined {
  if (!input.question || input.productChoice || input.customerText) return;
  const question = input.question.toLowerCase();
  if (!/\b(?:what matters most|main priority|most important)\b/.test(question))
    return;
  if (!/\b(?:blinds?|shades?|windows?|room|kitchen|bathroom|bedroom)\b/.test(question))
    return;
  return `The customer selected ${JSON.stringify(input.answer)} in response to ${JSON.stringify(input.question)}. Product discovery is beginning; no matching products have been verified yet.`;
}
