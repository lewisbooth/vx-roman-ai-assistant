# Roman AI Assistant

A customer assistant foundation for SelectBlinds and Blinds 2go stores. The current app demonstrates a 400px sidebar and storefront navigation that preserves its note and React instance. AI conversations, measuring assistance and home visualization are not implemented yet.

Two React Router apps with Tailwind CSS 4 share one npm installation and lockfile:

| Location                                                              | Owns                                                         | Runs on                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| [frontend/](frontend/README.md)                                       | Customer sidebar and theme navigation                        | Storefront browser; assets on Shopify CDN |
| [admin/](admin/README.md)                                             | Embedded admin console, authentication, webhooks and backend | One Azure VM for the proof of concept     |
| [extensions/vx-roman-ai-assistant/](extensions/vx-roman-ai-assistant) | Liquid app embed and asset loader                            | Shopify                                   |

Root `shared/` contains browser-safe code used by both apps; `prisma/` owns persistence and migrations. Prisma's `Session` stores Shopify authentication, separately from future customer conversations. AI credentials and privileged calls belong on the admin/backend server.

## Setup and development

Use Node.js 22 and npm from the repository root. Install Shopify CLI on your machine. In PowerShell, use `npm.cmd` if execution policy blocks the npm shim.

On first setup:

```powershell
npm ci
Copy-Item .env.example .env
npm run setup
```

Set `SHOPIFY_API_SECRET` in the root `.env` for admin development. Keep an existing `.env` when reinstalling. The customer preview needs neither Shopify credentials nor a database.

Start the apps in separate terminals:

```powershell
npm run dev:frontend
npm run dev:admin
```

The customer preview is at http://127.0.0.1:5173; the admin landing page is at http://localhost:3000. Embedded admin authentication needs public HTTPS; see the [admin setup](admin/README.md).

For stores eligible for Shopify CLI previews, `npm run dev` manages the tunnel and builds the extension once; run `npm run watch:frontend` alongside it for subsequent changes. For the existing `hd-dev-multi` installation, use the local preview and publish an app version to test on the store.

## Check and build

```powershell
npm run check
npm run build
```

`check` runs lint, TypeScript and frontend tests. `build` builds both apps. GitHub Actions runs these commands after `npm ci` on pushes and pull requests; it does not publish. Use `npm test`, `build:frontend` or `build:admin` for focused iteration.

Validate Shopify changes without publishing:

```powershell
shopify app config validate --json
npm run build:frontend
shopify app build
```

Shopify's build includes Theme Check. Generated `build/`, `.react-router/` and extension bundles are excluded from Git; rebuild them instead of editing them.

## Publish

```powershell
npm run deploy
```

This runs checks, rebuilds the frontend and releases Shopify configuration and extension assets. Use `npm run deploy -- --version vx-roman-ai-assistant-your-release` with a unique label for predictable release names. The Shopify display name remains **Roman AI Assistant**.

Enable **Assistant icon** under **App embeds** in the target theme, save and refresh the storefront. An app release reaches every store where this app is installed; a theme preview does not isolate it. Use a separate development app registration before experimenting with an app installed on production stores. Preserve the extension UID and `roman-assistant` block handle.

**Publish the admin/backend separately** using the [Azure VM and Docker instructions](admin/README.md). Shopify CLI does not host that server. Set `application_url` and `auth.redirect_urls` in `shopify.app.toml`, and the host's `SHOPIFY_APP_URL`, to the deployed HTTPS origin as documented there; the checked-in URLs remain `https://example.com`. Retain the database volume across deployments. Pushing to GitHub alone publishes neither app.

## Conventions and references

Read [AGENTS.md](AGENTS.md) before changing code. Keep React Router packages aligned and API versions consistent. The lockfile's `qs` and Prisma `deepmerge-ts` overrides address security fixes; remove them only when supported upstream dependencies include those fixes.

See [Shopify React Router](https://shopify.dev/docs/api/shopify-app-react-router), [theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration), [Shopify deployment](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) and [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite).
