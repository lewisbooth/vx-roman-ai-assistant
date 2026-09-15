import type { StorefrontStore } from "../shared/types";
import { blinds2goIeTheme } from "./blinds-2go-ie";
import { blinds2goUkTheme } from "./blinds-2go-uk";
import { hdDevMultiStore } from "./hd-dev-multi";
import { hdDevSingleStore } from "./hd-dev-single";
import { selectblindsTheme } from "./selectblinds";

const stores: readonly StorefrontStore[] = [
  hdDevMultiStore,
  hdDevSingleStore,
  {
    shop: "select-blinds-us.myshopify.com",
    theme: selectblindsTheme,
  },
  {
    shop: "blinds-2go.myshopify.com",
    theme: blinds2goUkTheme,
  },
  {
    shop: "blinds2go-ireland.myshopify.com",
    theme: blinds2goIeTheme,
  },
];

export function selectStore(
  shop: string | undefined,
): StorefrontStore | undefined {
  return stores.find((store) => store.shop === shop);
}
