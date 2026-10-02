# Admin console

The Roman backend is a React Router framework app with a separate embedded admin console, Tailwind CSS 4 and Shopify Polaris web components. It owns Shopify authentication, webhooks, customer conversation APIs and persistence. Customer UI belongs in [`frontend/`](../frontend/README.md).

Run all commands from the repository root. Both apps share its package manifest and lockfile.

Admin-owned static assets live in `assets/` and are imported by the app. Vite handles their production URLs; there is no root public directory.

## Backend ownership

This server and its embedded admin UI run together locally in Docker for now; the same image can run on one Azure VM later. Customer sidebar API routes also belong in this app, outside the merchant-only `/app` layout. They need their own customer/session authorization; storefront visitors do not have Shopify Admin sessions. Keep AI clients and data-access logic in server-only modules, with browser-safe request/response types shared only when needed.

Prisma's `Session` model stores Shopify authentication. Separate `Conversation` and `ConversationMessage` models store anonymous shop-scoped chat, ordered messages, completion state and actual model/service tier. SQLite lives in the Docker volume, independently of the image. Transcripts survive app uninstall; authorization stops when the offline installation or required scope is removed.

## Text conversations

The same backend advisor serves text and voice briefings through the Responses API: `gpt-6-luna`, Fast tier, medium reasoning and `store: false`. The database owns conversation history; provider conversation IDs are not used. Keep `OPENAI_API_KEY` in the private root `.env`; recreate Docker after environment changes.

| Owner | Responsibility |
| --- | --- |
| [prompts/shared.server.ts](prompts/shared.server.ts) | Identity, welcome and concise core advisor contract |
| [prompts/knowledge-base/](prompts/knowledge-base/) | One static, ordered composition of discovery, measuring/fitting, configuration, replacement, samples, cart/checkout and support policy |
| [prompts/text.server.ts](prompts/text.server.ts), [prompts/voice.server.ts](prompts/voice.server.ts) | Channel formatting, speech, opening and delegation; no copied domain workflows |
| Root `shared/` tool schemas | Purpose, arguments, results and execution preconditions |
| `conversations/model.server.ts` | Provider rounds, budgets, cancellation, fallback and completion |
| `conversations/storefront-turn.server.ts`, `conversations/guide-turn.server.ts` | Domain validation, mutation state and guide evidence |
| `conversations/runner.server.ts` | One active turn per conversation, transient activity and atomic publication |
| `conversations/repository.server.ts` | Durable ordering, source provenance, idempotency and restart recovery |

Keep new domain rules in the appropriate knowledge module. The stable prompt includes all modules without a classifier call or keyword router. The full conversation remains stored; model context uses private working notes, model-specific compaction and recent history. Current selection, background page and pending question are supplied once as application facts. A background page never establishes the active task. Guide bindings are compact facts, not repeated workflow instructions.

Configuration owns the fresh reread after option or dimension changes. Roman compares newly available controls and choices at any nesting depth, resolves relevant operation/hardware/cost decisions before unrelated upsells, and retains harmless or already resolved defaults. Upsells own upgrade selection and guarantee consent; cart owns purchase consent and the form/cart execution boundary.

Routine option replies name the changed choice and configured blind price, then ask the next relevant question. Settled dimensions and guarantee disclosures are not repeated unless they change or the customer requests a summary. Selecting a blind offers measuring, options and any available sample together; a continuing guide task starts directly with its next step. Live delivers these shared decisions in first person, including any contextual progress cue.

### Discovery and complete responses

Discovery gathers useful room, opening/coverage, priority, fitting and appearance context one decision at a time, reusing supplied answers and accepting uncertainty. Explore, find-style and no-drill starting requests go straight into discovery, ignoring the unselected background product without a lookup or entry offer. Product tasks such as measuring may still offer the current-product card with This blind and Something else. Acceptance activates that exact blind and continues its task or offers product actions; decline continues discovery. Once enough is known, category exploration shows varied verified examples alongside a refinement question; choosing a family is not another gate before seeing products. Pleated, cellular and honeycomb terminology shares one discovery family across locales, while actual product properties still require evidence. Compatibility questions follow the product's mounting method: frame material matters for relevant direct-mount products, not generic recess/tension searches. Category refinements preserve the customer's other requirements. Product eligibility takes priority over variety or card count; contradictory or unverified requirements exclude recommendations in prose as well as cards. Category exploration does not select a product, even when only one matching card was shown.

