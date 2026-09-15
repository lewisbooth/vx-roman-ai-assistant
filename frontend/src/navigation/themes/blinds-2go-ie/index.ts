import { prepareCartContinue } from "../../shared/cart";
import type { StorefrontTheme } from "../../shared/types";

export const blinds2goIeTheme: StorefrontTheme = {
  id: "blinds-2go-ie",
  prepare(source, url) {
    prepareCartContinue(source, url, "back");
    return {};
  },
};
