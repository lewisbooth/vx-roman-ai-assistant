# Admin console

The merchant-facing Roman AI Assistant console is a React Router framework app with Tailwind CSS 4 and Shopify Polaris web components. It owns Shopify authentication, embedded Admin pages, authenticated webhooks, and Prisma session storage. Future assistant server endpoints belong here; customer UI belongs in [`frontend/`](../frontend/README.md).

Run all commands from the repository root. Both apps share its package manifest and lockfile.

## Backend ownership

This server and its embedded admin UI run together locally in Docker for now; the same image can run on one Azure VM later. Customer sidebar API routes also belong in this app, outside the merchant-only `/app` layout. They need their own customer/session authorization; storefront visitors do not have Shopify Admin sessions. Keep AI clients and data-access logic in server-only modules, with browser-safe request/response types shared only when needed.

Prisma's existing `Session` model is reserved for Shopify authentication. Future customer conversations, generation jobs, and usage records need separate models scoped to the relevant shop and customer or anonymous session. The admin console will read those records through authenticated routes. Store OpenAI API keys in the server's environment or secret store; the admin UI can show connection status without returning the keys.

AI endpoints, file storage, conversation recording, and metrics are future features. Add their configuration and dependencies with the first working feature rather than creating unused placeholders now.

The [frontend tool drawer](../frontend/README.md#developer-tools) currently executes public catalog calls and browser-owned cart/navigation actions directly. It needs no admin server. When voice is added, this backend will create [GPT-Live-1 sessions](https://developers.openai.com/api/reference/typescript/resources/live/methods/create) using a server-only OpenAI key; the browser will carry audio over WebRTC to OpenAI. A [server sideband connection](https://developers.openai.com/api/reference/resources/live/sideband-websocket) can handle session events and delegated work. OpenAI hosts the model; Docker hosts Roman's application, authorization and persistence, with no model weights or GPU required. Keep browser actions at their current owner and return their results to the server; put privileged tools and future model orchestration in server-only modules here. Add shared tool contracts only when both apps consume them.

## Local Docker backend

Install Docker Desktop with Linux containers and follow the [root setup](../README.md) to create `.env`. Supply the existing app's `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`; `SCOPES` must match its configured scopes. Use `SHOPIFY_APP_URL=http://localhost:3000` for the local landing page. If port 3000 is occupied, add `ROMAN_ADMIN_PORT=3100` and use `SHOPIFY_APP_URL=http://localhost:3100`. Keep this file private; Docker excludes it from the image and Compose supplies it at runtime.

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose logs -f admin
```

Open localhost on the chosen port. The production-style container binds only to `127.0.0.1` (host port 3000 by default; container port always 3000) and applies Prisma migrations at startup. Compose overrides `.env`'s development database path with `file:/data/roman.sqlite` in the durable `roman-ai-data` volume. Use one server instance with SQLite. Preserve and back up this volume; future uploaded/generated files also need persistent storage outside the container's writable layer.

After code or environment changes, run `docker compose up --build -d`. Stop with `docker compose down`; the named volume remains. Docker does not provide source hot reload in this setup.

The installed embedded app needs a configured HTTPS URL; setting `.env` alone does not change the URL Shopify opens. Connect this Docker backend with [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) and the chosen host port (3100 here):

```powershell
cloudflared tunnel --url http://127.0.0.1:3100 --no-autoupdate
```

Install `cloudflared` on your machine, or use this checkout's downloaded `.agents/cloudflared.exe` in that command. Keep it running; Ctrl+C stops a foreground tunnel. Its random HTTPS URL changes after restarting. Set `SHOPIFY_APP_URL` in `.env` to the returned origin, update and release the local Shopify configuration below, and recreate Docker with `docker compose up -d admin`. Both Docker and the tunnel must run while using the installed app. Shopify webhooks use the same public endpoint; this container needs no HMR tunnel.

## Native hot reload

As an alternative to Docker, stop its container and run:

```powershell
npm run setup
npm run dev:admin
```

This uses the root `.env` and its local SQLite path. Local HMR uses port 64999; a remote development URL must route WebSocket requests to the HMR port (8002 by default, configurable with `FRONTEND_PORT`). On stores eligible for Shopify CLI previews, `npm run dev` manages the tunnel and app URLs. `npm run dev -- --use-localhost` instead uses a locally trusted HTTPS proxy and updates only the selected store's dev preview; webhooks cannot reach that localhost endpoint. The CLI currently rejects `hd-dev-single` as an eligible store, so this mode does not resolve that installation's URL. See the root README for the separate storefront watcher.

Each protected loader or action must call `authenticate.admin(request)`; authentication in `routes/app.tsx` does not protect parallel route handlers. Keep credentials and privileged API calls in `.server.ts` files and use the authenticated `session.shop` as the store identifier.

## Build and Shopify configuration

```powershell
npm run check
npm run build:admin
```

The build and type check explicitly generate Prisma's client from the schema; they do not depend on npm's install hooks. The production server is `build/server/index.js`; its client assets are in `build/client/`. Publish this app to a Node.js host. Shopify's extension deployment does not host this server.

For a later Azure VM deployment, use the same Dockerfile and Compose service with a private `.env`, a public HTTPS reverse proxy to the chosen localhost port, and a persistent database volume. Transfer the database deliberately when moving hosts; a volume on the local machine does not move with the image.

Keep temporary tunnel URLs in the ignored `shopify.app.local.toml`, copied from `shopify.app.toml` on first setup. Preserve the app identity and other configuration. Set `application_url` to the same public HTTPS origin as `.env` and `auth.redirect_urls` to that origin followed by `/auth/callback`. Whenever the tunnel URL changes, update both files and release the local configuration:

```powershell
shopify app config use local
shopify app config validate --config local --json
npm run deploy -- --config local
```

`config use local` selects the default for subsequent CLI commands on this machine; passing `--config local` makes the release target explicit. This releases configuration and the storefront extension to every store with this Shopify app installed. It does not update the running admin container. Rebuild and recreate that container separately while retaining its database volume. The checked-in base configuration still has placeholder URLs; use a stable hosted origin there when deploying to Azure. Pushing source code to GitHub alone publishes neither app.

## References

- [Shopify React Router authentication](https://shopify.dev/docs/api/shopify-app-react-router/v1/authenticate/admin)
- [Deploy a Shopify app to a hosting service](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service)
- [Shopify development networking](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options)
- [Compose environment files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/), [named volumes](https://docs.docker.com/reference/compose-file/volumes/) and [stopping services](https://docs.docker.com/reference/cli/docker/compose/down/)
