import {
  getStoreCart,
  summarizeCart,
  validateStoreCart,
  type StoreCart,
} from "./cart";
import { parseCartCall, type CartSnapshot } from "../../../shared/cart-tools";

export type CartActionResult = {
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
  removeItemFromCart?: (lineKeys: string[]) => Promise<unknown>;
  updateQuantityToCart?: (updates: Record<string, number>) => Promise<unknown>;
};
type Action =
  | { kind: "remove"; lineKey: string }
  | { kind: "quantity"; lineKey: string; quantity: number }
  | { kind: "clear" };

let actionPending = false;

const needsCartPage: CartActionResult = {
  status: "needs_cart_page",
  message:
    "The storefront has no ready, matching cart control. No cart change was submitted; Roman's Cart view does not load those background controls.",
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

type NativeLineIdentity = {
  productType: string;
  variantId: number;
  properties: string;
  sellingPlanId: string | null;
};

function nativeLineIdentity(item: StoreCart["items"][number]): NativeLineIdentity | undefined {
  if (!["Product", "Insurance", "Warranty"].includes(String(item.product_type)) ||
    (item.product_type === "Product" && item.parent_relationship != null))
    return;
  const properties = item.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    return;
  const entries = Object.entries(properties);
  if (
    !entries.length ||
    entries.some(([, value]) =>
      value !== null && !["string", "number", "boolean"].includes(typeof value),
    )
  )
    return;
  const allocation = item.selling_plan_allocation;
  let sellingPlanId: string | null = null;
  if (allocation != null) {
    if (typeof allocation !== "object" || Array.isArray(allocation)) return;
    const plan = (allocation as Record<string, unknown>).selling_plan;
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) return;
    const id = (plan as Record<string, unknown>).id;
    if (typeof id !== "string" && typeof id !== "number") return;
    sellingPlanId = String(id);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    productType: item.product_type as string,
    variantId: item.variant_id,
    properties: JSON.stringify(entries),
    sellingPlanId,
  };
}

function sameNativeLine(left: NativeLineIdentity | undefined, right: NativeLineIdentity): boolean {
  return !!left &&
    left.productType === right.productType &&
    left.variantId === right.variantId &&
    left.properties === right.properties &&
    left.sellingPlanId === right.sellingPlanId;
}

type LinkedQuantityTarget = { key: string; identity: NativeLineIdentity };
type RemovalPlan = {
  removed: { key: string; identity: NativeLineIdentity }[];
  retained: {
    key: string;
    quantity: number;
    identity: NativeLineIdentity | undefined;
    parentKey: string | undefined;
  }[];
};

function parentKey(item: StoreCart["items"][number]): string | undefined {
  const relationship = item.parent_relationship;
  if (!relationship || typeof relationship !== "object" || Array.isArray(relationship))
    return;
  const key = (relationship as Record<string, unknown>).parent_key;
  return typeof key === "string" ? key : undefined;
}

function propertiesOf(item: StoreCart["items"][number]): Record<string, unknown> | undefined {
  const properties = item.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : undefined;
}

function sharedNonemptyProperty(
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
  name: string,
): boolean {
  const value = parent[name];
  return typeof value === "string" && !!value.trim() && child[name] === value;
}

function verifiedChildRole(parent: StoreCart["items"][number], child: StoreCart["items"][number]): boolean {
  const parentProperties = propertiesOf(parent);
  const childProperties = propertiesOf(child);
  if (!parentProperties || !childProperties) return false;
  const associated = childProperties._associated_product_id;
  if (associated !== parent.variant_id && associated !== String(parent.variant_id)) return false;
  if (!sharedNonemptyProperty(parentProperties, childProperties, "_group_id")) return false;
  return (child.product_type === "Insurance" &&
      childProperties._insurance_type === "product" &&
      sharedNonemptyProperty(parentProperties, childProperties, "_insurance_group")) ||
    (child.product_type === "Warranty" &&
      sharedNonemptyProperty(parentProperties, childProperties, "_warranty_group"));
}

