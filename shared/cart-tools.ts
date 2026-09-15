import { parseNavigationCall } from "./navigation-tool";

export type CartToolName =
  | "get_cart"
  | "add_to_cart"
  | "remove_from_cart"
  | "set_cart_quantity"
  | "clear_cart";
export interface CartSnapshot {
  currency: string;
  itemCount: number;
  totalPriceMinorUnits: number;
  items: {
    lineKey: string;
    title: string;
    variantId: number;
    quantity: number;
    linePriceMinorUnits: number;
  }[];
}
export interface CartActionResult {
  status:
    | "added"
    | "updated"
    | "needs_configuration"
    | "needs_cart_page"
    | "handed_off"
    | "cancelled"
    | "uncertain";
  message: string;
  quantityAdded?: number;
  cart?: CartSnapshot;
}
export type CartToolResult = CartSnapshot | CartActionResult;

const names: readonly CartToolName[] = [
  "get_cart",
  "add_to_cart",
  "remove_from_cart",
  "set_cart_quantity",
  "clear_cart",
];
const lineKeyPattern = /^[A-Za-z0-9:_-]{1,256}$/;
const lineKeySchema = { type: "string", pattern: lineKeyPattern.source };
const definitions = [
  [
    "get_cart",
    "Read this shopper's current cart, including exact line keys and quantities. Refresh before choosing a line to remove or change; historical cart contents may be stale.",
    {},
  ],
  [
    "add_to_cart",
    "Request shopper review and confirmation to add the configured product currently open on its verified productPath. The theme owns measurements, options and validation. Do not infer configuration from a draft, catalog price or page visit. This does not purchase or check out.",
    { productPath: { type: "string", minLength: 1, maxLength: 2048 } },
  ],
  [
    "remove_from_cart",
    "Request shopper confirmation to remove the exact current cart lineKey returned by get_cart. Theme rules may also remove linked items. Never infer a line key from a variant ID.",
    { lineKey: lineKeySchema },
  ],
  [
    "set_cart_quantity",
    "Request shopper confirmation to set an exact current cart lineKey to a positive whole-number quantity. Use remove_from_cart for removal. The theme owns linked items and allowed quantity ranges.",
    {
      lineKey: lineKeySchema,
      quantity: { type: "integer", minimum: 1, maximum: 999 },
    },
  ],
  [
    "clear_cart",
    "Request explicit shopper confirmation to empty the entire current cart through the theme, including linked items. Use only when the shopper asks to clear the whole cart.",
    {},
  ],
] as const;

export const cartToolDefinitions = definitions.map(
  ([name, description, properties]) => ({
    type: "function" as const,
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  }),
);

