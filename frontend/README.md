# Roman AI Assistant frontend

The customer React Router app uses Tailwind CSS 4 inside a Shadow DOM. Its bottom-left **R** button logs `Hello from Roman` and opens a 400px sidebar on the right. At viewport widths of 1024px and above the storefront reserves that space; smaller screens use an overlay. The note and instance ID persist across supported navigation and sidebar toggles. No AI connection is implemented yet.

## Develop, build and publish

Follow the [root setup](../README.md), then run commands from the repository root:

```powershell
npm run dev:frontend
```

Open http://127.0.0.1:5173. The standalone preview exercises the app and navigation against local demo pages without Shopify credentials or the admin server. It does not simulate Shopify pricing, product configuration or cart behavior.

```powershell
npm test
npm run build:frontend
npm run deploy
```

`npm test` runs the frontend DOM tests. `build:frontend` builds the extension bundle. `deploy` checks and rebuilds before releasing through Shopify CLI; see the [root publishing instructions](../README.md#publish) for release scope and version labels. Enable **Assistant icon** in the theme's **App embeds**, save and refresh. Admin hosting is separate.

## Ownership

| Location                                                 | Responsibility                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| [src/app.tsx](src/app.tsx), [src/main.tsx](src/main.tsx) | Assistant UI, memory router and custom-element lifecycle          |
| [src/styles.css](src/styles.css)                         | Styles isolated from the storefront                               |
| [src/navigation/shared/](src/navigation/shared)          | Common navigation, history, page loading and lifecycle contracts  |
| [src/navigation/themes/](src/navigation/themes)          | Concrete theme integration and selection by Shopify shop identity |
| [tests/](tests), [vite.config.ts](vite.config.ts)        | Fixture tests, local preview and extension build                  |

The memory router owns only assistant routes. The shared storefront navigator owns supported page changes: it fetches same-origin HTML, prepares assets/context and replaces `app-provider > main#main`, preserving Roman and the surrounding theme shell. Theme integrations supply their specific behavior. Keep credentials, persistence and privileged API calls in the separate [admin app](../admin/README.md).

Removing the embed disposes its React root, router, navigation listeners, pending work and layout styles. Theme-handled forms, modified clicks, unsupported destinations and normal reloads retain native behavior and can end the current assistant instance.

## Theme integrations

- [SelectBlinds and development](src/navigation/themes/selectblinds/README.md)
- [Blinds 2go UK](src/navigation/themes/blinds-2go-uk/README.md)
- [Blinds 2go Ireland](src/navigation/themes/blinds-2go-ie/README.md)

Keep supported stores/routes, integration requirements and investigation findings in the owning theme README. Share navigation and history behavior rather than copying it into theme folders. Discover assets from the current theme; do not pin generated theme IDs or asset hashes in application code.

Known cart and payment restrictions remain explicit in those READMEs. Unsupported integrations must fail before content replacement; evaluated scripts cannot be rolled back. Do not replay arbitrary inline scripts or hide conflicting custom-element registrations.

Ordinary script and stylesheet load failures or 15-second asset timeouts emit `[Roman]` console warnings and allow navigation after the remaining assets settle. There are no filename-specific skips; warnings include the asset origin/path without query parameters. Unsafe markup, unsupported integrations, incompatible cart components, observed script runtime errors and required payment-component readiness failures still stop navigation. Cancellation stays silent. A successful page swap does not guarantee every theme feature works.

## Verification

Run `npm run check` for the complete checks. For extension changes, rebuild the frontend and run `shopify app build` to include Theme Check. Tests use DOM fixtures and a simulated payment SDK; they do not prove live pricing, payments, analytics or voice continuity.

On each target theme, keep a note while exercising supported links, sidebar commands, Back/Forward, rapid navigation and request failures. Compare product options, measurements, pricing, galleries and cart behavior with normal navigation. Check keyboard focus, a 1280px desktop, a wider desktop and the mobile overlay; theme breakpoints still follow the full viewport.

Tailwind utilities that depend on `@property` need verification inside Shadow DOM, especially shadows, rings and transforms. The launcher uses explicit border/outline and box-shadow values.

The [theme extension](../extensions/vx-roman-ai-assistant) owns Liquid, translations and its deferred loader. Its generated `assets/roman-assistant.bundle.js` is excluded from Git; rebuild it before publishing and never edit it by hand.
