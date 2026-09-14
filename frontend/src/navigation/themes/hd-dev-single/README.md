# HD dev single

This folder owns `hd-dev-single.myshopify.com` and the supplied POC destinations:

- `/collections/blackout-blinds`
- `/collections/all`
- `/products/lottie-mojito-roman-blind`
- `/products/bifold-clickfit-duoshade-obsidian-pleated-blind`

Home and Cart are added centrally in [the theme registry](../index.ts). This profile currently reuses the [Blinds 2go UK hooks](../blinds-2go-uk/README.md) for Shopify wallets and cart Continue shopping. Shared navigation and its unsafe-script, cart-module and persistent-shell checks remain in force.

Public theme assets match the shared HD app-provider, header and product conventions. Both PDPs include `https://www.paypal.com/sdk/js` inside the dynamic-pricing form. The [shared PayPal handler](../../shared/paypal.ts) validates and initializes it for every store. Authenticated Home and both PDP responses pass page preparation; Home has no PayPal SDK and needs no load.

Cart templates and live product behavior remain unverified. Compare configuration, pricing, payments and cart transitions with normal navigation. Keep confirmed differences in this folder and reuse existing hooks where behavior matches. See the [frontend README](../../../../README.md) for checks, diagnostic logging and publishing.