Normal discovery is two Luna completions: `search_products({queries: [...]})`, then one terminal answer. One to three targeted searches run concurrently **inside one claimed browser operation**, below its single-operation guard. They share a 20-second deadline; cancellation aborts all work, while a failed query retains successful siblings. Results contain query provenance and up to 30 deduplicated candidates. The projected result is limited to 120 KiB within the 128 KiB HTTP envelope; each raw MCP response is limited to 1 MiB. Navigation, configuration and cart changes remain serial.

The terminal `ask_question` or `ask_measurement` carries `message`, `productIds` (zero to ten), and the question/answer or measuring fields. No separate product-presentation model call exists. Missing decision-relevant details may justify one batched lookup; ordinary browsing does not read guides. Final cards must use current-turn catalogue IDs and verified titles. Text, cards and question validate and commit together before publication. Separate persisted card/question records derive unique IDs from the same terminal call; older history remains readable. An invalid terminal response gets one terminal-only correction, never an action replay.

Category examples live in the knowledge base as exploration directions, not claims of store availability. We do not pre-scrape or persist a second catalogue. The targeted batch supplies current store evidence in one round trip. Any future store taxonomy should be small, source-labelled and refreshed independently; it must not replace live product or compatibility evidence.

Response policy keeps research narration private and gives each question one owner. Decisions and source failures use clickable answers; measurement fields request physical distances with an applicable verified method. A missing or mismatched product guide triggers relevant library research in the same reply, without asking the customer for permission. If that also fails, Roman offers supported alternatives instead of a measurement field.

### Long conversations and private memory

There is no cumulative Roman turn, voice-connection or caption quota. Operation deadlines, concurrency limits, idle shutdown and authorization still apply; provider/network interruptions remain possible.

`conversations/memory.server.ts` owns a private, bounded set of flexible notes and model-specific context checkpoints. The normal terminal reply can patch changed notes through `memoryUpdate`, committed atomically with the validated answer. This adds no separate memory call to ordinary turns. Notes retain goals, corrections, pending work and notable outcomes, naturally grouped by window and blind/curtain/future visualization layer where useful. They are not a rigid workflow or another product configuration, and never enter customer snapshots. The memory knowledge module owns this policy.

Native Responses compaction runs within generation when durable context grows; a 24KB text gate prevents PDFs alone triggering repeated compaction, and the provider's actual threshold is 24,000 tokens. Whole encrypted checkpoints and subsequent output are retained with a source-sequence watermark. Primary and fallback models use separate checkpoints, preserving current-turn raw tool outcomes across failover without replaying actions. Post-checkpoint history reads use that model's sequence range. A cold model can use existing notes plus a bounded recent-history window, with an explicit private boundary and access to older evidence. Original messages and captions are not deleted. `recall_history` retrieves bounded, conversation-scoped historical evidence when older details matter. Current tool capabilities, source validation, customer consent and verified prices remain authoritative; a memo or compacted recollection cannot authorize a mutation.

Live receives the private notes before its bounded recent context on connection/reconnection; the backend advisor retains access to original history. Visualization wishes can be remembered, but image upload/generation remains unimplemented.

Customer snapshots contain a recent sequence window plus authoritative current selection/question and pending tool state. Authenticated `/api/conversations/:id/history?before=<sequence>` reads earlier windows. Shared timeline projection keeps text, captions and widgets ordered across boundaries; the frontend loads upward without pagination controls. The admin audit history remains independent of the customer history window.

### Authorization, actions and guide reuse

The first message bootstraps through Shopify's signed `/apps/roman/bootstrap` proxy and requires an installed offline session with `write_app_proxy`. `shared/storefronts.ts` binds permanent shop identities to exact allowed storefront origins. Later calls require the conversation bearer and its saved origin; CORS is not authorization. Tab-scoped credentials have a seven-day expiry, renewed by valid activity near expiry so an active chat is not cut off. Expired credentials are never revived. Inputs are bounded to 32 KiB, with 128 KiB for tool-result envelopes.

