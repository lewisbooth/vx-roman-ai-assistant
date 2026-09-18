import type { getVoiceWorkActivity } from "../conversations/runner.server";

/** Customer-facing progress from actual work, never guessed from message words. */
export function voiceAcknowledgement(
  activity: ReturnType<typeof getVoiceWorkActivity>,
  productChoice: boolean,
  previous?: string,
): string {
  const tool = activity?.tool;
  const guideKinds = tool ? undefined : activity?.readingGuides;
  let choices: readonly string[];
  if (guideKinds?.length) {
    const guide =
      guideKinds?.length === 1
        ? `the ${guideKinds[0]} guide`
        : "the measuring and fitting guidance";
    choices = [`I'm checking ${guide}.`, `Let me read through ${guide}.`];
  } else if (tool === "get_product_guides" || tool === "discover_guides") {
    choices = [
      "I'm finding the product guidance.",
      "Let me pull up the product guidance.",
    ];
  } else if (tool === "search_products") {
    choices = [
      "I'm looking through the options.",
      "Let me check some options.",
    ];
  } else if (
    productChoice ||
    ["get_product", "lookup_catalog", "get_product_configuration"].includes(
      tool ?? "",
    )
  ) {
    choices = [
      "Let's take a closer look at that blind.",
      "Let me look into that blind for you.",
    ];
  } else if (tool === "get_cart") {
    choices = ["I'm checking your cart.", "Let me take a look at your cart."];
  } else {
    // Mutations may still need review or fail; never announce them as completed.
    choices = [
      "Let me take a look.",
      "I'll check that for you.",
      "One moment while I look into that.",
      "Thanks, let me check.",
    ];
  }
  return choices[(choices.indexOf(previous ?? "") + 1) % choices.length];
}
