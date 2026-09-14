# Agent engineering guidelines

These guidelines adapt the generic build and quality rules from `../vx-platform/AGENTS.md` to Roman AI Assistant. Read the root README and the affected app's README before making changes.

## Priorities

1. Correctness and production safety.
2. Clear ownership and dependency boundaries.
3. Simple, explicit, maintainable design.
4. Reliability, security, and useful diagnostics.
5. Appropriate performance and delivery speed.

Make the smallest complete change at the correct owner. Prefer a coherent implementation over preserving a weak abstraction to minimize the diff. Do not add speculative layers, generic managers, forwarding wrappers, or dependencies without a concrete need.

## Ownership

- `frontend/` owns the customer React Router app and Tailwind styles. Keep it browser-only, mounted inside the extension's Shadow DOM. Its memory router must not take over the storefront URL or history.
- `admin/` owns the separate React Router admin console, Shopify authentication, webhooks, and server endpoints. Keep credentials, database access, and privileged API calls in server-only modules.
- `extensions/vx-roman-ai-assistant/` owns the Shopify theme embed, translations, and small asset loader. Keep its installed UID and block handle stable unless a deliberate migration is required.
- `shared/` contains only browser-safe code genuinely shared by both apps. Neither shared code nor customer code imports admin modules.
- `prisma/` owns session persistence and migrations. Preserve durable data; model changes require an appropriate migration.
- The root package manifest, lockfile, and build configuration own installation and tooling for both apps. Do not introduce separate installs or a workspace framework without a real need.

Keep business logic separate from transport, persistence, and framework concerns where those boundaries exist. Validate untrusted input at entry points. Make resource ownership, mutable state, cancellation, and cleanup explicit.

Every protected admin loader/action must authenticate its own request; layout authentication does not protect parallel route handlers. Verify webhooks with Shopify's SDK. Use the authenticated shop identity to scope data access.

The admin/backend runs locally through Docker Compose for now; the same image can run on one Azure VM later. Preserve the named database volume across container replacements. Customer API routes belong outside the merchant-only `/app` layout and require their own authorization. Keep Shopify's `Session` model separate from future customer conversations. Scope customer records and files to their shop and customer/session identity; keep AI credentials server-only. Add AI clients, storage configuration, and dashboard models with working features, not unused scaffolding.

## Shopify platform work

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it on the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts). Do not add agent tooling to this repo.

Follow the relevant Toolkit search and validation workflow. Keep API versions aligned and request only scopes required by implemented features. Publishing a Shopify app version affects its installed stores; keep the release scope explicit.

## Keep the codebase clean

- Maintain one canonical implementation. Share stable behavior at its owner, rather than duplicating it across views or stores.
- Remove retired code, routes, exports, dependencies, configuration, and documentation. Do not leave compatibility aliases or fallbacks without an actual supported contract.
- Complete renames across callers, imports, configuration, scripts, tests, and docs. Do not leave the old path behind.
- Keep modules cohesive and interfaces narrow. Avoid speculative abstractions or unfinished placeholders beyond the requested feature scope.
- Preserve unrelated worktree changes. Never discard existing data or established external contracts as housekeeping.

## Reliability and security

- Handle errors deliberately; do not silently swallow failures or substitute defaults for invalid state.
- Keep secrets and personal customer data out of source, logs, fixtures, and generated client assets. Browser environment variables are public.
- Clean up mounted React roots, routers, event listeners, timers, and asynchronous resources when their owner is removed.
- Bound retries, concurrency, queues, and caches when introduced. Measure performance-sensitive changes, especially storefront loading and bundle size.
- Use actionable, proportionate diagnostics. Do not add noisy logging or broad defensive fallbacks.
- Preserve accessible labels, keyboard focus, and reduced-motion behavior. Check styles within Shadow DOM and on a real theme when changing storefront UI.

## Build and verification

Use npm from the repository root; use `npm.cmd` in PowerShell if execution policy blocks the shim. Commit dependency changes with the lockfile.

```powershell
npm ci
npm run check
npm run build
```

During iteration, use the narrowest relevant command: `build:frontend`, `build:admin`, `lint`, or `typecheck`. Before finishing a cross-app or tooling change, run the complete checks and both builds. For extension changes, also rebuild the frontend and run `shopify app build`; inspect Theme Check output. Validate app configuration changes with `shopify app config validate --json`.

Add tests for meaningful behavior, failure paths, and ownership boundaries when needed. Avoid tests that only mirror trivial markup or implementation details. Run the relevant checks after the final change; repeat or broaden them only to resolve a new concern. Never claim a check passed without running it, and identify unavailable live, browser, or deployment checks.

Review the final diff for stale references, accidental scope expansion, generated files, and unrelated changes. Update the owning README when commands, configuration, ownership, or deployment behavior changes.

## Generated files and scratch work

Do not hand-edit or commit `build/`, `.react-router/`, or the extension's generated `*.bundle.js`. Rebuild the frontend before publishing; the supported `npm run deploy` command does this automatically. Shopify deploys configuration and extension assets; deploy the admin server to its Node.js host separately.

Use repository-root `.agents/` for agent scratch work; keep it ignored and untracked. Do not use `.tmp` or scatter disposable artifacts through source folders. Standard tool output directories retain their existing owners.