Request UUIDs deduplicate input. Each tool invocation has one atomic browser claim; late, stale and mismatched results are rejected. Reloads/restarts never replay actions. Standard limits are four concurrent replies, 90 seconds per turn, four browser operations and 4,000 input characters. A verified native configuration read unlocks up to 12 configuration/measurement operations and 16 model rounds. Browser operations have an outer 45-second deadline. New-conversation limits are 20 per shop per ten minutes and 100 per day; these are demo limits, not a production abuse-control service.

Cart writes remain limited to one per reply and cannot share a turn with form changes. Configuration permits up to three option changes and one measurement application on the same product, with fresh capabilities between changes; uncertain results block further writes. Clear customer-provided dimensions can be entered without a separate confirmation turn; unresolved units, suitability and native size limits still require resolution. The reply recaps the entered pair with the settled quote. Paid-option consent and cart request/approval remain separate. `measurements/` owns product-scoped drafts and idempotent writes; claim-time validation freezes the exact saved order draft before touching the native form. Theme validation remains authoritative. See the knowledge modules for customer workflows and the shared schemas for supported controls/results.

`guides/` owns original PDF reads, exact source bindings and bounded session reuse. Product and library sources are independently scoped to conversation, origin and uninterrupted product visit. Cache lifetimes are 30 minutes, bounded to 16 entries / 32 MiB. Later turns receive prior-read metadata; original files attach only when a required detail needs them. Leaving the product, expiry, refresh or restart invalidates reuse. Matching library evidence remains valid when an unrelated product-page document is wrong. Discovery labels alone are not read evidence. Numerical measuring questions require a current verified source; no generated summary replaces the originals.

Explicit 30-minute provider cache breakpoints cover stable instructions/tools and deterministically ordered requested documents, before changing history. Identical PDF bytes reached through both library and product page attach once. Cache receipts prove a read, not suitability or consent. Read/write/cached/reasoning usage is recorded for each provider attempt; actual cache savings depend on prefix matches and expiry.

Fresh `get_product_guides` includes the current native configuration within the same browser operation, including one-pair entry support and observed per-unit size limits/choices. Configuration remains useful if the PDF fails; cached PDFs never replay live configuration capabilities. A standard single window or settled whole-opening covering defaults to one blind. Only indicated separate coverings trigger multi-blind planning: establish the count first, validate and configure one pair, then check whether the others are identical. Different pairs proceed individually; identical copies use the verified added line key, a fresh cart read and the existing reviewed quantity action. Native limits, guide applicability and purchase consent remain separate checks.

Each provider response allows 8,192 output tokens, including reasoning and structured output. An output-limit truncation retries the same round once per turn with 16,384 tokens, retaining that budget for subsequent rounds. Partial output is discarded; completed tools are not replayed. The turn deadline still applies. A completed tool round followed by `max_messages` may use the separate, single terminal-only repair.

Provider availability failures retry that round on `gpt-5.6-luna` without replaying completed tools. Synthetic probes retry the primary at 1, 2, 4, 8, 16 then 30 seconds. If both models fail, input and voice suspend until recovery. Policy, invalid-prompt, malformed and incomplete responses do not trigger model fallback. Incidents and each billable attempt persist separately; logs exclude provider bodies and customer text.

### Latency verification

`[Roman] Advisor turn metrics.` logs completion count, provider time, prompt/cache/reasoning tokens, tool durations, and time until cards or a voice briefing are committed. These are server-ready times, not browser paint or audible speech. [Controlled evaluations](evals/README.md) cover discovery and dynamic configuration with synthetic data and no storefront actions. Medium is the advisor default; discovery also permits a low-reasoning override for speed comparisons.

## Voice conversations

