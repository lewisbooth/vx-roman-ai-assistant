# Admin console

The Roman backend is a React Router framework app with a separate embedded admin console, Tailwind CSS 4 and Shopify Polaris web components. It owns Shopify authentication, webhooks, customer conversation APIs and persistence. Customer UI belongs in [`frontend/`](../frontend/README.md).

Run all commands from the repository root. Both apps share its package manifest and lockfile.

## Backend ownership

This server and its embedded admin UI run together locally in Docker for now; the same image can run on one Azure VM later. Customer sidebar API routes also belong in this app, outside the merchant-only `/app` layout. They need their own customer/session authorization; storefront visitors do not have Shopify Admin sessions. Keep AI clients and data-access logic in server-only modules, with browser-safe request/response types shared only when needed.

Prisma's `Session` model stores Shopify authentication. Separate `Conversation` and `ConversationMessage` models store anonymous shop-scoped chat, ordered messages, completion state and actual model/service tier. SQLite lives in the Docker volume, independently of the image. Transcripts survive app uninstall; authorization stops when the offline installation or required scope is removed.

## Text conversations

Text chat connects `gpt-5.6-terra` through the Responses API with `service_tier: "fast"`, medium reasoning and `store: false`. OpenAI currently reports Fast responses as `priority`; the actual returned tier is persisted. Set `OPENAI_API_KEY` in the private root `.env`. Docker must be recreated after environment changes. Roman's database is the conversation source of truth; provider conversation IDs are not used.

[`prompts/shared.server.ts`](prompts/shared.server.ts) owns Roman's character, welcome and shared backend business/tool rules. [`prompts/text.server.ts`](prompts/text.server.ts) adds text greetings, Markdown and verified product links. [`prompts/voice.server.ts`](prompts/voice.server.ts) owns GPT-Live's speech, delegation and opening instructions, plus Terra's separate factual voice-briefing format. The voice backend uses the shared rules without inheriting text greetings or Markdown instructions. `ROMAN_PREAMBLE` supplies the welcome for new voice conversations and text greetings; it advertises only current capabilities. A specific initial text request gets a short introduction and a relevant answer, while resumed conversations pick up the customer's topic. The frontend renders text safely; the database retains the original text. Prompt changes require rebuilding the backend container and restarting any active voice connection.

| Module                                           | Owns                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `prompts/shared.server.ts`                       | Shared character, welcome and backend business/tool rules                                                                    |
| `prompts/text.server.ts`                         | Text advisor composition, greeting and chat presentation                                                                     |
| `prompts/voice.server.ts`                        | Live speech/delegation/opening and the backend voice-briefing contract                                                        |
| `conversations/model.server.ts`                  | OpenAI request and streamed text extraction                                                                                  |
| `conversations/runner.server.ts`                 | One active turn per conversation, bounded generation and partial snapshots                                                   |
| `conversations/repository.server.ts`             | Durable ordering, idempotency, credential hashes and restart recovery                                                        |
| `conversations/auth.server.ts`, `http.server.ts` | Shopify signature, bearer/origin authorization and bounded HTTP inputs (32 KiB normally, 128 KiB for projected tool results) |

The first message bootstraps through Shopify's signed `/apps/roman/bootstrap` proxy. It requires an installed offline session and approved `write_app_proxy` scope. Root `shared/storefronts.ts` maps the two enabled permanent shop identities to exact storefront origins, including `https://shopify-single-dev.hdecom.com`. The browser includes `storefront_origin` in the proxy query; after signature verification it must belong to the authenticated shop and match any Origin header. Subsequent requests require a random conversation bearer and that conversation's exact saved origin. Credentials expire after seven days and stay in tab-scoped storage. Changing storefront domains starts fresh browser state; historical sessions remain in admin. CORS does not replace authorization, and localhost has no bypass.

Generation continues if the browser disconnects. Request UUIDs deduplicate submissions; a restart marks unfinished replies failed instead of replaying them. The browser polls partial snapshots while a reply is pending because Cloudflare Quick Tunnels do not support SSE. Limits are 4 concurrent replies, 90 seconds per reply, 4,000 input characters, 40 turns per conversation, 20 new conversations per shop per 10 minutes and 100 per day. These are development bounds, not a production abuse-control service.

