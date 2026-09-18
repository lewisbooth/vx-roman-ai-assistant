import { createContext } from "react";

/** Roman's memory navigation never owns the storefront URL. */
export const RomanViewContext = createContext<
  ((view: "chat" | "cart" | "gallery") => void) | undefined
>(undefined);
