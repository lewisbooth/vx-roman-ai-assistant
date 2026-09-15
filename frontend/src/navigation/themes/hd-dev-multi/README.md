# HD dev multi

This folder owns the `hd-dev-multi.myshopify.com` theme profile. The local preview uses this store's hooks; its demo pages are defined in `frontend/vite.config.ts`.

It reuses the [SelectBlinds hooks](../selectblinds/README.md) for Shopify wallets and cart Continue shopping. Shared navigation owns optional PayPal handling and retains the cart-module and persistent-shell safety checks.

The LEVOLOR template references a missing `-cart-remove-toggle.js`; the persistent cart module already imports its component. Roman requests the asset and warns on failure without a filename-specific skip. The theme owner should remove the stale reference.

Verify product configuration, pricing, payments and cart transitions on the signed-in storefront after theme changes. See the [frontend README](../../../../README.md) for checks and publishing.
