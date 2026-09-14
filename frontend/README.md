# Roman AI Assistant frontend

The customer React Router app uses Tailwind CSS 4 inside a Shadow DOM. Its bottom-left **R** button logs `Hello from Roman` and opens a 400px sidebar on the right. At viewport widths of 1024px and above the storefront reserves that space; smaller screens use an overlay. The host, launcher and sidebar use z-index `2147483647` to sit above theme widgets. The React instance persists across supported navigation and sidebar toggles. No AI connection is implemented yet.

For a new session, only the small launcher script runs on page load. The first click immediately opens the ivory shell and requests the React bundle, logo and texture. A logo and indeterminate loading bar remain until React commits and at least one second has passed since loading began. This deliberate development delay applies once per page load, including cached loads and automatic restoration; reopening or remounting on the same page does not restart it. Slow downloads add no extra delay. Closing keeps the runtime mounted, and load failures offer an explicit retry. The loaded view contains the Roman by SelectBlinds logo, conversation heading and POC navigation links.

Open/closed state is saved in `sessionStorage` for the current tab and storefront origin. Normal navigation or reload automatically reopens and mounts Roman when it was open, without taking focus from the storefront. Back/Forward cache restores follow the latest saved state. Closing it keeps subsequent pages collapsed and lazy. If browser storage is unavailable, the sidebar remains usable and logs one warning per page. Only visibility is saved; full page loads create a fresh React runtime.

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

`npm test` runs the frontend DOM tests. `build:frontend` builds both extension bundles and copies the design assets; `watch:frontend` rebuilds them on changes. `deploy` checks and rebuilds before releasing through Shopify CLI; see the [root publishing instructions](../README.md#publish) for release scope and version labels. Enable **Assistant icon** in the theme's **App embeds**, save and refresh. Admin hosting is separate.

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
| [tests/](tests), [build.mjs](build.mjs), [vite.config.ts](vite.config.ts)    | DOM tests, local preview and two-entry extension build             |

The memory router owns only assistant routes. The shared storefront navigator owns supported page changes: it fetches same-origin HTML, prepares assets/context and replaces `app-provider > main#main`, preserving Roman and the surrounding theme shell. Incoming custom elements remain inactive until insertion, so constructors find the new page's elements and context; this lets collection filters clear their own loading blur. Theme integrations supply their specific behavior. Keep credentials, persistence and privileged API calls in the separate [admin app](../admin/README.md).

Removing the embed disposes its React root, router, navigation listeners, pending work and layout styles. Theme-handled forms, modified clicks, unsupported destinations and normal reloads retain native behavior and can end the current assistant instance.

## Design and fonts

The light [Fixed sidebar - Empty session](https://www.figma.com/design/MHKvB5SNK2Z81DKYBSFbYt/Shopify-%7C-Roman-AI?node-id=27-200) defines ivory `#F7F5EF`, burgundy `#4E0E0E` and the outlined logo. The loading state uses the same light palette. Keep the exact Figma assets in `src/assets/`; the build copies the logo and texture into the extension and inlines the small close icon in the launcher.

Use the theme's **`GelicaSite`** font family, with Georgia as fallback. Gelica is confirmed working on the development storefront. SelectBlinds preloads normal and italic Gelica; the UK and Ireland themes declare Gelica but currently preload Inter instead. Themes own font loading in production. The local preview declares Gelica using SelectBlinds' public font URLs only for visual development.

## Theme integrations

- [HD dev multi](src/navigation/themes/hd-dev-multi/README.md)
- [HD dev single](src/navigation/themes/hd-dev-single/README.md)
- [SelectBlinds](src/navigation/themes/selectblinds/README.md)
- [Blinds 2go UK](src/navigation/themes/blinds-2go-uk/README.md)
- [Blinds 2go Ireland](src/navigation/themes/blinds-2go-ie/README.md)

The theme registry selects by Shopify shop identity and adds Home (`/`) and Cart (`/cart`) to every configured store. Each folder owns its collection/product links; development stores reuse production theme hooks where behavior matches. `shared/` contains no store-specific destinations. Unknown stores remain unconfigured.

Keep supported stores/routes, integration requirements and investigation findings in the owning theme README. Share navigation and history behavior rather than copying it into theme folders. Discover assets from the current theme; do not pin generated theme IDs or asset hashes in application code.

Known cart and payment restrictions remain explicit in those READMEs. Incompatible cart modules, a missing destination cart shell, and confirmed duplicate custom-element registrations log `[Roman] Theme component conflict; loading the full page.` and fall back to normal navigation. Back/Forward keeps the selected history entry. Enable **Preserve log** in DevTools to retain the error across refreshes; diagnostic URLs omit query strings and fragments. Roman restores its saved open/closed state, but a full page load restarts its runtime and any future voice connection. Distinct, compatible theme components can remove the need for this fallback later.

Other unsupported integrations still fail before content replacement; evaluated scripts cannot be rolled back. Do not replay arbitrary inline scripts or hide conflicting custom-element registrations.

The optional [PayPal handler](src/navigation/shared/paypal.ts) is shared by every store. If a destination includes the supported SDK tag, Roman validates its configuration, loads it once per document and waits for readiness before connecting the new product. Pages without the tag do no PayPal work. An existing SDK survives page replacement; incompatible configurations and SDK failures still require a reload. The theme and PayPal own message rendering and checkout controls.

Ordinary script and stylesheet load failures or 15-second asset timeouts emit `[Roman]` console warnings and allow navigation after the remaining assets settle. There are no filename-specific skips; warnings include the asset origin/path without query parameters. Unsafe markup, unsupported integrations, other script runtime errors and required payment-component readiness failures still stop navigation. Cancellation stays silent. A successful page swap does not guarantee every theme feature works.

When generic script validation fails, expand `[Roman] Unsafe storefront scripts blocked navigation.` in the browser console. Its `blocked` list identifies each rejected script or inline attribute by reason, script source/type and a structural selector in the fetched page. The report includes the destination and theme; it omits URL credentials, query strings, fragments, inline code and attribute values. The existing page stays intact. Theme-specific SDK and cart checks can still fail earlier with their own errors.

## Verification

Run `npm run check` for the complete checks. For extension changes, rebuild the frontend and run `shopify app build` to include Theme Check. Tests use DOM fixtures and a simulated payment SDK; they do not prove live pricing, payments, analytics or voice continuity.

On each target theme, test a cold first open, cached reopen, closing while loading, full page navigation/reload while open and closed, supported links, Back/Forward, rapid navigation and request failures. Compare product options, measurements, pricing, galleries and cart behavior with normal navigation. Check keyboard focus, a 1280px desktop, a wider desktop and the mobile overlay; theme breakpoints still follow the full viewport.

Tailwind utilities that depend on `@property` need verification inside Shadow DOM, especially shadows, rings and transforms. The launcher uses explicit border/outline and box-shadow values.

The [theme extension](../extensions/vx-roman-ai-assistant) owns Liquid and translations. Shopify loads `roman-assistant-loader.bundle.js`; that shell requests `roman-assistant.bundle.js` on first open or restored visibility. Both bundles and the copied logo/texture are generated and excluded from Git. Rebuild before publishing; never edit generated assets by hand.