Terra can call `search_products`, `get_product`, `lookup_catalog` and `navigate`. Root `shared/catalog-tools.ts` and `shared/navigation-tool.ts` define their schemas and validation; `conversations/browser-tools.server.ts` waits for the authenticated storefront executor. The browser uses its existing Shopify login and MCP transport. Each durable `ToolInvocation` has one atomic browser claim; late or mismatched results are rejected, and reload/restart never silently replays an invocation. A browser action has a 45-second deadline; each model turn permits at most four actions. Roman navigates on request or proactively opens a clearly chosen product's verified PDP when that helps the next step. It respects stay-in-chat preferences and avoids reopening the current PDP; a lone search result is not a selection. A full-page handoff can lose confirmation; it is never automatically replayed.

Catalog results are transient and do not create widgets. The server-local `show_products` tool selects one ordered set of up to six products returned by successful catalog calls in the current turn. `conversations/presentation.server.ts` validates the selection; the repository saves its completed invocation and widget atomically with the final successful reply. The tool is visible from the start of a reply; Roman refreshes catalog data before selecting cards. Explicit carousel requests, including repeats, take precedence over avoiding unsolicited cards during price checks and measurement clarification. Durable product widgets store only IDs and resolve current details when rendered; merchant images load directly from their URLs. `ConversationMessage.partsJson` stores typed text, product references, guide links and page views. `get_product_guides` reads only the current PDP's product-owned measuring/fitting links; `show_guides` selects up to two kinds from successful results in this reply. The server rejects model-authored URLs and enforces the conversation's storefront origin and versioned Shopify CDN PDF path. Selected links are saved atomically with a successful reply and share product widgets' voice ordering. These are store-linked references, not a claim that Roman has read the PDF or verified a fitting method. Voice captions join these in one ordered snapshot. Server sequence/revision anchor conversation events; voice fragments use the caption projection described below. Page timestamps never reorder events. Public journey paths exclude URL query/hash and account/checkout routes. Each conversation permits 200 page views. These manual observations remain available to the model and admin, but are hidden from the customer transcript. A successful claimed `navigate` outcome atomically creates a separate `navigation` notification, including its actual page title and pathname without query/hash. Failed, cancelled and repeated result deliveries create no extra notification. End chat closes voice, cancels generation, rejects later writes and retains its transcript.

The server-local `ask_question` tool adds one follow-up beneath the reply's other widgets, with one to four short answers (usually two or three). It persists the question and original options with the successful reply. Choosing an answer submits ordinary customer text; typing or speaking also retires the choices, while the question remains in the transcript. Admin inspection retains the original options as read-only history. Recommendations use a brief overview and product cards instead of a duplicate product list; the question tool supports the next useful decision without replacing cart or measurement confirmation rules. After a successful question tool call, text and voice overviews omit an ending question; the widget owns that follow-up. Roman reads it aloud if the customer asks.

Cart and measurement tools share the text runner used by voice delegation. `get_cart` reads the current storefront basket. On the shopper's request, `add_to_cart` uses an ordinary one-use claim to submit the chosen, configured current product without another approval panel. `remove_from_cart`, `set_cart_quantity` and `clear_cart` still require explicit browser approval before their one-use claim. `apply_measurements` uses an ordinary one-use claim after one conversational confirmation of the width, drop and units; it has no extra approval panel. Required cart approval is transport state, never a model argument. At most one cart/form mutation is allowed per reply. Sanitized outcomes persist for later turns; an interrupted or unconfirmed submission must be checked rather than replayed. Catalog matches do not establish fitting suitability, stock or a configured quote. Photo uploads and visualization remain later work.

A theme-confirmed `added` result includes `addedProduct: {productPath, title, measurements?: {width, height, unit}}` when its submitted product identity is available. Measurements come from the actual submitted product configuration, with `unit` in `mm`, `cm` or `in`; they are omitted when unavailable. With that product identity, the repository persists a `cart_added` context notification with the confirmed tool outcome, independently of whether the model finishes its reply. Repeated result delivery must not duplicate that notification. Both text and voice timelines retain the event, and the customer UI presents it with confirmed Roman navigation as a centered brand-red pill, naming the product and showing submitted width/drop/units when present. The notification confirms the addition, not checkout or payment.

