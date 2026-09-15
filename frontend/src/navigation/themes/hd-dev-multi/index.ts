import type { StorefrontStore } from "../../shared/types";
import { selectblindsTheme } from "../selectblinds";

export const hdDevMultiStore: StorefrontStore = {
  shop: "hd-dev-multi.myshopify.com",
  theme: selectblindsTheme,
};
