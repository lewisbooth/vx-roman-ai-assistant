# SelectBlinds theme

This module serves `select-blinds-us.myshopify.com` ([production](https://www.selectblinds.com/)) and `hd-dev-multi.myshopify.com`. They share theme behavior but have separate verified destinations. The local preview uses the dev destinations.

`prepare()` normalizes the observed cart Continue-shopping handler, identifies Shopify wallet modules, and extracts the optional PDP PayPal SDK. Continue shopping goes Back within Roman's recorded history segment, otherwise Home; its native link opens Home after Roman is removed. Shared navigation owns page replacement, history, theme assets, globals and metadata.

`paypal.ts` loads one SDK per document and waits for readiness before the product connects. The theme sets its message amount and `data-pp-message` after pricing; [PayPal's observer](https://github.com/paypal/paypal-messaging-components/blob/develop/src/utils/observers.js) handles rendering. The original SDK tag is preserved outside replaced content. Failures or configuration changes require a reload.

The dev LEVOLOR template references a missing `-cart-remove-toggle.js`; the persistent cart module already imports the component's chunk. This follows the shared asset-warning policy, with no filename-specific skip. Remove the stale reference in the theme when fixing its build output.

The current drawer/page cart modules register conflicting custom elements. Shared preparation keeps that transition blocked until the theme is fixed. It also blocks a destination that expects a cart drawer missing from the current document, before changing content. The theme must make that persistent shell consistent across templates.

See the [frontend README](../../../../README.md) for checks and publishing.

Live browser checks must cover pricing, messages, wallet controls, drawer behavior and tracking after navigation. Roman updates page metadata but sends no synthetic analytics pageviews; [Shopify permits custom event publishing only](https://shopify.dev/docs/api/web-pixels-api/emitting-data).
