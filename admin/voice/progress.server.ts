import type { VoiceQuestionAnswerReceipt } from "../conversations/repository.server";

/** A short, factual progress cue for work that has actually started. */
export function voiceToolProgress(name: string): string | undefined {
  switch (name) {
    case "search_products":
    case "lookup_catalog":
      return "I'm checking the current range against what you've told me.";
    case "get_product":
      return "I'm checking the details of that blind.";
    case "get_product_guides":
    case "discover_guides":
    case "read_library_guides":
      return "I'm pulling up the relevant guide.";
    case "get_product_configuration":
    case "configure_product":
    case "apply_measurements":
    case "set_measurements":
      return "I'm checking this blind's options and current quote.";
    case "get_cart":
      return "I'm checking what's in your basket.";
    case "add_to_cart":
    case "add_sample_to_cart":
    case "remove_from_cart":
    case "set_cart_quantity":
    case "clear_cart":
      return "I'm checking that basket change with the store.";
    case "navigate":
      return "I'm checking that page now.";
    case "get_store_support":
      return "I'm checking the store's contact details.";
    case "open_checkout":
      return "I'm getting checkout ready.";
    default:
      return undefined;
  }
}

/** A truthful cue while a clicked or typed request is still being reasoned through. */
export function voiceInputProgress(
  input: VoiceQuestionAnswerReceipt,
): string {
  if (input.productChoice) return "I'm checking that blind's details.";
  const answer = (input.answer || input.customerText || "").toLowerCase();
  const context = `${input.question} ${answer}`.toLowerCase();
  if (/\b(show me more|more options|browse|explore|different (?:colou?rs?|styles?|blinds?|products?)|another (?:blind|product))\b/.test(answer))
    return "I'm finding a few more options for you.";
  if (/\b(measur\w*|width|drop|height|size|units?)\b/.test(context))
    return "I'm checking the next measuring step.";
  if (/\b(recess|frame|handle|bead|fit|fitting)\b/.test(context))
    return "I'm checking the fit guidance for that.";
  if (/\b(cart|basket|sample|checkout|order|guarantee|insur\w*)\b/.test(context))
    return "I'm checking that with the store.";
  if (/\b(blinds?|styles?|colou?r|rooms?|privacy|light|blackout)\b/.test(context))
    return "I'm narrowing the options around that.";
  return "I'm checking the next step for you.";
}
