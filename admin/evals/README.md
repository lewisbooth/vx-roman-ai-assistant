# Discovery evaluation

Run from the repository root:

```powershell
node admin/evals/discovery.mjs --live
node admin/evals/discovery.mjs --live --flow
```

This makes **billable OpenAI requests** using the root `.env` key. It runs text and voice briefings at medium and low reasoning, with synthetic conversation/catalogue data, a 100ms catalogue stub and no storefront actions. Each case is bounded to four provider attempts and 60 seconds. Results go to ignored `.agents/discovery-evaluation.json`.

The acceptance check requires two completions, one multi-query catalogue operation, grounded cards from multiple families and a final question. This tests advisor orchestration, not real Shopify relevance, browser image loading or audible Live delivery. Runtime tests separately cover parallel search, partial failure, cancellation, terminal validation, persistence and mutation safeguards.

`--flow` checks low reasoning in both channels for separate room/opening/priority questions, missing aesthetic direction, a fully specified request and category exploration after a single matching card. Intake must ask one question without a catalogue call; sufficient context must produce one batched search without guide reads or navigation. Synthetic catalogue descriptions include the requested style facts so extra detail calls are unnecessary. Results, questions and answers go to `.agents/discovery-flow-evaluation.json`; review their meaning as well as the broad topic/operation assertions. Append `--case=room-only` (or another case name) for a bounded targeted rerun.

The 2026-09-29 flow sample passed all eight cases. Intake used one completion and no catalogue operations (1.05–3.39s); fully specified discovery used two completions and one batch (5.45–5.68s), and privacy-sheer category exploration searched without navigation (3.60–4.01s). These are single synthetic runs per case, not customer-visible latency guarantees or audible voice tests.

The initial 2026-09-29 latency sample, before the expanded discovery intake, produced:

| Reasoning | Channel | Completions / catalogue operations | Server-ready time | Input / cached / reasoning tokens |
| --- | --- | --- | --- | --- |
| Medium | Text | 2 / 1 | 5.89s | 17,249 / 7,205 / 348 |
| Medium | Voice briefing | 2 / 1 | 6.46s | 17,119 / 7,142 / 308 |
| Low | Text | 2 / 1 | 3.75s | 17,243 / 7,205 / 0 |
| Low | Voice briefing | 2 / 1 | 2.40s | 17,075 / 7,142 / 0 |

All four passed the structural target. Cache writes were also reported (7,205 text / 7,142 voice tokens). This is one synthetic case per setting, not a statistically reliable comparison. Low is now the demo default at the user's request; these timings do not guarantee equivalent judgment or live-store latency.
