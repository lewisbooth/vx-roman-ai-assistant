# Roman AI Assistant

The foundation for a customer assistant on SelectBlinds (`selectblinds.com`) and Blinds 2go (`shop.blinds-2go.co.uk`): product selection, measuring, fitting, and visualization in home photos. Today, the customer app displays a small circular **R** button and logs `Hello from Roman` when clicked. The separate admin console provides an authenticated app home and a link to enable the theme embed.

Two React Router apps, both with Tailwind CSS 4, share one npm installation and lockfile:

| Location                            | Responsibility                                                    | Published to                            |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| [`frontend/`](frontend/README.md)   | Customer UI, memory router, isolated Tailwind styles              | Shopify CDN through the theme extension |
| [`admin/`](admin/README.md)         | Merchant console, Shopify authentication, webhooks, server routes | Azure VM for the proof of concept       |
| `extensions/vx-roman-ai-assistant/` | Liquid app embed, translations, small deferred loader             | Shopify                                 |
| `shared/`                           | Browser-safe values used by both apps                             | Included by each build                  |
| `prisma/`                           | Session schema and migrations                                     | Admin host                              |

These are separate UI applications within one Shopify app registration. Store identity comes from Shopify; production domains are not hardcoded into the client. The existing app client ID, extension UID, and `roman-assistant` embed handle are preserved.

## Proof-of-concept architecture

One Azure VM runs the admin console and customer-facing backend together as a single React Router server. Shopify displays our custom admin pages inside its Admin app area; customers use the separate theme-embedded frontend. The admin browser page is a view onto backend data, not the owner of running customer sessions.

The planned backend will authorize GPT-Live connections, call text/image models, persist customer conversations, and record usage for the admin dashboard. OpenAI credentials belong in server-side secret configuration and must never be sent to either browser app. These AI features are not implemented yet.

The current Prisma `Session` model stores Shopify authentication only. Customer conversations will use separate models when implemented, scoped to their store and customer or anonymous session. Files will use persistent file/object storage, with ownership and file references in the database. The current SQLite database can remain for the single-instance proof of concept on a persistent volume; moving to a managed database is a separate schema and migration change.

## Setup

Use Node.js 22 and npm. Install Shopify CLI on your development machine; agent tooling also stays outside this repo.

```powershell
npm ci
Copy-Item .env.example .env
npm run setup
```

Copy the environment file only on first setup. Fill in `SHOPIFY_API_SECRET` from the existing app's Dev Dashboard when using the admin server. The local SQLite path is relative to `prisma/schema.prisma`. The customer preview needs no Shopify credentials or database.

## Develop

Run commands from the repository root, in separate terminals as needed:

```powershell
npm run dev:frontend
npm run dev:admin
```

- Customer preview: http://127.0.0.1:5173
- Admin landing page: http://localhost:3000

Embedded admin authentication needs a public HTTPS URL configured on the Shopify app. See the [admin README](admin/README.md) for that setup and hosting.

On a store eligible for Shopify CLI development previews, `npm run dev` manages the admin tunnel and builds the extension once. Run `npm run watch:frontend` alongside it to rebuild the customer bundle on edits. For the existing `hd-dev-multi` installation, use local previews and publish a version to test the theme embed; that store was not eligible for this CLI's `app dev` flow.

## Check, build, and publish

```powershell
npm run check
npm run build
```

`check` runs ESLint and TypeScript for both apps. `build` builds the customer bundle and admin server. GitHub Actions runs these commands after `npm ci` on pushes and pull requests. It does not publish automatically.

```powershell
npm run deploy
```

`deploy` runs checks, rebuilds the customer bundle, then calls `shopify app deploy`. Shopify CLI builds the admin using `shopify.web.toml`, validates the extension, and releases Shopify configuration and extensions. It **does not upload the admin server**. Review the CLI's release summary before publishing.

In the store's theme editor, enable **Assistant icon** under **App embeds**, save, and refresh the storefront. Existing enabled embeds retain their identity. A released version reaches every store where this Shopify app is installed: use a development app registration for ongoing experiments once production stores use the app. A theme preview alone does not isolate an app release.

For validation without publishing:

```powershell
shopify app config validate --json
npm run build:frontend
shopify app build
```

Shopify's build also runs Theme Check. Always rebuild the frontend before invoking Shopify CLI directly. Its generated `extensions/vx-roman-ai-assistant/assets/roman-assistant.bundle.js` is excluded from Git; do not edit or commit it. Admin output is generated in `build/`.

Publish the admin separately to the Azure VM using the Docker build/run instructions in [`admin/README.md`](admin/README.md). `application_url` in `shopify.app.toml` is the address Shopify opens for the embedded admin app. It is still `https://example.com` until the VM's public HTTPS hostname is configured. Set it, `auth.redirect_urls`, and the host's `SHOPIFY_APP_URL` to the deployed admin origin as documented there. Pushing to GitHub alone publishes neither app.

## Project conventions

Read [AGENTS.md](AGENTS.md) before changing code. Keep customer code browser-only and privileged Shopify calls in the admin server. React Router packages are pinned together at `7.18.2`; update them as a set after checking Shopify compatibility. The Admin and webhook APIs use `2026-07`. No Admin API scopes are requested until a feature needs them.

The lockfile includes security overrides for `qs` and Prisma's `deepmerge-ts` dependency. The latter addresses [GHSA-ggr8-5vv4-36mx](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx) while retaining Prisma 6; remove the override when Prisma's supported dependency includes the fix.

## References

- [Shopify React Router](https://shopify.dev/docs/api/shopify-app-react-router)
- [Theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)
- [Shopify app deployment](https://shopify.dev/docs/api/shopify-cli/app/app-deploy)
- [Tailwind CSS with Vite](https://tailwindcss.com/docs/installation/using-vite)
