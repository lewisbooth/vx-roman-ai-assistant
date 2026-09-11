# Admin console

The merchant-facing Roman AI Assistant console is a React Router framework app with Tailwind CSS 4 and Shopify Polaris web components. It owns Shopify authentication, embedded Admin pages, authenticated webhooks, and Prisma session storage. Future assistant server endpoints belong here; customer UI belongs in [`frontend/`](../frontend/README.md).

Run all commands from the repository root. Both apps share its package manifest and lockfile.

## Backend ownership

For the proof of concept, this server and its embedded admin UI run together on one Azure VM. Customer sidebar API routes also belong in this app, outside the merchant-only `/app` layout. They need their own customer/session authorization; storefront visitors do not have Shopify Admin sessions. Keep AI clients and data-access logic in server-only modules, with browser-safe request/response types shared only when needed.

Prisma's existing `Session` model is reserved for Shopify authentication. Future customer conversations, generation jobs, and usage records need separate models scoped to the relevant shop and customer or anonymous session. The admin console will read those records through authenticated routes. Store OpenAI API keys in the server's environment or secret store; the admin UI can show connection status without returning the keys.

AI endpoints, file storage, conversation recording, and metrics are future features. Add their configuration and dependencies with the first working feature rather than creating unused placeholders now.

## Local development

Follow the [root setup](../README.md) to install dependencies and create the root `.env`. Set `SHOPIFY_API_SECRET` to the existing app's secret and use `SHOPIFY_APP_URL=http://localhost:3000` for the local landing page.

```powershell
npm run setup
npm run dev:admin
```

Open http://localhost:3000. Embedded authentication requires a public HTTPS URL reachable by Shopify. For `hd-dev-multi`, expose port 3000 through a development tunnel, set `SHOPIFY_APP_URL` in `.env` to that HTTPS origin, update the Shopify app URLs as described below, and restart the server. Local development also uses port 64999 for HMR; a remote development URL must route WebSocket requests to the HMR port (8002 by default, configurable with `FRONTEND_PORT`).

On stores eligible for Shopify CLI development previews, `npm run dev` manages the tunnel and app URLs. See the root README for the separate storefront watcher.

`routes/app.tsx` authenticates the embedded layout. Each new protected loader or action must also call `authenticate.admin(request)` because React Router executes route handlers independently. Keep credentials and privileged API calls in `.server.ts` files. Use the authenticated `session.shop` as the store identifier.

## Build and publish

```powershell
npm run check
npm run build:admin
```

The build and type check explicitly generate Prisma's client from the schema; they do not depend on npm's install hooks. The production server is `build/server/index.js`; its client assets are in `build/client/`. Publish this app to a Node.js host. Shopify's extension deployment does not host this server.

The included Dockerfile packages the server for the Azure VM. Run these commands on that VM from a checkout of the repository, with a private environment file containing the deployment values:

```powershell
docker build -t roman-ai-admin .
docker run --name roman-ai-admin --restart unless-stopped -d -p 127.0.0.1:3000:3000 --mount source=roman-ai-data,target=/data --env-file .env -e NODE_ENV=production -e DATABASE_URL=file:/data/roman.sqlite roman-ai-admin
```

Put the container behind the VM's HTTPS reverse proxy and restrict direct access to port 3000. Supply `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, and `DATABASE_URL` through that host's environment or a private environment file. Set `SHOPIFY_APP_URL` to the public HTTPS origin before starting it. The command above overrides the local SQLite path so the database persists in the named volume; use one server instance with SQLite. Startup applies Prisma migrations. Preserve and back up the database volume across releases; future uploaded/generated files also need persistent storage outside the container's writable layer.

Set `application_url` in `shopify.app.toml` to the same public HTTPS origin and `auth.redirect_urls` to that origin followed by `/auth/callback`. Release these Shopify configuration changes separately:

```powershell
npm run deploy
```

This releases configuration and the storefront extension to every store with this Shopify app installed. It does not update the running admin container. Publish admin changes by building and replacing the container on your host while retaining its database volume. Pushing source code to GitHub alone publishes neither app.

## References

- [Shopify React Router authentication](https://shopify.dev/docs/api/shopify-app-react-router/v1/authenticate/admin)
- [Deploy a Shopify app to a hosting service](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service)
