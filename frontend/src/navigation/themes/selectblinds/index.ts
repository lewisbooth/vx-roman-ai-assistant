import { prepareCartContinue } from "../../shared/cart";
import type { StorefrontTheme } from "../../shared/types";
import { takeWalletModules } from "../../shared/wallets";
import { loadPayPalSdk, preservePayPalSdk, readPayPalScript } from "./paypal";

export const selectblindsTheme: StorefrontTheme = {
  id: "selectblinds",
  prepare(source, url) {
    prepareCartContinue(source, url, "back-or-home");
    const modules = takeWalletModules(source, url);
    let paypal: URL | null = null;
    for (const script of source.querySelectorAll("main#main script")) {
      const sdk = readPayPalScript(script, url);
      if (!sdk) continue;
      if (paypal) {
        throw new Error(
          "This page includes multiple PayPal SDK scripts. Open it with normal navigation.",
        );
      }
      paypal = sdk;
      script.remove();
    }
    return { modules, load: (signal) => loadPayPalSdk(paypal, signal) };
  },
  preserve: preservePayPalSdk,
};
