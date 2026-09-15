import { prepareCartContinue } from "../../shared/cart";
import type { StorefrontTheme } from "../../shared/types";
import { takeWalletModules } from "../../shared/wallets";

export const blinds2goUkTheme: StorefrontTheme = {
  id: "blinds-2go-uk",
  prepare(source, url) {
    prepareCartContinue(source, url, "back-or-home");
    return { modules: takeWalletModules(source, url) };
  },
};
