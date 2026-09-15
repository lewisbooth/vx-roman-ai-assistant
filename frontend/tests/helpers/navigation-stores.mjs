// Representative routes for exercising theme navigation. Production profiles
// select hooks by shop identity and do not prescribe a storefront's routes.
export const productOne = "/products/traditional-room-darkening-zebra-shades";
export const productTwo =
  "/products/2-inch-levolor-classic-neutral-faux-wood-blinds";

export const storeFixtures = {
  devMulti: {
    shop: "hd-dev-multi.myshopify.com",
    origin: "https://hd-dev-multi.myshopify.com",
    routes: ["/", "/collections/all", productOne, productTwo, "/cart"],
  },
  devSingle: {
    shop: "hd-dev-single.myshopify.com",
    origin: "https://hd-dev-single.myshopify.com",
    routes: [
      "/",
      "/collections/blackout-blinds",
      "/collections/all",
      "/products/lottie-mojito-roman-blind",
      "/products/bifold-clickfit-duoshade-obsidian-pleated-blind",
      "/cart",
    ],
  },
  selectBlinds: {
    shop: "select-blinds-us.myshopify.com",
    origin: "https://www.selectblinds.com",
    routes: [
      "/",
      "/collections/all",
      "/products/classic-roman-shades",
      "/cart",
    ],
  },
  blinds2goUk: {
    shop: "blinds-2go.myshopify.com",
    origin: "https://shop.blinds-2go.co.uk",
    routes: [
      "/",
      "/collections/wooden-blinds",
      "/products/sevilla-blackout-grey-roller-blind",
      "/cart",
    ],
  },
  blinds2goIe: {
    shop: "blinds2go-ireland.myshopify.com",
    origin: "https://www.blinds-2go.ie",
    routes: [
      "/",
      "/collections/roller-blinds",
      "/products/sevilla-blackout-grey-roller-blind",
      "/cart",
    ],
  },
};
