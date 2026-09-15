# Roman AI Assistant frontend

The customer React Router app uses Tailwind CSS 4 inside a Shadow DOM. Its bottom-left **R** button logs `Hello from Roman` and opens a 400px sidebar on the right. At viewport widths of 1024px and above the storefront reserves that space; smaller screens use an overlay. The host, launcher and sidebar use z-index `2147483647` to sit above theme widgets. The React instance persists across successful in-place navigation and sidebar toggles. Development stores connect to persistent Luna text chat through the separate Roman backend.

For a new session, only the small launcher script runs on page load. The first click immediately opens the ivory shell and requests the React bundle, logo and texture. A logo and indeterminate loading bar remain until React commits and at least one second has passed since loading began. This deliberate development delay applies once per page load, including cached loads and automatic restoration; reopening or remounting on the same page does not restart it. Slow downloads add no extra delay. Closing keeps the runtime mounted, and load failures offer an explicit retry. The home view contains the Roman by SelectBlinds logo, conversation heading, four exact Figma illustrations and a working text composer. The tiles are disabled until their features arrive. POC navigation and tools are inside a collapsed Development section on development stores.

Open/closed state is saved in `sessionStorage` for the current tab and storefront origin. Normal navigation or reload automatically reopens and mounts Roman when it was open, without taking focus from the storefront. Back/Forward cache restores follow the latest saved state. Closing keeps subsequent pages collapsed. An active saved chat quietly loads the runtime after full navigation so it can record public page visits; visitors who have never started a chat still get only the launcher. If browser storage is unavailable, the sidebar remains usable and logs one warning per page. Conversation credentials are also saved per tab once a first message starts a session. Reloads create a fresh React runtime and restore the same server transcript through Shopify's signed proxy. Closing does not end an active model reply; reopening refreshes its result. Page visits appear as quiet linked entries even when the sidebar was closed. End chat waits for server acknowledgement, clears local credentials and returns to the home screen; the next message starts a new conversation.

The loading bar intentionally animates regardless of the browser's reduced-motion preference.

## Develop, build and publish

Follow the [root setup](../README.md), then run commands from the repository root:

```powershell
npm run dev:frontend
```

Open http://127.0.0.1:5173. The standalone preview uses the `hd-dev-multi` profile against local demo pages without Shopify credentials or the admin server. It does not simulate Shopify pricing, product configuration or cart behavior.

```powershell
npm test
npm run build:frontend
npm run deploy
```

