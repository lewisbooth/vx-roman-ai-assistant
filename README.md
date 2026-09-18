# Roman AI Assistant

A customer assistant foundation for SelectBlinds and Blinds 2go stores. A compact Ask Roman launcher beside the header search bar opens a fullscreen shopping experience, loads the React app on demand and preserves its instance across successful in-place storefront navigation. Normal page loads restore its open/closed state for the current tab. Development stores have a [tool drawer](frontend/README.md#developer-tools) for live catalog search/lookup, theme-owned cart actions and persistent measurement drafts. Customer conversations combine Terra text chat, GPT-Live voice captions, selected product cards, PDF-grounded measuring with numeric inputs, fitting guidance and a browsing timeline. Both modes can search, navigate, save product measurements and add the chosen product after one concise conversational configuration review, without another approval panel. Removal, quantity changes and clearing the cart retain shopper review. Confirmed Roman navigation and cart additions appear as centered plain-text events; manual page visits stay quiet model context; additions include submitted dimensions when available. The [embedded admin](admin/README.md#conversation-inspection-and-usage) shows this store's sessions, transcripts, recorded usage and estimated costs from dated model rates. Home visualization remains a later phase.

Home tiles start a conversation about measuring, style, no-drill products or future visualization. Roman can select supported PDP options, enter confirmed dimensions in mm/cm/in, offer the available measurement guarantee with its native terms and price, and use the theme's separate free-sample control. Product and sample additions remain distinct; unsupported customization controls stay with the theme.

Two React Router apps with Tailwind CSS 4 share one npm installation and lockfile:

| Location                                                              | Owns                                                         | Runs on                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| [frontend/](frontend/README.md)                                       | Customer experience and theme navigation                        | Storefront browser; assets on Shopify CDN |
| [admin/](admin/README.md)                                             | Embedded admin console, authentication, webhooks and backend | Local Docker; same image on Azure later   |
| [extensions/vx-roman-ai-assistant/](extensions/vx-roman-ai-assistant) | Liquid app embed and asset loader                            | Shopify                                   |

Root `shared/` contains browser-safe code used by both apps; `prisma/` owns persistence and migrations. Prisma's `Session` stores Shopify authentication; separate conversation and voice models persist customer chat and captions. AI credentials and privileged calls belong on the admin/backend server. OpenAI hosts the models; browser voice audio travels directly over WebRTC. Roman stores captions, not audio. Opening Roman attempts voice by default, subject to microphone permission; ending voice opts into text for this tab. In-place navigation, internal Chat/Cart/Gallery views and closing the assistant retain an active connection.

## Setup and development

Use Node.js 22 and npm from the repository root. Install Shopify CLI and Docker Desktop with Linux containers. In PowerShell, use `npm.cmd` if execution policy blocks the npm shim.

On first setup:

```powershell
npm ci
Copy-Item .env.example .env
```

Set `SHOPIFY_API_SECRET`, `OPENAI_API_KEY` and `SCOPES=write_app_proxy` in the root `.env` for chat development. Keep an existing `.env` when reinstalling. The customer preview needs neither Shopify credentials nor a database.

Build and start the backend, then start the customer preview:

```powershell
docker compose up --build -d
npm run dev:frontend
```

The customer preview is at http://127.0.0.1:5173; the admin defaults to http://localhost:3000. If that port is occupied, set `ROMAN_ADMIN_PORT=3100` and the matching local `SHOPIFY_APP_URL` in `.env`. Docker applies migrations and keeps SQLite in the `roman-ai-data` volume. Use `docker compose logs -f admin` for logs and `docker compose down` to stop; the volume is retained. See [admin setup](admin/README.md) for embedding the local server in Shopify through HTTPS and for native hot reload.

For stores eligible for Shopify CLI previews, `npm run dev` manages the tunnel and builds the extension once; run `npm run watch:frontend` alongside it for subsequent changes. For the existing `hd-dev-multi` and `hd-dev-single` installations, use the local preview and publish an app version to test on the stores. Each store has its own [navigation profile](frontend/README.md#theme-integrations).

## Check and build

```powershell
npm run check
npm run build
```

`check` runs lint, TypeScript and frontend/backend tests. `build` builds both apps. GitHub Actions runs these commands after `npm ci` on pushes and pull requests; it does not publish. Use `npm test`, `build:frontend` or `build:admin` for focused iteration.

Validate Shopify changes without publishing:

```powershell
shopify app config validate --json
npm run build:frontend
shopify app build
```

Shopify's build includes Theme Check. Generated `build/`, `.react-router/`, extension bundles and copied design assets are excluded from Git; rebuild them instead of editing them. `build:frontend` produces both the small launcher and the lazy React bundle.

## Publish

```powershell
npm run deploy
```

This runs checks, rebuilds the frontend and releases Shopify configuration and extension assets. Use `npm run deploy -- --version vx-roman-ai-assistant-your-release` with a unique label for predictable release names. The Shopify display name remains **Roman AI Assistant**.

After adding the app-proxy scope, open Roman in each development store's Shopify admin and approve the updated permissions. Enable **Assistant icon** under **App embeds** in the target theme, save and refresh the storefront. An app release reaches every store where this app is installed; a theme preview does not isolate it. Use a separate development app registration before experimenting with an app installed on production stores. Preserve the extension UID and `roman-assistant` block handle.

**Run the admin/backend separately** using the [Docker instructions](admin/README.md). It runs locally now; the same image can run on one Azure VM later. Shopify CLI does not host that server. Local Docker development uses an HTTPS tunnel, matching `SHOPIFY_APP_URL` in `.env`, and ignored `shopify.app.local.toml` selected with `shopify app config use local`. Publish that configuration explicitly with `npm run deploy -- --config local`; keep Docker and the tunnel running while using the embedded admin. The checked-in `shopify.app.toml` retains placeholder URLs until a stable host is available. Retain the database volume across deployments. Pushing to GitHub alone publishes neither app.

### Roll back the fullscreen experiment

The refinement starting point is also preserved: source tag `roman-before-fullscreen-refinement-20260918` (`937c303`), Docker image `roman-ai-admin:before-fullscreen-refinement-20260918`, and Shopify version `vx-roman-ai-assistant-20260917-fullscreen`. Use these names in the commands below to restore the first fullscreen demo instead of the older sidebar.

The source tag `roman-before-fullscreen-20260917` preserves the previous assistant at `4029e35`. The previous Docker image is retained locally as `roman-ai-admin:before-fullscreen-20260917`. No database schema changed; retain the current volume and customer conversations.

To restore the previous UI and backend, with no active voice or pending tool work:

```powershell
shopify app release --config local --version vx-roman-ai-assistant-20260917-support-approval --allow-updates
docker image tag roman-ai-admin:before-fullscreen-20260917 roman-ai-admin:latest
docker compose up -d --no-build admin
```

The release restores the previous extension on every installed store. Refresh the storefront afterward. Do not rebuild the new checkout during that rollback: it would replace the tagged backend. Use a checkout/worktree at the source tag if source rollback is also needed. Do not restore an older database over newer customer conversations.

## Conventions and references

Read [AGENTS.md](AGENTS.md) before changing code. Keep React Router packages aligned and API versions consistent. The lockfile's `qs` and Prisma `deepmerge-ts` overrides address security fixes; remove them only when supported upstream dependencies include those fixes.

See [Shopify React Router](https://shopify.dev/docs/api/shopify-app-react-router), [theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration), [Shopify deployment](https://shopify.dev/docs/api/shopify-cli/app/app-deploy) and [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite).
