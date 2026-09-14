# SelectBlinds theme

This module owns `select-blinds-us.myshopify.com` ([production](https://www.selectblinds.com/)) and its destinations. [HD dev multi](../hd-dev-multi/README.md) reuses these theme hooks and owns its own links. Home and Cart are added centrally.

`prepare()` normalizes the observed cart Continue-shopping handler and identifies Shopify wallet modules. Continue shopping goes Back within Roman's recorded history segment, otherwise Home; its native link opens Home after Roman is removed. Shared navigation owns page replacement, history, theme assets, globals, metadata and optional PayPal handling.

The [shared PayPal handler](../../shared/paypal.ts) loads one SDK per document and waits for readiness before the product connects. The theme sets its message amount and `data-pp-message` after pricing; [PayPal's observer](https://github.com/paypal/paypal-messaging-components/blob/develop/src/utils/observers.js) handles rendering. The original SDK tag is preserved outside replaced content. Failures or configuration changes require a reload.

The current drawer/page cart modules register conflicting custom elements. Shared navigation logs the conflict and loads the full destination page. It also uses normal navigation when the destination expects a cart drawer missing from the current document. Give conflicting components compatible implementations or distinct definitions and make the persistent shell consistent across templates to restore seamless navigation.

See the [frontend README](../../../../README.md) for checks and publishing.

Live browser checks must cover pricing, messages, wallet controls, drawer behavior and tracking after navigation. Roman updates page metadata but sends no synthetic analytics pageviews; [Shopify permits custom event publishing only](https://shopify.dev/docs/api/web-pixels-api/emitting-data).