`npm test` runs frontend and backend behavior tests. `build:frontend` builds both extension bundles and copies the design assets; `watch:frontend` rebuilds them on changes. `deploy` checks and rebuilds before releasing through Shopify CLI; see the [root publishing instructions](../README.md#publish) for release scope and version labels. Enable **Assistant icon** in the theme's **App embeds**, save and refresh. Admin hosting is separate.

The build enforces Shopify's 10 KB limit for the initial script. Keep React and theme navigation in the lazy runtime.

## Ownership

| Location                                                                     | Responsibility                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [src/bootstrap.ts](src/bootstrap.ts), [src/bootstrap.css](src/bootstrap.css) | Custom element, launcher, loading shell and lazy runtime lifecycle |
| [src/app.tsx](src/app.tsx), [src/main.tsx](src/main.tsx)                     | Loaded assistant UI, memory router and navigation ownership        |
| [src/styles.css](src/styles.css), [src/assets/](src/assets)                  | Loaded UI styles and canonical Figma exports                       |
| [src/storefront.css](src/storefront.css)                                     | Desktop page space reserved by the shell                           |
| [src/navigation/shared/](src/navigation/shared)                              | Common navigation, history, page loading and lifecycle contracts   |
| [src/navigation/themes/](src/navigation/themes)                              | Concrete theme integration and selection by Shopify shop identity  |
| [src/tools/](src/tools)                                                      | Callable storefront tools and the developer drawer                 |
| [tests/](tests), [build.mjs](build.mjs), [vite.config.ts](vite.config.ts)    | DOM tests, local preview and two-entry extension build             |

The memory router owns only assistant routes. The shared storefront navigator accepts any same-origin HTTP(S) path: it fetches HTML, prepares assets/context and replaces `app-provider > main#main`, preserving Roman and the surrounding theme shell. Incoming custom elements remain inactive until insertion, so constructors find the new page's elements and context; this lets collection filters clear their own loading blur. After navigation reaches the top, Roman calls the theme header's reset method and synchronizes its scroll baseline; restored history and anchor positions below the top keep normal header behavior. Theme integrations supply their specific behavior. Keep credentials, persistence and privileged API calls in the separate [admin app](../admin/README.md).

Removing the embed disposes its React root, router, navigation listeners, pending work and layout styles. Theme-handled forms, modified clicks, external links and links marked `data-roman-native-navigation` retain native behavior and can end the current assistant instance. Ordinary same-origin links use Roman navigation while the sidebar is open.

## Text chat ownership

`src/session/` owns bootstrap, tab-scoped credentials, polling, retry identity, catalog execution and the session-gated journey observer. `src/chat/` owns the Figma home screen, composer and safely rendered transcript; `app.tsx` connects them through a narrow external-store interface. Browser-safe conversation DTOs live in root `shared/conversation.ts`. Model prompts, OpenAI credentials, authorization and persistence belong in [admin](../admin/README.md#text-conversations).

Chat creates no server conversation until the first message. Pending text refreshes through bounded JSON polling; a lost submission response is reconciled without starting another generation. The same request ID is retained for retry. Typed parts render text, horizontally scrollable product cards and linked page observations; no model HTML is injected. Product cards retain only IDs and fetch current catalog details when mounted. User scroll-up is preserved while Roman replies.

The standalone preview displays the interface only. Verify real chat on an installed development store after approving `write_app_proxy` in Shopify admin. Luna can search and look up products through the same storefront tools used by the drawer. Catalog execution is serialized, claimed once and bounded; lost result acknowledgements retry the saved outcome without repeating the lookup. Model cart/measurement actions and voice are not connected yet.

## Developer tools

On `hd-dev-multi`, `hd-dev-single` and the local preview, expand **Development**, then **Developer tools** below the navigation links. Select a tool, edit its JSON arguments and run it. The drawer calls `createAssistantTools(...).execute(name, arguments)` directly; no LLM or OpenAI key is involved. The same validated functions can serve future model calls. The drawer is hidden on production stores.

| Tool                | Arguments                 | Behavior                                                                           |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `search_products`   | `{ query }`               | Live catalog search, up to 10 results                                              |
| `get_product`       | `{ id }`                  | Details for a product or variant GID from search                                   |
| `lookup_catalog`    | `{ ids }`                 | Batch lookup of 1–10 product/variant GIDs; retains matches and missing-ID messages |
| `get_cart`          | `{}`                      | Current cart totals and lines, including each `lineKey`                            |
| `add_to_cart`       | `{}`                      | Submit the configured current PDP through its theme form                           |
| `remove_from_cart`  | `{ lineKey }`             | Invoke the theme's removal control for that line                                   |
| `set_cart_quantity` | `{ lineKey, quantity }`   | Set a positive whole-number quantity through the theme                             |
| `clear_cart`        | `{}`                      | Empty the cart through the theme                                                   |
| `set_measurements`  | `{ width, height, unit }` | Save a product-specific draft; units `mm`, `cm` or `in`                            |
| `get_measurements`  | `{}`                      | Read the current product's draft                                                   |
| `navigate`          | `{ path }`                | Any same-origin HTTP(S) path, with full-page fallback                              |

Catalog tools call Shopify's [UCP Catalog MCP](https://shopify.dev/docs/agents/catalog/storefront-catalog) at `/api/ucp/mcp`. The embed supplies Roman's public `roman-agent-profile.json` asset; publish the extension before testing profile negotiation. The existing profile supports `lookup_catalog`. These calls need no Admin API credentials. Catalog prices are not a measured-product quote.

If chat rejects a successful catalog response, check the browser console for `[Roman] Catalog response rejected.`. It identifies the tool and failing product field without dumping the response. The backend's `/api/conversations/` requests synchronize pending replies and tool execution every 500 ms; polling stops when the reply completes.

Cart reads use the visitor's locale-aware Ajax cart, accepting JSON served with a JavaScript content type. Cart changes invoke the theme's existing controls and methods, preserving linked insurance/warranty/dispatch rules, cart displays and saved-cart behavior. Copy `lineKey` from a fresh `get_cart` result; refresh it after changes because Shopify can change keys. If the required controls are absent, the action returns `needs_cart_page`: navigate to `/cart`, then retry. A `handed_off` result means submission was attempted but completion was not confirmed; inspect the cart before retrying. Roman does not replay mutations automatically. [Cart MCP](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp) replaces full cart state and is not the transport for this existing theme basket.

Measurement drafts do **not** update theme inputs or cart items; they survive sidebar toggles and Roman navigation, but not a full reload. Navigation rejects external origins, non-HTTP(S) URLs and URLs containing credentials.

Live Shopify calls require the installed storefront and its browser session; localhost reports that limitation instead of returning sample data. Tool runs are explicit, single-flight and bounded; removing Roman cancels its pending observations/requests and clears drafts. Cancellation cannot undo a cart change already handed to the theme. Manual tool results exclude cart tokens, notes and customer attributes; they stay in the drawer and are not logged or persisted. Model catalog results use a separate bounded public projection; only product references persist in chat.

## Design and fonts

The light [Fixed sidebar - Empty session](https://www.figma.com/design/MHKvB5SNK2Z81DKYBSFbYt/Shopify-%7C-Roman-AI?node-id=27-200) defines ivory `#F7F5EF`, burgundy `#4E0E0E` and the outlined logo. The loading state uses the same light palette. Keep the exact Figma assets in `src/assets/`; the build copies the logo and texture into the extension and inlines the small close icon in the launcher.

Use the theme's **`GelicaSite`** font family, with Georgia as fallback. Gelica is confirmed working on the development storefront. SelectBlinds preloads normal and italic Gelica; the UK and Ireland themes declare Gelica but currently preload Inter instead. Themes own font loading in production. The local preview declares Gelica using SelectBlinds' public font URLs only for visual development.

## Theme integrations

- [HD dev multi](src/navigation/themes/hd-dev-multi/README.md)
- [HD dev single](src/navigation/themes/hd-dev-single/README.md)
- [SelectBlinds](src/navigation/themes/selectblinds/README.md)
- [Blinds 2go UK](src/navigation/themes/blinds-2go-uk/README.md)
- [Blinds 2go Ireland](src/navigation/themes/blinds-2go-ie/README.md)

The theme registry selects by Shopify shop identity and adds Home (`/`) and Cart (`/cart`) to every configured store. Each folder owns its collection/product shortcuts; these do not restrict navigation. Development stores reuse production theme hooks where behavior matches. `shared/` contains no store-specific destinations. Unknown stores remain unconfigured.

Keep store shortcuts, integration requirements and investigation findings in the owning theme README. Share navigation and history behavior rather than copying it into theme folders. Discover assets from the current theme; do not pin generated theme IDs or asset hashes in application code.

Navigation failures log `[Roman] Storefront navigation failed; loading the full page.` and hand the validated destination to the browser. This covers fetch errors, incompatible page layouts, unsafe scripts, component conflicts and initialization failures. Back/Forward keeps the selected history entry; failures after a history push reload that entry without duplicating it. Cancelled or superseded requests do not trigger this fallback. Enable **Preserve log** in DevTools to retain the reason across refreshes; diagnostic URLs omit query strings and fragments. Roman restores its saved visibility, but a full page load restarts its runtime and any future voice connection. Do not replay arbitrary inline scripts or hide conflicting custom-element registrations; evaluated scripts cannot be rolled back.

The optional [PayPal handler](src/navigation/shared/paypal.ts) is shared by every store. If a destination includes the supported SDK tag, Roman validates its configuration, loads it once per document and waits for readiness before connecting the new product. Pages without the tag do no PayPal work. An existing SDK survives page replacement; incompatible configurations and SDK failures still require a reload. The theme and PayPal own message rendering and checkout controls.

Ordinary script and stylesheet load failures or 15-second asset timeouts emit `[Roman]` console warnings and allow navigation after the remaining assets settle. There are no filename-specific skips; warnings include the asset origin/path without query parameters. Unsafe markup, unsupported integrations, other script runtime errors and required payment-component readiness failures stop in-place navigation and trigger the full-page fallback. Cancellation stays silent. A successful page swap does not guarantee every theme feature works.

When generic script validation fails, expand `[Roman] Unsafe storefront scripts blocked navigation.` in the browser console. Its `blocked` list identifies each rejected script or inline attribute by reason, script source/type and a structural selector in the fetched page. The report includes the destination and theme; it omits URL credentials, query strings, fragments, inline code and attribute values. The existing page stays intact until the browser takes over. Theme-specific SDK and cart checks can fail earlier with their own errors.

## Verification

Run `npm run check` for the complete checks. For extension changes, rebuild the frontend and run `shopify app build` to include Theme Check. Tests use DOM fixtures and a simulated payment SDK; they do not prove live pricing, payments, analytics or voice continuity.

On each target theme, test a cold first open, cached reopen, closing while loading, full page navigation/reload while open and closed, arbitrary product/collection/search paths, Back/Forward, rapid navigation and request failures. Compare product options, measurements, pricing, galleries and cart behavior with normal navigation. Check keyboard focus, a 1280px desktop, a wider desktop and the mobile overlay; theme breakpoints still follow the full viewport.

Tailwind utilities that depend on `@property` need verification inside Shadow DOM, especially shadows, rings and transforms. The launcher uses explicit border/outline and box-shadow values.

The [theme extension](../extensions/vx-roman-ai-assistant) owns Liquid and translations. Shopify loads `roman-assistant-loader.bundle.js`; that shell requests `roman-assistant.bundle.js` on first open or restored visibility. Both bundles and the copied logo/texture are generated and excluded from Git. Rebuild before publishing; never edit generated assets by hand.