function linkedQuantityTargets(cart: StoreCart, parent: StoreCart["items"][number]): LinkedQuantityTarget[] {
  const children = cart.items.filter((item) => parentKey(item) === parent.key);
  if (!children.length) return [];
  const parentProperties = propertiesOf(parent);
  const parentIdentity = nativeLineIdentity(parent);
  if (
    parent.product_type !== "Product" || parent.parent_relationship != null ||
    !parentProperties || !parentIdentity ||
    cart.items.filter((item) => sameNativeLine(nativeLineIdentity(item), parentIdentity)).length !== 1
  )
    throw new Error("This blind's linked cart lines cannot be verified. No cart change was submitted.");
  return children.map((child) => {
    const identity = nativeLineIdentity(child);
    if (
      child.quantity !== parent.quantity || !verifiedChildRole(parent, child) || !identity ||
      cart.items.filter((item) => sameNativeLine(nativeLineIdentity(item), identity)).length !== 1
    )
      throw new Error("This blind has a linked cart line Roman cannot safely update. No cart change was submitted.");
    return { key: child.key, identity };
  });
}

function nativeRemovalPlan(cart: StoreCart, keys: string[]): RemovalPlan {
  const requested = keys.map((key) => cart.items.find((item) => item.key === key)!);
  if (requested.some((item) => item.product_type !== "Product" || item.parent_relationship != null))
    throw new Error("The storefront cannot safely remove these cart lines without their native controls. No cart change was submitted.");
  const removedKeys = new Set(keys);
  // The theme removes cart-level insurance when no non-sample, non-insurance
  // item will remain. Its remove toggle otherwise removes per-product groups.
  const remainingNonInsurance = cart.items.filter((item) =>
    !removedKeys.has(item.key) && item.product_type !== "Insurance",
  );
  const clearAllInsurance = remainingNonInsurance.every((item) => item.product_type === "Sample");
  for (const parent of requested) {
    const parentProperties = propertiesOf(parent);
    for (const child of cart.items) {
      if (removedKeys.has(child.key)) continue;
      const exactChild = parentKey(child) === parent.key;
      const childProperties = propertiesOf(child);
      const groupChild = !!parentProperties && !!childProperties && (
        (child.product_type === "Insurance" &&
          childProperties._insurance_type === "product" &&
          sharedNonemptyProperty(parentProperties, childProperties, "_insurance_group")) ||
        (child.product_type === "Warranty" &&
          sharedNonemptyProperty(parentProperties, childProperties, "_warranty_group"))
      );
      if (!exactChild && !groupChild) continue;
      if (clearAllInsurance && child.product_type === "Insurance") {
        removedKeys.add(child.key);
        continue;
      }
      if (!verifiedChildRole(parent, child) ||
        (parentKey(child) !== undefined && parentKey(child) !== parent.key))
        throw new Error("A linked cart line cannot be safely identified. No cart change was submitted.");
      removedKeys.add(child.key);
    }
  }
  if (clearAllInsurance)
    for (const item of cart.items)
      if (item.product_type === "Insurance") removedKeys.add(item.key);
  const removed = cart.items.filter((item) => removedKeys.has(item.key)).map((item) => {
    const identity = nativeLineIdentity(item);
    if (!identity ||
      cart.items.filter((entry) => sameNativeLine(nativeLineIdentity(entry), identity)).length !== 1)
      throw new Error("A requested cart line cannot be uniquely verified. No cart change was submitted.");
    return { key: item.key, identity };
  });
  return {
    removed,
    retained: cart.items.filter((item) => !removedKeys.has(item.key)).map((item) => ({
      key: item.key,
      quantity: item.quantity,
      identity: nativeLineIdentity(item),
      parentKey: parentKey(item),
    })),
  };
}

function removalConfirmed(cart: StoreCart, plan: RemovalPlan): boolean {
  if (!plan.removed.every((target) =>
    !cart.items.some((item) =>
      item.key === target.key || sameNativeLine(nativeLineIdentity(item), target.identity),
    ),
  )) return false;
  const retained = new Map<string, StoreCart["items"][number]>();
  for (const target of plan.retained) {
    const item = confirmedQuantityLine(
      cart, target.key, target.quantity, target.identity, !!target.identity,
    );
    if (!item) return false;
    retained.set(target.key, item);
  }
  return plan.retained.every((target) =>
    !target.parentKey || parentKey(retained.get(target.key)!) === retained.get(target.parentKey)?.key,
  );
}

function confirmedQuantityLine(
  cart: StoreCart,
  key: string,
  quantity: number,
  identity: NativeLineIdentity | undefined,
  requireIdentity: boolean,
): StoreCart["items"][number] | undefined {
  const direct = cart.items.find((item) => item.key === key);
  if (direct)
    return direct.quantity === quantity &&
      (!requireIdentity || (identity && sameNativeLine(nativeLineIdentity(direct), identity)))
      ? direct : undefined;
  if (!identity) return;
  const rotated = cart.items.filter((item) => sameNativeLine(nativeLineIdentity(item), identity));
  return rotated.length === 1 && rotated[0].quantity === quantity ? rotated[0] : undefined;
}