`measurements/` owns product-scoped drafts and idempotent writes. Authenticated `POST /api/conversations/:id/measurements` accepts `{requestId, name, arguments}` for manual get/set; model calls use the same service. Drafts preserve width, drop, units, window/order meaning and mounting without conversion or deductions. Limits are 20 products and 200 manual request receipts per conversation. An old request returns its original result without overwriting newer values. Ended conversations reject writes. For a configure/fill request, Roman confirms the pair once, saves it and applies it to the chosen product. It does not ask a separate finished-dimension or mounting questionnaire. `order` means values confirmed for entry into product inputs; it does not establish manufactured dimensions or fitting suitability. Applying dimensions freezes and revalidates the saved draft at claim time, then checks the current product, units and fields immediately before editing.

The [frontend tool drawer](../frontend/README.md#developer-tools) executes public catalog calls and browser-owned cart/navigation actions directly. Catalog, navigation and cart actions need no admin server; persistent measurement tools use the authenticated conversation service. Keep browser actions at their current owner and return their results to the conversation runner.

## Voice conversations

`voice/provider.server.ts` creates native [GPT-Live-1 sessions](https://developers.openai.com/api/docs/guides/live) with `store: false`, WebRTC and client delegation. It uses the same private `OPENAI_API_KEY` as Terra. OpenAI hosts both models; Docker needs no GPU or model weights. Browser audio goes directly to OpenAI. A trusted server sideband receives captions and delegation events; browser requests cannot upload captions or invoke model tools through that connection.

Roman defaults to Live's `marin` voice, retaining its natural accent and character with lively, warm delivery at a natural conversational pace. The **Developer tools > Voice** selector lists all 22 [built-in voices](https://developers.openai.com/api/reference/typescript/resources/live#built-in-voice); `shared/voice.ts` owns the validated list and default. Other choices retain their natural voice character with the same lively delivery. Selection applies to a new connection; GPT-Live-1 remains the model. Tone, pace and opening policy belong in the [voice prompt](prompts/voice.server.ts), with welcome copy in the [shared prompt](prompts/shared.server.ts). Voice and prompt choices do not guarantee an accent or exact playback: verify them by listening.

The sideband also reflects raw audio packets, which Roman discards before validating caption/control events; reflected audio has no server event ID. A rejected event logs its type and failing field without audio, transcript text or identifiers. Check Docker logs when voice creation succeeds but the connection then ends.

`voice/service.server.ts` owns connection lifetime, bounded queues, cancellation and delegation to the existing Terra runner. Only explicit provider delegation triggers work; caption pauses do not. Terra receives the combined history and returns its final factual briefing to the voice advisor; preliminary tool-round narration is excluded. Selected cards persist inline without a duplicate text reply. A new delegation cancels unfinished earlier work. Already handed-off navigation cannot be undone. Page observations quietly update voice context without fabricating customer messages.

`voice/repository.server.ts` owns `VoiceSession` leases and exact `VoiceTranscript` fragments. The shared caption projection merges delayed customer and assistant streams by their Live-session start times, preserving each speaker's fragment delivery order and boundaries at visible messages, tool completion and connection changes. Same-speaker captions tolerate pauses up to three seconds; stored sequences and text remain unchanged. New voice product widgets record their connection and result-completion sequence in `partsJson`. They appear as soon as ready, then follow that response's captions, stopping at another message or speaker/connection change. The same projection serves the sidebar and admin without rewriting captions or inventing spoken text. Initial GPT-Live context is a bounded recent extract; the full persisted conversation remains available to Terra. Roman never stores raw audio, and captions do not prove the customer heard every word.

Authenticated `POST /api/conversations/:id/voice` accepts `{requestId, clientId, sdp, voice?}` and returns `{voiceId, sdp}`. Omitted voice selects Marin; invalid voice names are rejected. `/voice/:voiceId/ready`, `/heartbeat` and `/stop` accept `{clientId}`. SDP input is limited to 48 KiB within a 64 KiB JSON body. Every route independently checks the conversation bearer and storefront origin. Allowed preflights cache permission for ten minutes; actual requests remain authenticated and responses remain `no-store`.

The browser starts its microphone only on request and renews a 45-second lease every 20 seconds. Initial Live instructions already contain the first greeting or returning follow-up, selected from saved Roman replies; page observations alone do not count. One acknowledged opening cue waits for provider startup and browser `/ready` (connected WebRTC, native startup event and an attached audio track). It never waits for `audio.play()` to resolve before requesting speech, which could deadlock. Repeated readiness events do not repeat the cue; observed customer/assistant speech takes precedence. This removes the late greeting-instruction update that could interrupt speech. A browser debug summary records startup-stage timings without audio, transcripts or identifiers.

Limits are four live connections per server, ten connections and 1,200 caption fragments / 60,000 caption characters per conversation, and ten minutes per connection. Stop drains final captions before switching to text. A lost browser, expired lease or server restart ends the connection; restoring chat never reopens the microphone. Native audio persists through successful in-place navigation, but a full reload requires **Start voice** again. The sidebar exposes mute/stop controls while collapsed.

## Conversation inspection and usage

Open Roman in Shopify admin for the current store's conversation list, counts and recorded usage. The list shows 25 sessions per page, newest first; open one for its ordered text/voice transcript, page visits, saved product references, tool outcomes and model/voice activity. **Refresh** reads the latest saved state. Product references are historical IDs, not cached catalog details. The existing theme-embed setup link remains on the overview.

`insights/` owns the read models and admin presentation. Both `/app` and `/app/conversations/:id` authenticate their own loaders and scope every query to `session.shop`; responses use `Cache-Control: no-store`. Inspection reuses the canonical conversation timeline and never ends voice, recovers a pending turn or replays tools. Credentials, provider identifiers, claim tokens and raw tool arguments are excluded from the admin read models.

`usage/` owns provider usage contracts and persistence. Each Responses request, including tool-loop rounds and voice delegation, gets one durable `ModelUsage` attempt before the API call. Terminal provider counts replace that attempt once, independently of whether the conversation was cancelled or ended. Input/output/total tokens and available cached-input, cache-write and reasoning subsets come from the provider. Final GPT-Live cumulative seconds are saved on `VoiceSession`; intermediate updates are not added together. Usage migrations preserve existing sessions and leave their unknown counts null.

Totals cover recorded usage only. Missing reports, unfinished calls and older sessions are shown explicitly; zero means a reported zero. A process crash can leave an attempt pending without final counts. Rebuild/recreate Docker to deploy this console and its migrations; these backend-only changes do not require a Shopify extension release.

### Model pricing

The overview shows this store's estimated USD cost and read-only rate history; each conversation shows its combined estimate and per-call costs. [`pricing/rates.server.ts`](pricing/rates.server.ts) is the versioned rate configuration. Periods use UTC timestamps: `effectiveFrom` is inclusive, `effectiveTo` is exclusive, and `null` leaves the end open. Startup validation rejects overlapping periods for the same model and service tier. Luna and Live rates start on 15 September 2026; Terra rates were verified and added from 16 September 2026; this is not a claim about when OpenAI introduced them. Earlier dates remain unpriced.

For a price change, close the existing period at the change timestamp and append a new entry with a unique ID, that same `effectiveFrom`, updated prices, source URL and verification timestamp. Preserve earlier rates. Commit, check and rebuild Docker to publish the change; no database editor or automatic price scraping is involved. Future periods can be added in advance.

`pricing/estimate.server.ts` chooses the rate using each request's recorded model, returned service tier and start time. `fast` and `priority` select Fast rates; `default` selects Standard. Input above the configured long-context threshold uses the higher rates for the entire request. Ordinary input is `input − cached − cache writes`; each category has its own per-million rate, and output already includes reasoning. GPT-Live uses reported cumulative seconds × the per-minute rate ÷ 60. A voice connection spanning a price change uses its start-time rate for the whole connection; Roman does not have a billing split across that boundary.

Missing usage fields, unknown models/tiers and gaps in pricing history stay unpriced, with coverage counts beside partial totals. Historical missing cache-write counts are not assumed to be zero. Estimates are calculated from saved usage without rounding individual calls; rounding is for display only. They use direct API list prices and exclude taxes, discounts, regional surcharges and hosting, so they are not invoice reconciliation. Lifetime overview costs use database totals grouped by price period and per-request context band; individual usage rows are loaded only for one conversation's inspection. Overview reads do not hold an interactive transaction across the report, so totals can advance independently while customer activity continues.

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

Conversation polls send durable and active-text versions; unchanged responses omit history. Healthy reads perform no recovery writes, and historical Markdown is memoized. Deploy backend changes before the frontend when changing the read contract.
