# Roman AI Assistant frontend

The customer-facing app for Shopify storefronts, built with React Router and Tailwind CSS 4. It currently renders a circular **R** button fixed in the bottom-right corner; clicking it logs `Hello from Roman`.

## Develop and build

Run commands from the repository root, using the shared npm installation:

```powershell
npm run dev:frontend
```

Open http://127.0.0.1:5173 for the standalone preview. It runs the actual app without Shopify credentials or the admin server.

```powershell
npm run build:frontend
npm run deploy
```

`build:frontend` compiles the client for the theme extension. `deploy` performs the repository's checks and builds before publishing an app version through Shopify CLI. Enable **Assistant icon** in the target theme's **App embeds**, save, and refresh the storefront. Releasing an app version updates every store where that app is installed; see the [root README](../README.md) for the development and production workflow.

## Ownership

- `src/app.tsx`: customer UI and assistant routes.
- `src/main.tsx`: the `roman-ai-assistant` custom element, React root, and mount/unmount lifecycle.
- `src/styles.css`: Tailwind and styles scoped to this app.
- `index.html`: local preview shell, excluded from the Shopify bundle.
- `vite.config.ts`: local dev server and extension bundle build.

The memory router keeps assistant navigation independent of the shop's URL and browser history. React and its styles live inside a Shadow DOM so Tailwind's reset cannot alter the storefront theme. Removing the embed disposes its React root and router.

Tailwind 4's `@property` registrations are not reliable inside Shadow DOM. The launcher uses explicit solid border/outline utilities and an arbitrary `box-shadow` declaration to avoid that dependency. Check new utilities in the embedded app, especially shadows, rings, and transforms.

Shopify integration belongs in [`extensions/vx-roman-ai-assistant`](../extensions/vx-roman-ai-assistant). Its Liquid embed supplies translated labels and a deferred loader loads the client from Shopify's CDN. The generated `assets/roman-assistant.bundle.js` is build output: do not edit or commit it. Rebuild before publishing; a GitHub push alone does not deploy it.

The separate [admin app](../admin/README.md) owns merchant UI, Shopify authentication, webhooks, and server routes. Keep credentials and server-only code out of this app and `shared/`.
