# Discovery evaluation

Run from the repository root:

```powershell
node admin/evals/discovery.mjs --live
node admin/evals/discovery.mjs --live --flow
node admin/evals/discovery.mjs --live --flow --case=pleated-category-refinement,pleated-no-eligible,explicit-bifold-switch --max-requests=12
```

These are **billable OpenAI requests** using the private root `.env` key. History and catalogue results are synthetic; the catalogue stub takes 100ms and cannot navigate, read guides or mutate a storefront. Each sample is bounded to four provider requests and 60 seconds. `--max-requests=N` also caps the entire run before each provider request. Exhaustion fails remaining samples instead of exceeding the cap.

The default suite compares Medium and Low reasoning in text and voice briefings. `--flow` defaults to **Medium**. Use `--effort=low` or `--effort=medium` to select one effort, and `--case=name[,name]` to run specific cases. Reports, selected products, queries, responses and failures go to ignored `.agents/discovery-evaluation.json` or `.agents/discovery-flow-evaluation.json`.

## Behaviour checks

Normal discovery should use two completions and one catalogue operation, then return grounded cards and a useful question. Broad discovery checks category coverage. Intake asks one focused question with no catalogue call. Flow cases also cover missing room/opening/priority/aesthetic information, no-drill family choices and category exploration after an earlier suggestion. Synthetic product descriptions include enough evidence to make unnecessary detail or guide calls a failure.

The adversarial category cases preserve a living-room request for a standard window, no-drill fitting, daytime privacy and pattern/texture through the short follow-up "Pleated blind":

- `pleated-category-refinement`: mixed results contain two eligible pleated blinds alongside bifold-only, roof-only, drilled, unverified-fitting and wrong-family products. Only eligible IDs may be displayed; the targeted query must retain fitting, opening and appearance constraints.
- `pleated-no-eligible`: every result contradicts the requested category or fitting/opening requirements. Expect no cards and useful alternatives, without silently relaxing a requirement.
- `explicit-bifold-switch`: the customer explicitly replaces the standard window with individual bifold door panels. The search and selected products must follow that correction while preserving the other requirements.

Read the saved outputs as well as the assertions. These tests exercise advisor orchestration and synthetic suitability judgment; they do not prove real Shopify relevance, fitting compatibility, image loading or audible GPT-Live delivery. Runtime tests separately cover execution, partial failure, cancellation, persistence and mutation safeguards.

## Recorded samples

The 2026-09-29 adversarial Medium run used exactly 12 provider requests: each of six text/voice samples made two completions and one targeted search, with no guide reads or navigation. Server-ready times were 3.82-5.82s. Five samples met the semantic criteria. The no-eligible **text** sample explained the lack of a matching pleated blind but still displayed a roller before the customer accepted changing category; the no-eligible voice sample correctly displayed no cards. A narrow alternatives-topic assertion was corrected and the saved outputs regraded without another request. The mixed-results and explicit-bifold-correction cases passed in both channels.

After tightening the no-eligible rule, a separate four-request retest passed both text and voice: zero cards, preserved search constraints and useful permission-based alternatives (4.78s text, 4.34s voice briefing). The other four cases passed against the immediately preceding prompt; they were not rerun after that narrow rule change. Total requests across both runs: 16. The failed six-sample report remains in ignored `.agents/discovery-suitability-before-no-cards-rule.json`; the final two-sample report is `.agents/discovery-flow-evaluation.json`.

The earlier 2026-09-29 latency sample, before expanded intake, produced:

| Reasoning | Channel        | Completions / catalogue operations | Server-ready time | Input / cached / reasoning tokens |
| --------- | -------------- | ---------------------------------- | ----------------- | --------------------------------- |
| Medium    | Text           | 2 / 1                              | 5.89s             | 17,249 / 7,205 / 348              |
| Medium    | Voice briefing | 2 / 1                              | 6.46s             | 17,119 / 7,142 / 308              |
| Low       | Text           | 2 / 1                              | 3.75s             | 17,243 / 7,205 / 0                |
| Low       | Voice briefing | 2 / 1                              | 2.40s             | 17,075 / 7,142 / 0                |

All four met the structural target. These are individual synthetic samples, not statistically reliable comparisons or customer-visible latency guarantees. Medium is the current demo default.
