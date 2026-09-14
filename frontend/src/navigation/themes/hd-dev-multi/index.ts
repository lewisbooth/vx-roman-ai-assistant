import type { StorefrontStore } from "../../shared/types";
import { selectblindsTheme } from "../selectblinds";

export const hdDevMultiStore: StorefrontStore = {
  shop: "hd-dev-multi.myshopify.com",
  theme: selectblindsTheme,
  destinations: [
    { label: "All blinds", path: "/collections/all" },
    {
      label: "Traditional zebra shades",
      path: "/products/traditional-room-darkening-zebra-shades",
    },
    {
      label: "LEVOLOR faux wood blinds",
      path: "/products/2-inch-levolor-classic-neutral-faux-wood-blinds",
    },
  ],
};