`voice/provider.server.ts` creates native [GPT-Live-1 sessions](https://developers.openai.com/api/docs/guides/live) with `store: false`, WebRTC and client delegation. It uses the same private `OPENAI_API_KEY` as the text advisor. OpenAI hosts both models; Docker needs no GPU or model weights. Browser audio goes directly to OpenAI. A trusted server sideband receives captions and delegation events; browser requests cannot upload captions or invoke model tools through that connection.

Roman defaults to Live's `marin` voice, retaining its natural accent and character with lively, warm delivery at a natural conversational pace. The **Developer tools > Voice** selector lists all 22 [built-in voices](https://developers.openai.com/api/reference/typescript/resources/live#built-in-voice); `shared/voice.ts` owns the validated list and default. Other choices retain their natural voice character with the same lively delivery. Selection applies to a new connection; GPT-Live-1 remains the model. Tone, pace and opening policy belong in the [voice prompt](prompts/voice.server.ts), with welcome copy in the [shared prompt](prompts/shared.server.ts). Voice and prompt choices do not guarantee an accent or exact playback: verify them by listening.

Authenticated `POST /api/conversations/:id/voice/:voiceId/answers` accepts `{clientId, requestId, text}` for typed/tile input, `{clientId, requestId, questionId, answer}` for the current saved question or `{clientId, requestId, carouselId, productId, title, productPath}` for a product in a completed saved carousel. All require this tab's active voice ownership. A product choice's bounded label and canonical path are customer reference data; the model must verify the product and apply normal replacement confirmation before acting. The selection is saved as ordinary customer text with voice, question or product provenance, then sent directly through the same backend advisor runner used for spoken delegations. Live receives a bounded silent `thinking.append` mirror and the completed factual briefing through `commentary.append`; it is never asked to rediscover the need for backend work from a generic continuation cue. Voice stays connected; no caption or duplicate written reply is fabricated. HTTP acknowledges accepted input without waiting for the model and tools; the durable pending turn drives activity and widgets. Durable receipts deduplicate retries, including after voice ends, and never replay provider delivery. Unconfirmed delivery returns 503 while preserving the selected input; the browser rereads its receipt. Provider acknowledgment confirms context acceptance, not speech or completed playback.

`shared/active-product.ts` owns the current blind for the customer UI and model context: only a completed Roman PDP navigation in the active conversation selects it. A hidden native page observation never changes that selection. The backend appends a small current selection/background-page summary to text and Live history so voice restarts retain this distinction even when older history is truncated. Ending chat clears the selection without discarding its durable transcript.

The sideband also reflects raw audio packets, which Roman discards before validating caption/control events; reflected audio has no server event ID. A rejected event logs its type and failing field without audio, transcript text or identifiers. Check Docker logs when voice creation succeeds but the connection then ends.

`voice/service.server.ts` owns connection lifetime, bounded queues, cancellation and delegation to the existing backend runner. Spoken requests require explicit provider delegation; accepted typed replies and UI choices start the same runner directly. Caption pauses do not trigger work. An explicit delegation can wait up to two seconds for its delayed caption, matched by the provider's audio timeline; unrelated later speech cannot activate it. Freshness is checked before cancellation, so duplicate delegations cannot cancel or replay valid work. A fresh spoken request can supersede earlier work through normal cancellation. The backend advisor receives the combined history and returns its final factual briefing to the voice advisor; preliminary tool-round narration is excluded. Selected cards persist inline without a duplicate text reply. Ordinary superseded voice work retires silently without a failed transcript entry or caption boundary. Unconfirmed claimed storefront actions retain a check-before-repeating warning and durable uncertainty; cancellation never replays them. Already handed-off navigation cannot be undone. Page observations quietly update voice context without fabricating customer messages.

A clicked quick answer supplies its explicit question/answer context to Live immediately. Typed input or a product choice can receive one contextual cue after 2.5 seconds without speech. Measurement-input metadata suppresses generic acknowledgement; an actually slow tool can still report progress. No question-text keyword router infers a workflow. Named tool lifecycle facts retain the current question/answer or selected product title in a bounded silent reference; a separate cue lets Live compose a brief update from that context and the recent conversation. There is no spoken phrase bank or extra text-model call. Both optional sideband commands are sent in order without a serial acknowledgment wait, and settle together before the final reply; insufficient queue space skips the whole pair. Oversized customer fields are omitted whole and marked partial, never clipped across a correction. The verified briefing queues behind current speech; an accepted cue without a caption delays it by at most 1.2 seconds. Optional cue failures never suppress the result, and new input cancels obsolete work and queued speech. Provider acceptance is not proof of audible playback; verify timing by listening.

`voice/repository.server.ts` owns `VoiceSession` leases and exact `VoiceTranscript` fragments. The shared caption projection merges delayed customer and assistant streams by their Live-session start times, preserving each speaker's fragment delivery order and boundaries at visible messages and connection changes. Tool completion separates customer utterances without splitting an assistant sentence; hidden page observations and navigation do not create caption boundaries. Once customer speech separates replies, a delayed delegation reservation cannot split the following acknowledgement mid-sentence. Typed messages, visible events and voice-session changes still separate captions. Same-speaker captions tolerate pauses up to three seconds; stored sequences and text remain unchanged. Customer and admin views hide `[chuckle]`, `[breath]` and orphaned leading punctuation through the shared display formatter; raw captions and model context remain exact. New voice product widgets record their connection and result-completion sequence in `partsJson`. They appear as soon as ready, then follow that response's captions, stopping at another message or speaker/connection change. The same projection serves the sidebar and admin without rewriting captions or inventing spoken text. Initial GPT-Live context is a bounded recent extract; the full persisted conversation remains available to the backend advisor. Roman never stores raw audio, and captions do not prove the customer heard every word.

Voice lifecycle entries use the existing message table: **Voice chat started** is saved once when both provider startup and browser transport readiness are confirmed, before the opening cue. **Voice chat ended** records an orderly stop or End chat; **Voice chat disconnected** records provider failure, lease expiry or restart recovery. A connection that never reached readiness has no start/end entries. These context rows retain their order across reloads, appear in customer/admin transcripts, never retire a question and are excluded from model history. If captions arrive before the readiness request, the shared display places the start before that connection's first caption without rewriting stored data. Earlier sessions are not backfilled.

Authenticated `POST /api/conversations/:id/voice` accepts `{requestId, clientId, sdp, voice?}` and returns `{voiceId, sdp}`. Omitted voice selects Marin; invalid voice names are rejected. `/heartbeat` accepts `{clientId}`. `/voice/:voiceId/ready` accepts `{clientId, input?: {requestId, text}}`; a queued welcome reply is saved before readiness, suppresses the opening greeting and continues the same voice conversation once startup is ready. `/stop` accepts `{clientId, reason?: "connection_lost"}`: a browser transport failure records **Voice chat disconnected** with a server-owned error; deliberate stops retain **Voice chat ended**. Shutdown drains final captions and preserves its first terminal outcome. SDP input is limited to 48 KiB within a 64 KiB JSON body. Every route independently checks the conversation bearer and storefront origin. Allowed preflights cache permission for ten minutes; actual requests remain authenticated and responses remain `no-store`.

Opening Roman can attempt voice once after the frontend is ready, unless the customer opted out in this tab; Start voice is the explicit retry. The browser renews an active 45-second lease every 20 seconds. Initial Live instructions already contain the first greeting or returning follow-up, selected from saved Roman replies; page observations alone do not count. Provider startup and browser `/ready` (connected WebRTC, native startup event and an attached audio track) gate one compact opening-instruction refresh, followed by at most one commentary cue after its matching acknowledgement. Returning conversations explicitly continue the latest request and outcome; new conversations use the canonical welcome. The original business prompt and history are not resent. Repeated readiness events cannot repeat either step, and customer/assistant speech, stopping or cancellation before or during the acknowledgement suppresses the cue. It never waits for `audio.play()` to resolve, which could deadlock. Acknowledgement confirms acceptance, not exact words or completed playback; test the spoken continuation live. Startup projects model history and UI context from one transcript read. Browser and server debug summaries separate startup stages without audio, transcripts or identifiers.

Four simultaneous live connections per server remain the demo concurrency bound. Connection count, caption count and elapsed conversation time do not end a chat. Caption persistence uses exact event IDs rather than scanning the previous transcript. Stop drains final captions before switching to text. Recoverable transport loss or provider expiry can reconnect while Roman stays open, after pending work settles, with at most three attempts per interruption; sustained healthy operation resets that retry budget. Deliberate stop/close, idle shutdown, policy failures and service suspension never reopen the microphone. Reconnection restores current context and a pending question without resubmitting customer input or repeating actions. Native audio persists through successful in-place navigation; a full page reload still requires a new connection.

Voice also closes after 60 seconds without customer or Roman speech or customer input. Transport heartbeats do not extend this idle deadline; delegated work stays active until it finishes, then starts a fresh quiet period. Authenticated ready/heartbeat responses expose `idleExpiresAt` for diagnostics and server-relative `idleRemainingMs` so the storefront can show a warning 15 seconds before closure regardless of device clock settings. Provider-reported cumulative Live seconds remain the source of recorded usage; this timeout limits future idle connections rather than rewriting past usage.

## Conversation inspection and usage

Open Roman in Shopify admin for the current store's conversation list, counts and recorded usage. The list shows 25 sessions per page, newest first; open one for its ordered text/voice transcript, page visits, saved product references, tool outcomes and model/voice activity. **Refresh** reads the latest saved state. Product references are historical IDs, not cached catalog details. The existing theme-embed setup link remains on the overview.

`insights/` owns the read models and admin presentation. Both `/app` and `/app/conversations/:id` authenticate their own loaders and scope every query to `session.shop`; responses use `Cache-Control: no-store`. Inspection reuses the canonical conversation timeline and never ends voice, recovers a pending turn or replays tools. Credentials, provider identifiers, claim tokens and raw tool arguments are excluded from the admin read models.

`usage/` owns provider usage contracts and persistence. Each Responses request, including tool-loop rounds and voice delegation, gets one durable `ModelUsage` attempt before the API call. Terminal provider counts replace that attempt once, independently of whether the conversation was cancelled or ended. Input/output/total tokens and available cached-input, cache-write and reasoning subsets come from the provider. Final GPT-Live cumulative seconds are saved on `VoiceSession`; intermediate updates are not added together. Usage migrations preserve existing sessions and leave their unknown counts null.

Totals cover recorded usage only. Missing reports, unfinished calls and older sessions are shown explicitly; zero means a reported zero. A process crash can leave an attempt pending without final counts. Rebuild/recreate Docker to deploy this console and its migrations; these backend-only changes do not require a Shopify extension release.

### API Errors

The **API Errors** page in the embedded admin shows the latest recorded service status and a UTC date-range chart for fallback-model and complete-outage periods. It defaults to 30 days, accepts at most 366 days, groups longer ranges by week or month, and lists the 50 most recent periods started in the range. The chart counts period starts; an ongoing period that began before the selected range is still shown in the current-status panel. Refresh to see the latest transition.

`api-errors/repository.server.ts` persists global availability transitions in `ApiIncident`, independently of customer conversations and stores. A switch to GPT-5.6 Luna opens one fallback period; loss of both text models closes that period and opens a complete outage. Recovery closes the open period. Repeating the same state or retrying a recovery probe writes no incident. Rows contain only state and UTC start/end times, with a database constraint allowing one open period. The admin loader authenticates every request and returns `Cache-Control: no-store`. Rebuild/recreate Docker to apply the new migration while retaining the named database volume.

Synthetic recovery probes have no conversation owner and are excluded from recorded model usage and cost estimates.

### Model pricing

The overview shows this store's estimated USD cost and read-only rate history; each conversation shows its combined estimate and per-call costs. [`pricing/rates.server.ts`](pricing/rates.server.ts) is the versioned rate configuration. Periods use UTC timestamps: `effectiveFrom` is inclusive, `effectiveTo` is exclusive, and `null` leaves the end open. Startup validation rejects overlapping periods for the same model and service tier. GPT-5.6 Luna and Live rates start on 15 September 2026; Terra rates were verified and added from 16 September 2026; GPT-6 Luna Standard and Fast rates start on 23 September 2026; this is not a claim about when OpenAI introduced them. Earlier dates remain unpriced.

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

Customer message snapshots expose their existing optional requestId for exact optimistic-row reconciliation; no database migration is needed. Browser pending rows never create server records or session identity.

Conversation polls send durable and active-text versions; unchanged responses omit history. Healthy reads perform no recovery writes, and historical Markdown is memoized. Deploy backend changes before the frontend when changing the read contract.
