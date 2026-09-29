import { ROMAN_CART_GUIDANCE } from "./cart";
import { ROMAN_CHECKOUT_GUIDANCE } from "./checkout";
import { ROMAN_CONFIGURATION_GUIDANCE } from "./configuration";
import { ROMAN_DISCOVERY_GUIDANCE } from "./discovery";
import { ROMAN_GUIDE_GUIDANCE } from "./guides";
import { ROMAN_HANDOFF_GUIDANCE } from "./handoff";
import { ROMAN_MEASURING_GUIDANCE } from "./measuring";
import { ROMAN_REPLACEMENT_GUIDANCE } from "./replacement";
import { ROMAN_RESPONSE_GUIDANCE } from "./response";
import { ROMAN_SHOPPING_GUIDANCE } from "./shopping";
import { ROMAN_UPSELL_GUIDANCE } from "./upsell";

// Stable order is deliberate: one shared policy prefix for both advisor channels.
// No per-request classifier or keyword router changes these instructions.
export const ROMAN_KNOWLEDGE_MODULES = {
  shopping: ROMAN_SHOPPING_GUIDANCE,
  discovery: ROMAN_DISCOVERY_GUIDANCE,
  replacement: ROMAN_REPLACEMENT_GUIDANCE,
  guides: ROMAN_GUIDE_GUIDANCE,
  measuring: ROMAN_MEASURING_GUIDANCE,
  configuration: ROMAN_CONFIGURATION_GUIDANCE,
  upsell: ROMAN_UPSELL_GUIDANCE,
  cart: ROMAN_CART_GUIDANCE,
  handoff: ROMAN_HANDOFF_GUIDANCE,
  checkout: ROMAN_CHECKOUT_GUIDANCE,
  response: ROMAN_RESPONSE_GUIDANCE,
} as const;

export const ROMAN_KNOWLEDGE_BASE = Object.values(ROMAN_KNOWLEDGE_MODULES).join(
  "\n\n",
);
