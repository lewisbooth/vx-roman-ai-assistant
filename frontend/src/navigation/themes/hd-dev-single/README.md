# HD dev single

This folder owns the permanent Shopify identity `hd-dev-single.myshopify.com`, now served at `https://shopify-single-dev.hdecom.com`. Domain changes do not change the theme profile; chat's allowed storefront origins live in root [`shared/storefronts.ts`](../../../../../shared/storefronts.ts).

Representative pages for theme checks:

- `/collections/blackout-blinds`
- `/collections/all`
- `/products/lottie-mojito-roman-blind`
- `/products/bifold-clickfit-duoshade-obsidian-pleated-blind`

This profile currently reuses the [Blinds 2go UK hooks](../blinds-2go-uk/README.md) for Shopify wallets and cart Continue shopping. Shared navigation and its unsafe-script, cart-module and persistent-shell checks remain in force.

Public theme assets match the shared HD app-provider, header and product conventions. Both PDPs include `https://www.paypal.com/sdk/js` inside the dynamic-pricing form. The [shared PayPal handler](../../shared/paypal.ts) validates and initializes it for every store. Authenticated Home and both PDP responses pass page preparation; Home has no PayPal SDK and needs no load.

The current Home and Cart use conflicting `cart-sections`, `quantity-select` and `cart-item-feature` definitions. Cart also omits the notification shell present on Home. Shared navigation logs these incompatibilities and loads the full destination page. The empty Cart lacks the drawer implementation's required form, so skipping its page module is unsafe.

The collection filters cache `#collection` in their constructor. Shared page insertion keeps incoming custom elements inactive until the new collection is in the document, allowing the theme to remove its loading blur normally.

The PDP has a notification-only cart without quantity editors. Its initialized `cart-sections[data-cart-notification-mode]` exposes the same native `updateQuantityToCart` method used by the full cart's quantity controls. Roman uses this owner when an editor is absent, avoiding the incompatible cart-page transition. Shopify can rotate a configured line's key after a quantity update; confirmation matches the unique, unchanged native configuration properties and variant, then returns the new key. A title or variant alone is insufficient.

Multiple configured copies use the PDP's existing quantity select in one native add; the theme also submits per-product insurance, warranty and express-dispatch quantities. The cart's native quantity method does not synchronize those children itself. Roman uses exact Shopify parent links plus verified per-copy insurance/warranty role and group properties to submit one update for all matching quantities. Unknown child roles or inconsistent quantities stop before writing; cart-level insurance and generic accessories are never inferred to be per-copy.

Isolated Chromium tests against the real dev-store basket verified adding three configured blinds, adding three linked measurement covers, changing both quantities together to four then two across key rotation, and preserving a second size of the same variant. Test baskets were cleared; no orders were placed. Full checkout and other themes remain outside this live check. Keep confirmed theme differences here and reuse shared hooks where behavior matches. See the [frontend README](../../../../README.md) for checks, diagnostic logging and publishing.