export function isCartTool(name: string): name is CartToolName {
  return names.includes(name as CartToolName);
}
export function requiresCartConfirmation(name: string): boolean {
  return isCartTool(name) && name !== "get_cart";
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Cart data must be an object.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new Error("Unexpected cart fields.");
}
function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function parseCartCall(
  name: string,
  input: unknown,
): { name: CartToolName; arguments: Record<string, unknown> } {
  if (!isCartTool(name)) throw new Error("This cart tool is not supported.");
  const args = object(input);
  if (name === "get_cart" || name === "clear_cart") {
    exact(args, []);
    return { name, arguments: {} };
  }
  if (name === "add_to_cart") {
    exact(args, ["productPath"]);
    const { path } = parseNavigationCall({ path: args.productPath });
    if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/[^/?#]+\/?$/i.test(path))
      throw new Error(
        "Adding requires the verified current product page path without query or hash.",
      );
    return { name, arguments: { productPath: path.replace(/\/$/, "") } };
  }
  exact(
    args,
    name === "set_cart_quantity" ? ["lineKey", "quantity"] : ["lineKey"],
  );
  if (typeof args.lineKey !== "string" || !lineKeyPattern.test(args.lineKey))
    throw new Error("Use a current cart lineKey.");
  if (name === "set_cart_quantity" && !integer(args.quantity, 1, 999))
    throw new Error("Cart quantity must be a positive whole number up to 999.");
  return {
    name,
    arguments: {
      lineKey: args.lineKey,
      ...(name === "set_cart_quantity" ? { quantity: args.quantity } : {}),
    },
  };
}

function parseCartSnapshot(input: unknown): CartSnapshot {
  const value = object(input);
  exact(value, ["currency", "itemCount", "totalPriceMinorUnits", "items"]);
  if (
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !integer(value.itemCount, 0, 999_999) ||
    !integer(value.totalPriceMinorUnits) ||
    !Array.isArray(value.items) ||
    value.items.length > 100
  )
    throw new Error("Invalid cart summary.");
  const keys = new Set<string>();
  const items = value.items.map((input) => {
    const item = object(input);
    exact(item, [
      "lineKey",
      "title",
      "variantId",
      "quantity",
      "linePriceMinorUnits",
    ]);
    if (
      typeof item.lineKey !== "string" ||
      !lineKeyPattern.test(item.lineKey) ||
      keys.has(item.lineKey) ||
      !text(item.title, 300) ||
      !integer(item.variantId, 1) ||
      !integer(item.quantity, 0, 999_999) ||
      !integer(item.linePriceMinorUnits)
    )
      throw new Error("Invalid cart line.");
    keys.add(item.lineKey);
    return {
      lineKey: item.lineKey,
      title: item.title,
      variantId: item.variantId,
      quantity: item.quantity,
      linePriceMinorUnits: item.linePriceMinorUnits,
    };
  });
  if (
    items.reduce((total, item) => total + item.quantity, 0) !== value.itemCount
  )
    throw new Error("Cart item count does not match its lines.");
  return {
    currency: value.currency,
    itemCount: value.itemCount,
    totalPriceMinorUnits: value.totalPriceMinorUnits,
    items,
  };
}

/** Accept only the public theme summary, never cart tokens, notes or attributes. */
export function parseCartResult(
  name: CartToolName,
  input: unknown,
): CartToolResult {
  if (name === "get_cart") return parseCartSnapshot(input);
  const value = object(input);
  const states =
    name === "add_to_cart"
      ? ["added", "needs_configuration", "handed_off"]
      : ["updated", "needs_cart_page", "handed_off"];
  if (
    !states.concat("cancelled", "uncertain").includes(String(value.status)) ||
    !text(value.message, 500)
  )
    throw new Error("Invalid cart action outcome.");
  const keys = [
    "status",
    "message",
    ...(value.quantityAdded !== undefined ? ["quantityAdded"] : []),
    ...(value.cart !== undefined ? ["cart"] : []),
  ];
  exact(value, keys);
  if (
    value.quantityAdded !== undefined &&
    (value.status !== "added" || !integer(value.quantityAdded, 1, 999))
  )
    throw new Error("Invalid added quantity.");
  if (value.cart !== undefined && value.status !== "updated")
    throw new Error("Only confirmed updates can include a resulting cart.");
  if (value.status === "updated" && value.cart === undefined)
    throw new Error("A confirmed update needs the resulting cart.");
  return {
    status: value.status as CartActionResult["status"],
    message: value.message,
    ...(value.quantityAdded !== undefined
      ? { quantityAdded: Number(value.quantityAdded) }
      : {}),
    ...(value.cart !== undefined
      ? { cart: parseCartSnapshot(value.cart) }
      : {}),
  };
}

export function interruptedCartResult(claimed: boolean): CartActionResult {
  return claimed
    ? {
        status: "uncertain",
        message:
          "The cart action may have completed, but its result was not confirmed. Check the cart before requesting another change; do not repeat this action automatically.",
      }
    : {
        status: "cancelled",
        message:
          "This cart change was not confirmed by the shopper and was not executed.",
      };
}
