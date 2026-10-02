# Advisor evaluations

## Configuration

```powershell
node admin/evals/configuration.mjs --live --max-requests=40
node admin/evals/configuration.mjs --live --case=motorization-reveals-remote --max-requests=12
node admin/evals/configuration.mjs --live --case=accepted-guarantee-motor-update,accepted-guarantee-no-remote-update,guide-continuation-after-mount --max-requests=24
```

These billable Medium-reasoning samples use the current backend model in text and voice briefing modes, with synthetic history and native configuration. There is no browser, storefront mutation or database write. Each sample has a six-request/60-second limit plus the run-wide request cap. Without `--live`, no provider requests are made. Fixture and grader tests run in `npm test`.

Cases cover newly enabled remote hardware, an already owned compatible remote, a harmless nested default, and an explicitly requested remote at a disclosed surcharge. Concise-update cases retain an accepted guarantee without repeating its settled fee or dimensions; an explicit matching No Remote answer permits verified retention without a redundant write. Guide continuation uses valid prior-read evidence to advance without another PDF attachment or introduction. Checks retain fresh configuration around changes, paid-choice consent and source provenance. Read saved replies as well as assertions; these are behavioral samples, not a guarantee of future output or real theme compatibility. Reports go to ignored `.agents/configuration-evaluation.json`.

On 2026-09-29, all eight corrected text/voice samples passed with four completions each (32 requests): read, change, reread, complete. An earlier 32-request fixture run was inconclusive because it also requested a trim preference unavailable with electric controls; that conflicting instruction and missing prior measurement receipt were corrected before rerunning.

The later concise-reply run initially repeated accepted guarantee details in four option samples. After narrowing the reply policy, all four passed on retest (12 requests): motor updates retained the remote decision; No Remote used one fresh read without a redundant write. Both cached-guide samples advanced in one completion without rereading a PDF. Those guide samples ran before the final option-only wording change; a singular/plural grader correction was checked against their saved output without another request. These are backend voice briefings, not audible Live tests.

## Discovery

Synthetic advisor evaluations include the same private `memoryUpdate` terminal schema as live turns, without writing notes or checkpoints to the customer database. The long-conversation checks also cover model-specific compaction, private memo persistence, historical recall, task switching and caption/page boundaries in the regular test suite.

Run from the repository root:

```powershell
node admin/evals/discovery.mjs --live
node admin/evals/discovery.mjs --live --flow
node admin/evals/discovery.mjs --live --flow --case=pleated-category-refinement,pleated-no-eligible,explicit-bifold-switch --max-requests=12
node admin/evals/discovery.mjs --live --flow --case=nursery-ready-for-cards,pleated-cellular-refinement,wood-frame-recess,wood-frame-glass-fit --max-requests=16
node admin/evals/discovery.mjs --live --flow --case=current-product-offer,current-product-accept-answer,current-product-accept-card,current-product-accept-name,current-product-decline --max-requests=24
```

These are **billable OpenAI requests** using the private root `.env` key. History, catalogue and navigation results are synthetic; the stubs take 100ms and cannot read guides or change a real storefront. Each sample is bounded to four provider requests and 60 seconds. `--max-requests=N` also caps the entire run before each provider request. Exhaustion fails remaining samples instead of exceeding the cap.

The default suite compares Medium and Low reasoning in text and voice briefings. `--flow` defaults to **Medium**. Use `--effort=low` or `--effort=medium` to select one effort, and `--case=name[,name]` to run specific cases. Reports, selected products, queries, responses and failures go to ignored `.agents/discovery-evaluation.json` or `.agents/discovery-flow-evaluation.json`.

## Behaviour checks

Normal discovery should use two completions and one catalogue operation, then return grounded cards and a useful question. Broad discovery checks category coverage. Intake asks one focused question with no catalogue call when relevant context is missing. Flow cases also cover missing room/opening/priority/aesthetic information and category exploration after an earlier suggestion. An undecided family does not block search when the existing context is enough: `no-drill-family-choice` now requires varied cards and a category question together. Synthetic product descriptions include enough evidence to make unnecessary detail or guide calls a failure.

