# Blinds 2go Ireland theme

This module serves `blinds2go-ireland.myshopify.com` at [www.blinds-2go.ie](https://www.blinds-2go.ie/).

`prepare()` replaces the observed cart Continue-shopping `history.back()` handler with a supported navigation link. Continue shopping goes Back within Roman's recorded history segment, otherwise Home; its native link opens Home after Roman is removed. Shared navigation owns page replacement, history, theme assets, globals and metadata. The older pricing and cart components remain theme-owned.

The sampled pages use one cart module and do not introduce the SelectBlinds/UK cart conflict or portable-wallet module. This theme has no additional SDK loader. Newly introduced integrations remain subject to shared validation. Shared navigation logs and loads the full destination page when it expects a cart drawer missing from the current document; the theme must make that persistent shell consistent for seamless navigation.

See the [frontend README](../../../../README.md) for checks and publishing.

Live browser checks must cover pricing, populated carts, drawer behavior and tracking after navigation. Elevar, VWO and Yotpo were observed. Roman does not add unverified pageview calls or replay tracking scripts; [Shopify permits custom event publishing only](https://shopify.dev/docs/api/web-pixels-api/emitting-data).
