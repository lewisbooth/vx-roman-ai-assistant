import {
  getStoreCart,
  summarizeCart,
  validateStoreCart,
  type CartSnapshot,
  type StoreCart,
} from "./cart";

type CartActionResult = {
  status: "updated" | "needs_cart_page" | "handed_off";
  cart?: CartSnapshot;
  message: string;
};
type CartElement = HTMLElement & {
  cart?: unknown;
  shopifyCartLoading?: boolean;
  key?: string;
  lineItemKey?: string;
  min?: number;
  max?: number;
  clearCart?: () => Promise<unknown>;
};
type Action =
  | { kind: "remove"; lineKey: string }
  | { kind: "quantity"; lineKey: string; quantity: number }
  | { kind: "clear" };

let actionPending = false;

const needsCartPage: CartActionResult = {
  status: "needs_cart_page",
  message:
    "Open Cart and wait for its controls to load, then run this action again. The current page has no ready, matching theme cart control.",
};
const handedOff: CartActionResult = {
  status: "handed_off",
  message:
    "The request was handed to the storefront, but completion was not confirmed. It may still complete; check the cart before trying again. Stopping Roman cannot undo it.",
};

function registered(element: Element): element is CartElement {
  const definition = customElements.get(element.localName);
  return !!definition && element instanceof definition && element.isConnected;
}

function matchingCart(value: unknown, current: StoreCart): boolean {
  try {
    const cart = validateStoreCart(value);
    return (
      cart.items.length === current.items.length &&
      cart.items.every((item) =>
        current.items.some(
          (entry) => entry.key === item.key && entry.quantity === item.quantity,
        ),
      )
    );
  } catch {
    return false;
  }
}

function observeAction(
  owner: CartElement,
  action: Action,
  signal: AbortSignal,
  submit: () => unknown,
): Promise<CartActionResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onLeave);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("roman:navigation", onLeave);
      owner.removeEventListener("cart:updated", onUpdated);
      owner.removeEventListener("cart:error", onError);
    };
    const finish = (result: CartActionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onLeave = () => finish(handedOff);
    const onError = (event?: Event) => {
      if (settled || (event && event.target !== owner)) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "The storefront could not confirm the cart change. Check its message and cart before trying again.",
        ),
      );
    };
    const onUpdated = (event: Event) => {
      if (settled || event.target !== owner || !owner.isConnected) return;
      let cart: StoreCart;
      try {
        cart = validateStoreCart((event as CustomEvent<unknown>).detail);
      } catch {
        return;
      }
      const confirmed =
        action.kind === "clear"
          ? cart.items.length === 0 && cart.item_count === 0
          : action.kind === "remove"
            ? !cart.items.some((item) => item.key === action.lineKey)
            : cart.items.some(
                (item) =>
                  item.key === action.lineKey &&
                  item.quantity === action.quantity,
              );
      if (confirmed)
        finish({
          status: "updated",
          cart: summarizeCart(cart),
          message: "The storefront confirmed the cart change.",
        });
    };
    const timer = window.setTimeout(onLeave, 15000);
    signal.addEventListener("abort", onLeave, { once: true });
    window.addEventListener("pagehide", onLeave, { once: true });
    document.addEventListener("roman:navigation", onLeave, { once: true });
    owner.addEventListener("cart:updated", onUpdated);
    owner.addEventListener("cart:error", onError);
    try {
      // Theme mutation methods may outlive Roman's observation. Always consume
      // their rejection, including after cancellation; never retry a mutation.
      Promise.resolve(submit()).catch(() => onError());
    } catch {
      onError();
    }
  });
}

