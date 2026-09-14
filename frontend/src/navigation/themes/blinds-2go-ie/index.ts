import { prepareCartContinue } from "../../shared/cart";
import type { StorefrontTheme } from "../../shared/types";

export const blinds2goIeTheme: StorefrontTheme = {
  id: "blinds-2go-ie",
  prepare(source, url) {
    prepareCartContinue(source, url, "back");
    return {};
  },
};

export const blinds2goIeDestinations = [
  { label: "Roller blinds", path: "/collections/roller-blinds" },
  {
    label: "Sevilla blackout grey roller blind",
    path: "/products/sevilla-blackout-grey-roller-blind",
  },
] as const;
