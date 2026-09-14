import type { StorefrontStore } from "../shared/types";
import { blinds2goIeDestinations, blinds2goIeTheme } from "./blinds-2go-ie";
import { blinds2goUkDestinations, blinds2goUkTheme } from "./blinds-2go-uk";
import { selectblindsTheme } from "./selectblinds";
import {
  devDestinations,
  selectblindsDestinations,
} from "./selectblinds/destinations";

export const previewStore: StorefrontStore = {
  shop: "hd-dev-multi.myshopify.com",
  destinations: devDestinations,
  theme: selectblindsTheme,
};

const stores: readonly StorefrontStore[] = [
  previewStore,
  {
    shop: "select-blinds-us.myshopify.com",
    destinations: selectblindsDestinations,
    theme: selectblindsTheme,
  },
  {
    shop: "blinds-2go.myshopify.com",
    destinations: blinds2goUkDestinations,
    theme: blinds2goUkTheme,
  },
  {
    shop: "blinds2go-ireland.myshopify.com",
    destinations: blinds2goIeDestinations,
    theme: blinds2goIeTheme,
  },
];

export function selectStore(
  shop: string | undefined,
): StorefrontStore | undefined {
  return stores.find((store) => store.shop === shop);
}
