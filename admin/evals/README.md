# Discovery evaluation

Run from the repository root:

```powershell
node admin/evals/discovery.mjs --live
```

This makes **billable OpenAI requests** using the root `.env` key. It runs text and voice briefings at medium and low reasoning, with synthetic conversation/catalogue data, a 100ms catalogue stub and no storefront actions. Each case is bounded to four provider attempts and 60 seconds. Results go to ignored `.agents/discovery-evaluation.json`.

The acceptance check requires two completions, one multi-query catalogue operation, grounded cards from multiple families and a final question. This tests advisor orchestration, not real Shopify relevance, browser image loading or audible Live delivery. Runtime tests separately cover parallel search, partial failure, cancellation, terminal validation, persistence and mutation safeguards.

The 2026-09-29 sample produced:

| Reasoning | Channel | Completions / catalogue operations | Server-ready time | Input / cached / reasoning tokens |
| --- | --- | --- | --- | --- |
| Medium | Text | 2 / 1 | 5.89s | 17,249 / 7,205 / 348 |
| Medium | Voice briefing | 2 / 1 | 6.46s | 17,119 / 7,142 / 308 |
| Low | Text | 2 / 1 | 3.75s | 17,243 / 7,205 / 0 |
| Low | Voice briefing | 2 / 1 | 2.40s | 17,075 / 7,142 / 0 |

All four passed the structural target. Cache writes were also reported (7,205 text / 7,142 voice tokens). This is one synthetic case per setting, not a statistically reliable comparison. Medium remains the default to preserve judgment in measuring, configuration and task switching. Re-run with representative real-store read-only evaluation before reducing it globally.