function observeAction(
  owner: CartElement,
  action: Action,
  baseline: StoreCart,
  signal: AbortSignal,
  submit: () => unknown,
  linkedTargets: LinkedQuantityTarget[] = [],
  removalPlan?: RemovalPlan,
): Promise<CartActionResult> {
  signal.throwIfAborted();
  const identity = action.kind === "quantity"
    ? nativeLineIdentity(baseline.items.find((item) => item.key === action.lineKey)!)
    : undefined;
  const rotatedIdentity = identity && baseline.items.filter(
    (item) => sameNativeLine(nativeLineIdentity(item), identity),
  ).length === 1 ? identity : undefined;
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
    const onLeave = () => finish(removalPlan ? {
      ...handedOff,
      message: "The storefront removal was submitted, but Roman could not confirm every selected blind and linked cover was removed while the other cart lines stayed. Check the cart before trying again; do not repeat the removal automatically.",
    } : linkedTargets.length ? {
      ...handedOff,
      message: "The storefront update was submitted, but Roman could not confirm the blind and every linked cover reached the requested quantity. Check the cart before trying again; do not repeat the update automatically.",
    } : handedOff);
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
            ? removalPlan ? removalConfirmed(cart, removalPlan)
              : !cart.items.some((item) => item.key === action.lineKey)
            : (() => {
                const parent = confirmedQuantityLine(
                  cart, action.lineKey, action.quantity, rotatedIdentity,
                  linkedTargets.length > 0,
                );
                return !!parent && linkedTargets.every((target) => {
                  const child = confirmedQuantityLine(
                    cart, target.key, action.quantity, target.identity, true,
                  );
                  return !!child && parentKey(child) === parent.key;
                });
              })();
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

function quantityUpdates(action: Extract<Action, { kind: "quantity" }>, linkedTargets: LinkedQuantityTarget[]) {
  return Object.fromEntries(
    [action.lineKey, ...linkedTargets.map((target) => target.key)]
      .map((key) => [key, action.quantity]),
  ) as Record<string, number>;
}

async function updateLinkedQuantity(
  control: CartElement,
  action: Extract<Action, { kind: "quantity" }>,
  cart: StoreCart,
  signal: AbortSignal,
  linkedTargets: LinkedQuantityTarget[],
): Promise<CartActionResult> {
  const sections = control.closest("cart-sections");
  if (!sections || !registered(sections) ||
    typeof sections.updateQuantityToCart !== "function")
    throw new Error("The storefront cannot update this blind and its linked cover together. No cart change was submitted.");
  if (sections.closest('[inert], [aria-disabled="true"]') ||
    !matchingCart(sections.cart, cart))
    return needsCartPage;
  if (sections.shopifyCartLoading || sections.classList.contains("loading"))
    throw new Error("Wait for the storefront's current cart update to finish.");
  return await observeAction(sections, action, cart, signal, () =>
    sections.updateQuantityToCart!(quantityUpdates(action, linkedTargets)),
    linkedTargets,
  );
}

async function runAction(
  action: Action,
  signal: AbortSignal,
  baseline?: StoreCart,
): Promise<CartActionResult> {
  signal.throwIfAborted();
  if (
    action.kind !== "clear" &&
    (!action.lineKey.trim() || action.lineKey.length > 500)
  )
    throw new Error("Provide a current lineKey from get_cart.");
  if (
    action.kind === "quantity" &&
    (!Number.isSafeInteger(action.quantity) ||
      action.quantity < 1 ||
      action.quantity > 999)
  )
    throw new Error(
      "Provide a positive whole-number quantity up to 999. Use remove_from_cart to remove an item.",
    );
  const initialUrl = window.location.href;
  let leftPage = false;
  const onLeave = () => {
    leftPage = true;
  };
  document.addEventListener("roman:navigation", onLeave, { once: true });
  window.addEventListener("pagehide", onLeave, { once: true });
  let cart: StoreCart;
  try {
    cart = baseline ?? (await getStoreCart(signal));
  } finally {
    document.removeEventListener("roman:navigation", onLeave);
    window.removeEventListener("pagehide", onLeave);
  }
  signal.throwIfAborted();
  if (leftPage || window.location.href !== initialUrl) return needsCartPage;
  let linkedTargets: LinkedQuantityTarget[] = [];
  if (action.kind !== "clear") {
    const item = cart.items.find((entry) => entry.key === action.lineKey);
    if (!item)
      throw new Error(
        "That cart line no longer exists. Read get_cart for its current lineKey.",
      );
    if (action.kind === "quantity") {
      linkedTargets = linkedQuantityTargets(cart, item);
      if (item.quantity === action.quantity)
        return {
          status: "updated",
          cart: summarizeCart(cart),
          message: "The cart line already has that quantity; no change was made.",
        };
    }
  } else if (cart.items.length === 0 && cart.item_count === 0) {
    return {
      status: "updated",
      cart: summarizeCart(cart),
      message: "The cart is already empty; no change was made.",
    };
  }

  const providers = document.querySelectorAll("app-provider");
  if (providers.length !== 1 || !registered(providers[0])) return needsCartPage;
  const provider = providers[0];
  const selector =
    action.kind === "clear"
      ? "cart-sections"
      : action.kind === "remove"
        ? "cart-remove-toggle"
        : "quantity-input, quantity-select";
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
  if (action.kind === "quantity" && candidates.length === 0) {
    // A present control remains authoritative even when it is uninitialized,
    // disabled or stale. Only the notification owner can cover its absence.
    const controls = provider.querySelectorAll("quantity-input, quantity-select");
    if (
      Array.from(controls).some(
        (element) =>
          element.getAttribute("key") === action.lineKey ||
          (element as CartElement).lineItemKey === action.lineKey,
      )
    )
      return needsCartPage;
    const item = cart.items.find((entry) => entry.key === action.lineKey)!;
    if (item.product_type !== "Product" || item.parent_relationship != null)
      return needsCartPage;
    const notification = Array.from(
      provider.querySelectorAll("cart-sections[data-cart-notification-mode]"),
    ).find(
      (element): element is CartElement =>
        registered(element) &&
        typeof element.updateQuantityToCart === "function" &&
        !element.closest('[inert], [aria-disabled="true"]') &&
        matchingCart(element.cart, cart),
    );
    if (!notification) return needsCartPage;
    if (
      notification.shopifyCartLoading ||
      notification.classList.contains("loading")
    )
      throw new Error("Wait for the storefront's current cart update to finish.");
    return await observeAction(notification, action, cart, signal, () =>
      notification.updateQuantityToCart!(quantityUpdates(action, linkedTargets)),
      linkedTargets,
    );
  }
  // Cart page and drawer can both have controls. Both use the same context;
  // prefer the page's control when present and invoke only one owner.
  const owner =
    candidates.find((element) => element.closest("main#main")) ?? candidates[0];
  if (
    !owner ||
    owner.closest('[inert], [aria-disabled="true"]') ||
    !matchingCart(owner.cart, cart)
  )
    return needsCartPage;
  if (owner.shopifyCartLoading || owner.classList.contains("loading"))
    throw new Error("Wait for the storefront's current cart update to finish.");

  if (action.kind === "clear")
    return await observeAction(owner, action, cart, signal, () => owner.clearCart!());

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
    return await observeAction(owner, action, cart, signal, () => {
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

  if (owner.localName === "quantity-select") {
    const selects = owner.querySelectorAll<HTMLSelectElement>("select");
    if (
      selects.length !== 1 ||
      selects[0].multiple ||
      selects[0].matches(":disabled") ||
      selects[0].closest('[inert], [aria-disabled="true"]')
    )
      return needsCartPage;
    const select = selects[0];
    const options = Array.from(select.options).filter(
      (option) => option.value === String(action.quantity),
    );
    if (
      options.length !== 1 ||
      options[0].disabled ||
      options[0].closest('optgroup:disabled, [aria-disabled="true"]')
    )
      throw new Error("That quantity is outside this cart line's allowed range.");
    if (linkedTargets.length)
      return await updateLinkedQuantity(owner, action, cart, signal, linkedTargets);
    return await observeAction(owner, action, cart, signal, () => {
      // The theme's select change handler owns its debounce and cart update.
      select.value = options[0].value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
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
    throw new Error("That quantity is outside this cart line's allowed range.");
  if (linkedTargets.length)
    return await updateLinkedQuantity(owner, action, cart, signal, linkedTargets);
  return await observeAction(owner, action, cart, signal, () => {
    // quantity-input owns debouncing, bounds, pricing and grouped accessories.
    input.value = String(action.quantity);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function exclusively(operation: () => Promise<CartActionResult>) {
  if (actionPending) throw new Error("Another cart action is still running.");
  actionPending = true;
  try {
    return await operation();
  } finally {
    actionPending = false;
  }
}

async function removeWithoutLineControls(
  keys: string[],
  cart: StoreCart,
  signal: AbortSignal,
): Promise<CartActionResult | undefined> {
  const providers = document.querySelectorAll("app-provider");
  if (providers.length !== 1 || !registered(providers[0])) return needsCartPage;
  const provider = providers[0];
  const controls = Array.from(provider.querySelectorAll("cart-remove-toggle"));
  const present = keys.map((key) => controls.some((control) =>
    control.getAttribute("key") === key || (control as CartElement).key === key,
  ));
  if (present.every(Boolean)) return;
  // A present control remains authoritative even if it is disabled or stale.
  // A requested dependent without its own control may be removed by an earlier
  // native toggle; the serial path confirms that before considering another write.
  if (present.some(Boolean))
    return keys.every((key, index) => present[index] ||
      ["Insurance", "Warranty"].includes(String(cart.items.find((item) => item.key === key)?.product_type)))
      ? undefined : needsCartPage;
  const notification = Array.from(
    provider.querySelectorAll("cart-sections[data-cart-notification-mode]"),
  ).find((element): element is CartElement =>
    registered(element) &&
    typeof element.removeItemFromCart === "function" &&
    !element.closest('[inert], [aria-disabled="true"]') &&
    matchingCart(element.cart, cart),
  );
  if (!notification) return needsCartPage;
  if (notification.shopifyCartLoading || notification.classList.contains("loading"))
    throw new Error("Wait for the storefront's current cart update to finish.");
  const plan = nativeRemovalPlan(cart, keys);
  return await observeAction(
    notification,
    { kind: "remove", lineKey: keys[0] },
    cart,
    signal,
    () => notification.removeItemFromCart!(plan.removed.map((target) => target.key)),
    [],
    plan,
  );
}

export async function removeFromCart(lineKeys: string[], signal: AbortSignal) {
  const call = parseCartCall("remove_from_cart", { lineKeys });
  const keys = call.arguments.lineKeys as string[];
  return exclusively(async () => {
    signal.throwIfAborted();
    const initialUrl = window.location.href;
    const controller = new AbortController();
    const stop = () => controller.abort();
    const deadline = window.setTimeout(stop, 35_000);
    signal.addEventListener("abort", stop, { once: true });
    window.addEventListener("pagehide", stop, { once: true });
    document.addEventListener("roman:navigation", stop, { once: true });
    let completed = 0;
    let confirmedRemoved = 0;
    const partial = (): CartActionResult => ({
      ...handedOff,
      message: `${confirmedRemoved} of ${keys.length} requested cart lines were confirmed removed before this operation stopped. Check the current cart before requesting another change; do not repeat the batch automatically.`,
    });
    try {
      const baseline = await getStoreCart(controller.signal);
      controller.signal.throwIfAborted();
      if (window.location.href !== initialUrl) return needsCartPage;
      // Validate the entire request before the first write: a stale entry must
      // never silently turn a batch into a smaller, unintended cart change.
      if (keys.some((key) => !baseline.items.some((item) => item.key === key)))
        throw new Error(
          "A requested cart line no longer exists. Read get_cart for current lineKeys.",
        );
      const nativeResult = await removeWithoutLineControls(keys, baseline, controller.signal);
      if (nativeResult) return nativeResult;
      let result: CartActionResult | undefined;
      for (const key of keys) {
        controller.signal.throwIfAborted();
        // The preceding native removal may already have removed this linked
        // line. Only its confirmed result can justify skipping that write.
        if (
          result?.cart &&
          !result.cart.items.some((item) => item.lineKey === key)
        )
          continue;
        result = await runAction(
          { kind: "remove", lineKey: key },
          controller.signal,
          completed === 0 ? baseline : undefined,
        );
        if (result.status !== "updated")
          return completed > 0 ? partial() : result;
        completed++;
        confirmedRemoved = keys.filter(
          (key) => !result!.cart!.items.some((item) => item.lineKey === key),
        ).length;
      }
      return confirmedRemoved === keys.length ? result! : partial();
    } catch (error) {
      if (completed > 0) return partial();
      throw error;
    } finally {
      window.clearTimeout(deadline);
      signal.removeEventListener("abort", stop);
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("roman:navigation", stop);
    }
  });
}

export function setCartQuantity(
  lineKey: string,
  quantity: number,
  signal: AbortSignal,
) {
  return exclusively(() =>
    runAction({ kind: "quantity", lineKey, quantity }, signal),
  );
}

export function clearCart(signal: AbortSignal) {
  return exclusively(() => runAction({ kind: "clear" }, signal));
}
