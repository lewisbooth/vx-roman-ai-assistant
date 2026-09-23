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
