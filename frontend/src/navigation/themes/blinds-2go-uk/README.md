# Blinds 2go UK theme

This module serves `blinds-2go.myshopify.com` at [shop.blinds-2go.co.uk](https://shop.blinds-2go.co.uk/).

`prepare()` normalizes the observed cart Continue-shopping handler and identifies the Shopify wallet module. Continue shopping goes Back within Roman's recorded history segment, otherwise Home; its native link opens Home after Roman is removed. Shared navigation owns page replacement, history, theme assets, globals and metadata. Product pricing and controls remain theme-owned.

The current drawer/page cart modules register conflicting custom elements. Shared navigation logs the conflict and loads the full destination page. It also uses normal navigation when the destination expects a cart drawer missing from the current document. Give conflicting components compatible implementations or distinct definitions and make the persistent shell consistent to restore seamless navigation. Wallet components initialize when connected after their module loads; see [Shopify's accelerated checkout contract](https://shopify.dev/docs/storefronts/themes/pricing-payments/accelerated-checkout).

See the [frontend README](../../../../README.md) for checks and publishing.

Live browser checks must cover pricing, wallets, drawer behavior and tracking after navigation. Bloomreach and Elevar were observed. [Bloomreach can already track URL changes](https://documentation.bloomreach.com/engagement/docs/javascript-sdk-configuration); Roman does not add unverified pageview calls or replay tracking scripts.
