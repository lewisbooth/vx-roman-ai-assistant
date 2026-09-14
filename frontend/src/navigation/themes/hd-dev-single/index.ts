import type { StorefrontStore } from "../../shared/types";
import { blinds2goUkTheme } from "../blinds-2go-uk";

export const hdDevSingleStore: StorefrontStore = {
  shop: "hd-dev-single.myshopify.com",
  theme: blinds2goUkTheme,
  destinations: [
    { label: "Blackout blinds", path: "/collections/blackout-blinds" },
    { label: "All blinds", path: "/collections/all" },
    {
      label: "Lottie Mojito Roman blind",
      path: "/products/lottie-mojito-roman-blind",
    },
    {
      label: "Bifold ClickFIT DuoShade Obsidian pleated blind",
      path: "/products/bifold-clickfit-duoshade-obsidian-pleated-blind",
    },
  ],
};
