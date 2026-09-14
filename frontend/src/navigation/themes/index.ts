import type { StorefrontStore } from "../shared/types";
import { blinds2goIeDestinations, blinds2goIeTheme } from "./blinds-2go-ie";
import { blinds2goUkDestinations, blinds2goUkTheme } from "./blinds-2go-uk";
import { hdDevMultiStore } from "./hd-dev-multi";
import { hdDevSingleStore } from "./hd-dev-single";
import { selectblindsTheme } from "./selectblinds";
import { selectblindsDestinations } from "./selectblinds/destinations";

const stores: readonly StorefrontStore[] = [
  hdDevMultiStore,
  hdDevSingleStore,
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
].map((store) => ({
  ...store,
  destinations: [
    { label: "Home", path: "/" },
    ...store.destinations,
    { label: "Cart", path: "/cart" },
  ],
}));

export function selectStore(
  shop: string | undefined,
): StorefrontStore | undefined {
  return stores.find((store) => store.shop === shop);
}