Current-product cases verify the entry card has **This blind / Something else**, acceptance by answer/card/name activates the exact offered product even when its page is already loaded, and decline continues discovery. Acceptance must offer product actions without restarting intake or searching alternatives. A known-ID refresh is permitted when details are needed. Fixture/grader tests run in `npm test`.

Acceptance also checks that the spoken/displayed question names measuring and options rather than hiding them behind a generic question or promoting only a sample. The 2026-09-29 follow-up retest passed both This blind channels in two completions each after clarifying that handoff. Voice grading excludes the question appended by the backend; its saved output was regraded without another provider call. Other acceptance forms were not rerun for this wording-only change.

The adversarial category cases preserve a living-room request for a standard window, no-drill fitting, daytime privacy and pattern/texture through the short follow-up "Pleated blind":

- `pleated-category-refinement`: mixed results contain two eligible pleated blinds alongside bifold-only, roof-only, drilled, unverified-fitting and wrong-family products. Only eligible IDs may be displayed; the targeted query must retain fitting, opening and appearance constraints.
- `pleated-no-eligible`: every result contradicts the requested category or fitting/opening requirements. Expect no cards and useful alternatives, without silently relaxing a requirement.
- `explicit-bifold-switch`: the customer explicitly replaces the standard window with individual bifold door panels. The search and selected products must follow that correction while preserving the other requirements.

The nursery and mounting regressions use a mixed catalog with verified recess tension products and incompatible or unverified alternatives:

- `nursery-ready-for-cards`: standard recess, blackout, no-drill and open colour preferences are enough for one batched search. Expect grounded roller and cellular cards with a category exploration question in the same response.
- `pleated-cellular-refinement`: the short follow-up "Pleated blind" retains the nursery's blackout, no-drill and opening constraints. Two suitable products use cellular/honeycomb titles and folded-construction evidence without the literal word "pleated"; both remain eligible.
- `wood-frame-recess`: wooden window frames do not exclude verified wall-to-wall recess tension fittings or trigger another frame/glazing question.
- `wood-frame-glass-fit`: an explicit direct glass-fitting request still requires actual frame compatibility. None of the catalog's products fits this wooden-frame request; expect no cards and alternatives before changing the mounting requirement.

All these cases retain exclusions for wrong opening, drilling, wrong opacity, unsupported fitting or construction family. Fixture/grader checks accept varied wording and inspect selected IDs, batched operation counts, query constraints and question topics. Run them without provider access with `node --test admin/tests/discovery-evaluation.test.mjs`; the importable fixtures and grader live in `discovery-suitability.mjs` and are also included in `npm test`.

Read the saved outputs as well as the assertions. These tests exercise advisor orchestration and synthetic suitability judgment; they do not prove real Shopify relevance, fitting compatibility, image loading or audible GPT-Live delivery. Runtime tests separately cover execution, partial failure, cancellation, persistence and mutation safeguards.

## Recorded samples

The 2026-10-02 nursery/mounting retest passed ten text/voice samples across the four new cases and `pleated-no-eligible`. Every sample used two completions and one catalogue operation (20 provider requests), with server-ready times of 4.74–8.45s. Eligible cellular/honeycomb products stayed in pleated results, broad cards covered roller and cellular families, and true direct-frame incompatibility still returned no cards. An initial 21-request run exposed an extra synonym search and unnecessary alternatives despite eligible products; the prompt now combines those terms in the first query and refines within the retained goal. One final voice briefing still called the folded construction “close to” pleated, but accepted both products without asking to change category or fitting. These are synthetic catalogue tests and backend briefings, not audible Live or real-storefront checks.

The 2026-09-29 current-product run passed nine of ten text/voice samples. The named-selection text sample reached the right product/actions but made an unnecessary exact-title search first. After clarifying identity reuse, both named-selection channels passed without that search. The other eight cases passed against the immediately preceding prompt; they were not rerun after this narrow clarification.

After the 2026-09-29 knowledge-base consolidation, all six adversarial text/voice samples preserved the requested category and opening, or returned no cards when nothing qualified. Each used two completions and one catalogue operation (12 requests total). Manual review confirmed the no-match text explanation; the assertion was broadened to recognize “haven't found” without another provider call.

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
