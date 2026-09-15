# Admin console

The Roman backend is a React Router framework app with a separate embedded admin console, Tailwind CSS 4 and Shopify Polaris web components. It owns Shopify authentication, webhooks, customer conversation APIs and persistence. Customer UI belongs in [`frontend/`](../frontend/README.md).

Run all commands from the repository root. Both apps share its package manifest and lockfile.

## Backend ownership

This server and its embedded admin UI run together locally in Docker for now; the same image can run on one Azure VM later. Customer sidebar API routes also belong in this app, outside the merchant-only `/app` layout. They need their own customer/session authorization; storefront visitors do not have Shopify Admin sessions. Keep AI clients and data-access logic in server-only modules, with browser-safe request/response types shared only when needed.

Prisma's `Session` model stores Shopify authentication. Separate `Conversation` and `ConversationMessage` models store anonymous shop-scoped chat, ordered messages, completion state and actual model/service tier. SQLite lives in the Docker volume, independently of the image. Transcripts survive app uninstall; authorization stops when the offline installation or required scope is removed.

## Text conversations

Text chat connects `gpt-5.6-luna` through the Responses API with `service_tier: "fast"`, low reasoning and `store: false`. OpenAI currently reports Fast responses as `priority`; the actual returned tier is persisted. Set `OPENAI_API_KEY` in the private root `.env`. Docker must be recreated after environment changes. Roman's database is the conversation source of truth; provider conversation IDs are not used.

Roman's prompt requests concise Markdown and product-name links copied from catalog results. The frontend renders that Markdown safely; the database retains the original text. Prompt changes require rebuilding the backend container.

| Module                                           | Owns                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `conversations/prompt.server.ts`                 | Roman's shop-at-home advisor character and current capability boundaries   |
| `conversations/model.server.ts`                  | OpenAI request and streamed text extraction                                |
| `conversations/runner.server.ts`                 | One active turn per conversation, bounded generation and partial snapshots |
| `conversations/repository.server.ts`             | Durable ordering, idempotency, credential hashes and restart recovery      |
| `conversations/auth.server.ts`, `http.server.ts` | Shopify signature, bearer/origin authorization and bounded HTTP inputs (32 KiB normally, 128 KiB for projected tool results)     |

The first message bootstraps through Shopify's signed `/apps/roman/bootstrap` proxy. It requires an installed offline session and approved `write_app_proxy` scope. Only `hd-dev-single` and `hd-dev-multi` are enabled in this phase. Subsequent `/api/conversations/:id` reads and `/messages` submissions require a random conversation bearer credential and the exact authorized storefront origin. Credentials expire after seven days; the frontend keeps them in tab-scoped storage. CORS does not replace bearer authorization, and localhost has no authentication bypass.

Generation continues if the browser disconnects. Request UUIDs deduplicate submissions; a restart marks unfinished replies failed instead of replaying them. The browser polls partial snapshots while a reply is pending because Cloudflare Quick Tunnels do not support SSE. Limits are 4 concurrent replies, 90 seconds per reply, 4,000 input characters, 40 turns per conversation, 20 new conversations per shop per 10 minutes and 100 per day. These are development bounds, not a production abuse-control service.

Luna can call `search_products`, `get_product`, `lookup_catalog` and `navigate`. Root `shared/catalog-tools.ts` and `shared/navigation-tool.ts` define their schemas and validation; `conversations/browser-tools.server.ts` waits for the authenticated storefront executor. The browser uses its existing Shopify login and MCP transport. Each durable `ToolInvocation` has one atomic browser claim; late or mismatched results are rejected, and reload/restart never silently replays an invocation. A browser action has a 45-second deadline; each model turn permits at most four actions. Navigation accepts a current-storefront path when the customer asks to visit it. A full-page handoff can lose confirmation; it is never automatically replayed.

Catalog results are transient and do not create widgets. The server-local `show_products` tool selects one ordered set of up to six products returned by successful catalog calls in the current turn. `conversations/presentation.server.ts` validates the selection; the repository saves its completed invocation and widget atomically with the final successful reply. The tool is visible from the start of a reply; Roman refreshes catalog data before selecting cards. Explicit carousel requests, including repeats, take precedence over avoiding unsolicited cards during price checks and measurement clarification. Durable product widgets store only IDs and resolve current details when rendered; merchant images load directly from their URLs. `ConversationMessage.partsJson` stores typed text, product references and page views. Voice captions join these in one ordered snapshot. Server sequence/revision govern ordering; provider and page timestamps are observations, not ordering authority. Public journey paths exclude URL query/hash and account/checkout routes. Each conversation permits 200 page views. End chat closes voice, cancels generation, rejects later writes and retains its transcript.

Cart/measurement model tools, photo uploads/visualization and the session dashboard remain subsequent phases. Catalog matches do not establish fitting suitability, stock or a configured quote.

The [frontend tool drawer](../frontend/README.md#developer-tools) executes public catalog calls and browser-owned cart/navigation actions directly. It needs no admin server. Keep browser actions at their current owner and return their results to the conversation runner.

## Voice conversations

`voice/provider.server.ts` creates native [GPT-Live-1 sessions](https://developers.openai.com/api/docs/guides/live) with `store: false`, WebRTC and client delegation. It uses the same private `OPENAI_API_KEY` as Luna. OpenAI hosts both models; Docker needs no GPU or model weights. Browser audio goes directly to OpenAI. A trusted server sideband receives captions and delegation events; browser requests cannot upload captions or invoke model tools through that connection.

The sideband also reflects raw audio packets, which Roman discards before validating caption/control events; reflected audio has no server event ID. A rejected event logs its type and failing field without audio, transcript text or identifiers. Check Docker logs when voice creation succeeds but the connection then ends.

`voice/service.server.ts` owns connection lifetime, bounded queues, cancellation and delegation to the existing Luna runner. Only explicit provider delegation triggers work; caption pauses do not. Luna receives the combined history and returns a brief answer to the voice advisor, while selected cards persist inline without a duplicate text reply. A new delegation cancels unfinished earlier work. Already handed-off navigation cannot be undone. Page observations quietly update voice context without fabricating customer messages.

`voice/repository.server.ts` owns `VoiceSession` leases and exact `VoiceTranscript` fragments. The conversation repository groups captions for display and merges them with text, page visits and widgets using one server sequence. Captions are transcription observations, not proof the customer heard every word. Initial GPT-Live context is a bounded recent extract; the full persisted conversation remains available to Luna and later text turns. Raw audio is never stored by Roman.

Authenticated `POST /api/conversations/:id/voice` accepts `{requestId, clientId, sdp}` and returns `{voiceId, sdp}`. `/voice/:voiceId/heartbeat` and `/stop` accept `{clientId}`. SDP input is limited to 48 KiB within a 64 KiB JSON body. These routes use the same conversation bearer and storefront-origin checks as text, outside merchant admin authentication.

The browser starts its microphone only on request, renews a 45-second lease every 20 seconds, and polls while voice is active. After native session startup, the server requests one brief spoken greeting or a relevant follow-up to the supplied conversation, then asks Roman to listen. This uses acknowledged Live instructions/commentary; only actual captions enter the transcript. Retries and repeated startup events do not repeat the opening. Limits are four live connections per server, ten connections and 1,200 caption fragments / 60,000 caption characters per conversation, and ten minutes per connection. Stop drains final captions before switching to text. A lost browser, expired lease or server restart ends the connection; restoring chat never reopens the microphone. Native audio persists through successful in-place navigation, but a full reload requires Start voice again. The sidebar exposes mute/stop controls while collapsed.

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