async function runAction(
  action: Action,
  signal: AbortSignal,
): Promise<CartActionResult> {
  signal.throwIfAborted();
  if (
    action.kind !== "clear" &&
    (!action.lineKey.trim() || action.lineKey.length > 500)
  )
    throw new Error("Provide a current lineKey from get_cart.");
  if (
    action.kind === "quantity" &&
    (!Number.isSafeInteger(action.quantity) || action.quantity < 1)
  )
    throw new Error(
      "Provide a positive whole-number quantity. Use remove_from_cart to remove an item.",
    );
  if (actionPending) throw new Error("Another cart action is still running.");
  actionPending = true;
  const initialUrl = window.location.href;
  try {
    let leftPage = false;
    const onLeave = () => {
      leftPage = true;
    };
    document.addEventListener("roman:navigation", onLeave, { once: true });
    window.addEventListener("pagehide", onLeave, { once: true });
    let cart: StoreCart;
    try {
      cart = await getStoreCart(signal);
    } finally {
      document.removeEventListener("roman:navigation", onLeave);
      window.removeEventListener("pagehide", onLeave);
    }
    signal.throwIfAborted();
    if (leftPage || window.location.href !== initialUrl) return needsCartPage;
    if (action.kind !== "clear") {
      const item = cart.items.find((entry) => entry.key === action.lineKey);
      if (!item)
        throw new Error(
          "That cart line no longer exists. Read get_cart for its current lineKey.",
        );
      if (action.kind === "quantity" && item.quantity === action.quantity)
        return {
          status: "updated",
          cart: summarizeCart(cart),
          message:
            "The cart line already has that quantity; no change was made.",
        };
    } else if (cart.items.length === 0 && cart.item_count === 0) {
      return {
        status: "updated",
        cart: summarizeCart(cart),
        message: "The cart is already empty; no change was made.",
      };
    }

    const providers = document.querySelectorAll("app-provider");
    if (providers.length !== 1 || !registered(providers[0]))
      return needsCartPage;
    const provider = providers[0];
    const selector =
      action.kind === "clear"
        ? "cart-sections"
        : action.kind === "remove"
          ? "cart-remove-toggle"
          : "quantity-input";
    const candidates = Array.from(provider.querySelectorAll(selector)).filter(
      (element): element is CartElement =>
        registered(element) &&
        (action.kind === "clear"
          ? typeof element.clearCart === "function"
          : element.getAttribute("key") === action.lineKey &&
            (action.kind === "remove"
              ? element.key === action.lineKey
              : element.lineItemKey === action.lineKey)),
    );
    // Cart page and drawer can both have controls. Both use the same context;
    // prefer the page's control when present and invoke only one owner.
    const owner =
      candidates.find((element) => element.closest("main#main")) ??
      candidates[0];
    if (
      !owner ||
      owner.closest('[inert], [aria-disabled="true"]') ||
      !matchingCart(owner.cart, cart)
    )
      return needsCartPage;
    if (owner.shopifyCartLoading || owner.classList.contains("loading"))
      throw new Error(
        "Wait for the storefront's current cart update to finish.",
      );

    if (action.kind === "clear")
      return await observeAction(owner, action, signal, () =>
        owner.clearCart!(),
      );

    if (action.kind === "remove") {
      const controls = owner.querySelectorAll<
        HTMLButtonElement | HTMLAnchorElement
      >("button, a[href]");
      if (
        controls.length !== 1 ||
        controls[0].matches(':disabled, [aria-disabled="true"]') ||
        controls[0].closest("[inert]")
      )
        return needsCartPage;
      const control = controls[0];
      const slottedChild = Array.from(owner.children).find((child) =>
        child.contains(control),
      );
      if (!slottedChild?.assignedSlot) return needsCartPage;
      return await observeAction(owner, action, signal, () => {
        // The theme handles its slot's click. Block the native link/form default
        // even if that handler stops working; Roman must not submit a raw form.
        const preventNative = (event: Event) => event.preventDefault();
        control.addEventListener("click", preventNative);
        try {
          control.click();
        } finally {
          control.removeEventListener("click", preventNative);
        }
      });
    }

    const inputs = owner.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    );
    if (
      inputs.length !== 1 ||
      inputs[0].matches(":disabled") ||
      inputs[0].readOnly ||
      inputs[0].closest('[inert], [aria-disabled="true"]')
    )
      return needsCartPage;
    const input = inputs[0];
    const validationInput = input.cloneNode() as HTMLInputElement;
    validationInput.value = String(action.quantity);
    if (
      !validationInput.checkValidity() ||
      (typeof owner.min === "number" && action.quantity < owner.min) ||
      (typeof owner.max === "number" && action.quantity > owner.max)
    )
      throw new Error(
        "That quantity is outside this cart line's allowed range.",
      );
    return await observeAction(owner, action, signal, () => {
      // quantity-input owns debouncing, bounds, pricing and grouped accessories.
      input.value = String(action.quantity);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } finally {
    actionPending = false;
  }
}

export function removeFromCart(lineKey: string, signal: AbortSignal) {
  return runAction({ kind: "remove", lineKey }, signal);
}

export function setCartQuantity(
  lineKey: string,
  quantity: number,
  signal: AbortSignal,
) {
  return runAction({ kind: "quantity", lineKey, quantity }, signal);
}

export function clearCart(signal: AbortSignal) {
  return runAction({ kind: "clear" }, signal);
}
