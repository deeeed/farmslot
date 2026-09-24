# Evaluate advisory failure triage

This is the evaluation slice for MANUAL-000128 in the
[structured-assessment plan](../plans/structured-assessment-evaluation.md).
It does not add a run watcher or operator triage action. MANUAL-000129 remains
gated by the frozen held-out evaluation.

## Corpus v1 is quarantined

The first corpus failed independent integrity review. Its definite-case packets
contained authored repair explanations also used in reference rationales; related
HTTP status variants crossed the development/held-out split. Its cue sheet was
authored with visibility of the case design, so it is an optimistic corpus-visible
comparator, not a blind baseline. The row-derived group IDs did not prove family
independence.

The frozen live run and corpus are retained, not relabeled or rerun. Their raw
numbers cannot establish comparative effectiveness. New live calls and pilot
eligibility are blocked for this corpus. A separately versioned, reviewed corpus
with raw incident observations and real family-disjoint provenance is required.
Do not remove the quarantine to repeat the held-out pass.

## Select the reviewed v2 experiment

V2 uses fault-time output, source and state from 24 controlled virtual component
faults, plus six unclear cases. Each definite reference derives from a passing
fixture, one component mutation, failure and successful restoration. Controls and
reference explanations stay outside provider input. The hash-bound methodology
review is in `scripts/failure-triage/corpus-v2-audit.md`.

The 21 held-out cases represent 16 families. External-service and unclear each
have only one family. Complete compact snapshots and explicit contracts make
this easier than sparse production diagnostics. Reports show family counts and
`familyWeightedAccuracy`, the equal-weight mean over families, and suppress independent-case confidence intervals
when variants repeat. These are descriptive synthetic results, not population
estimates. The existing classifier, v1 cue sheet and rubric remain unchanged.

From the installed checkout, first inspect the offline outputs:

```bash
yarn triage:evaluate --corpus v2 --out temp/triage/v2-development --split development
yarn triage:evaluate --corpus v2 --out temp/triage/v2-held-out-offline
```

Output directories must be new. The default remains offline even when the gateway
setting and API key are present. Omitting `--corpus` selects quarantined v1 for
historical inspection. Only explicit v2 selection can pass the integrity guard.

After freezing the source, rubric and baselines, candidate evaluation is explicit:

```bash
yarn triage:evaluate --corpus v2 --out temp/triage/v2-held-out-live \
  --live --provider typesafe --model jev-1.13.0
```

`source-manifest.json` records code hashes; corpus, packets and questions also carry
hashes. Preserve every attempt. Do not regenerate or tune held-out cases after
candidate inference. A negative result is a valid outcome, not a reason to rerun.

The TypeSafe adapter reads `TYPESAFE_API_KEY`. No key is accepted in arguments.
Only the two pinned synthetic corpora are admitted. Arbitrary packet/file inputs and
unknown options are rejected; public/company data import is not implemented.

One attempt per selected case, no retries or model fallback. Limits are 60 calls,
USD 0.10 and 10 seconds per request, configurable downwards. The current supported
price snapshot is in `scripts/failure-triage/prices.json`; it must match the
requested model and be verified within seven days. Its full-request token bound
is reserved before dispatch. Missing usage retains an unknown charge covered
by the reservation. Price estimates are not invoices. Paid-output models are
held until an appropriate output bound is implemented.

Useful smaller experiments use `--split development` or `--case <opaque-id>`.
They cannot pass the held-out pilot gate. Every repetition retains the same
corpus/case identities and writes a separate output directory.

## Recorded v2 result

The frozen held-out pass on source revision `913a7782` passed the predeclared
classification gate. Its [report](../../scripts/failure-triage/results/v2-held-out/report.md)
and raw receipts retain every attempt. Development and held-out runs used identical
source hashes, rubric and baseline versions with no tuning between batches.

- 17/21 correct across 16 families; familyWeightedAccuracy 0.75, the equal-weight mean over families.
- Four extra abstentions; all 14 definite answers correct; 14/18 definite-case coverage.
- All three unclear cases abstained. No unavailable responses or unknown charges.
- The separate model-selected next check was correct only 11/21 times. The pilot
  must use the existing deterministic cause-to-check map; raw answers remain in receipts.
- Macro-F1 0.80 versus 0.33 for diagnostic cues and 0.036 for the existing classifier.
- Held-out usage: 26,035 input and 4,305 output tokens, estimated USD 0.00109347.
  Median provider latency 347ms, batch duration 8.2s.
- Including the nine development calls: 30 attempts, estimated USD 0.001547238.

Both frozen baselines are v1 text classifiers that cannot interpret v2's structured
state. A post-hoc rule using component ownership scored 18/21 and macro-F1 about
0.81, slightly above the model. The recorded gain over the frozen baselines does
not establish an advantage over a cheap rule suited to v2. This diagnostic was
not used to alter the frozen gate or tune model inputs. The reproducible
[diagnostic result](../../scripts/failure-triage/results/v2-slot-shortcut.json) is
separate from the immutable live receipts:

```bash
node scripts/failure-triage/analyze-v2-shortcut.mjs /tmp/new-shortcut-result.json
```

The result satisfies the original bounded on-demand pilot prerequisite. It does not enable a
production call site, establish real-log accuracy or prove workflow savings.
The compact synthetic contracts and small family counts limit interpretation.

Verify the pilot prerequisite before configuring its eventual call site:

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/verify-pilot-evidence.mts scripts/failure-triage/results/v2-held-out
```

The verifier pins the approved receipt manifest, checks every artifact hash and
recomputes the gate from references and per-case responses. Missing, changed or
handwritten `eligible=true` reports are rejected. This grants only the recorded
provider/model/rubric identity, not permission to export an arbitrary run.

## Read the report

`report.md` and `evaluation.json` show both baselines, candidate confusion matrix,
macro-F1, definite precision/coverage, unclear-case abstention, next-check accuracy,
evidence-reference validity, attempt counts, known/unknown charges and latency.
Per-attempt status/reason codes are in `candidate-results.json`. Next-check
references are derived from labels, so this metric is not independent diagnostic
utility evidence.
`candidate-results.json` persists reservations before calls; a surviving `started`
entry is unfinished, not a successful result. JSONL is the completed batch export.

A pilot first needs a passed corpus-integrity review, then all 21 held-out cases completed live, no data/authority violations,
all three unclear cases abstaining, definite precision at least 0.85, coverage at
least 0.60, macro-F1 at least 0.05 above the stronger baseline, and respected
budgets. Otherwise the decision is `hold`. Transport fixtures always report
`liveStatus=fixture` and cannot qualify. Offline reports say `not_run`.

`efficiencyClaim` stays `not_established`. Correct diagnostic classification is
a proxy; operator time and whole-workflow token savings need matched trials.

## Draft multi-turn navigation pilot

`navigation-cases.v2.json` and `navigation-reference.v2.json` are revised,
`draft-unsealed` synthetic cases. Corpus revision v2 uses the existing reference
schema version 1; `navigationReferenceHash` accepts it, but the scoring CLI
requires `status: frozen` before a live comparison. The original v2 draft failed
independent review on September 24, 2026 because source names and order exposed
the intended answer, some families overlapped, and some labels were debatable.
The first revision also failed independent review: semantic source IDs and
overlapping mechanisms still cued the answer. The current draft uses per-case
opaque source IDs and generic evidence-type titles; its dependency and remote
certificate cases replace the overlapping resource and endpoint cases. It still
requires independent review of its labels, families and evidence paths. Do not
seal it or call a provider yet.

Five revised cases have a single decisive read and three require two reads. The
required sources span all four positions. They require Runtime output,
Application output, and Application state in separate cases. No required title
appears more than three times. IDs carry no diagnosis.

The source titles are still synthetic evidence categories, so they can affect a
reader's first choice. Titles and order alone must be tested in a fresh
baseline-only feasibility pass after an independent reviewer accepts the labels,
families, and evidence paths. Keep that pass outside the paired score. It cannot
measure advice savings. Freeze the reviewed cases, reference, worker limits and
comparison method before calling the advice provider.

The revised case-file SHA-256 is `2ffd28345d5481dc183d1bca46ca21e423e6bac76128fcdaa7b4f8387a64348a`;
the reference-file SHA-256 is `f27ab14c88b50c9ac637fe7c97fbbf5dfde1bc982e4118c877558de7ff53f7a2`.
The reference remains unsealed pending that review, feasibility check, frozen
method, and approval. Keep v1's frozen hashes and results unchanged.

`navigation-cases.v1.json` has eight reviewed synthetic cases. The separate
`navigation-reference.v1.json` holds their labels and source requirements; no
provider request loads that file. Its reference status is `frozen`; this still permits only a small exploratory study.
The case-file SHA-256 is `48caa3a48f03e26dda23ecdd7fcdaff90194f5a52127910d8da321a615e84e69`;
the reference-file SHA-256 is `9a864f676cd188f2ec7e5ffc82c2730a6badce53e70c5dd416d286c5033febcc`.
They cover overlapping incident families, so treat the eight pairs as an
exploratory workflow study, not a general efficiency estimate.

The advice stage asks the configured structured-assessment provider to choose a
first evidence source from a supplied failure summary and source titles. It does
not ask for prose or a cause. TypeSafe Jev uses its Choice endpoint; a
Responses-compatible LLM can supply the same Choice via the existing adapter.
A separately configured text-generating worker sees the same sources and
instructions in both arms, with the source suggestion added only to the
assisted arm. Each session can read at most two named sources in three turns;
case order alternates arms. Unread source text and reference labels stay out
of the advice request. Both live stages stop on unknown charges and never retry.

Run the offline checks and seal the advice input first:

```bash
./node_modules/.bin/tsc -p scripts/failure-triage/tsconfig.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx --test scripts/failure-triage/workflow-navigation*.test.mts
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts seal-advice scripts/failure-triage/navigation-cases.v1.json /tmp/navigation-advice-plan.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts quote-advice /tmp/navigation-advice-plan.json /tmp/navigation-advice-config.json
```

The price snapshot in each config needs its own verified source and timestamp.
`quote-advice` and `quote-worker` print plan and config hashes, conservative
request/token/USD estimates; neither makes a call. Each preflight reserves 1024
bytes for the request envelope and schema beyond the visible content, then
stops on unexpected measured usage. Provider-side hidden tokens mean the quote
is a spend estimate, not a provider-enforced account limit. An independent reviewer must check the
methodology, case hash, provider and verified price, then create a JSON approval
with `planHash`, `configHash`, `methodologyHash` (SHA-256 of the method file),
`journalPath`, `reviewer` and `conclusion: "approved"`. Both live commands require
`TYPESAFE_API_KEY` for TypeSafe advice and `STUDY_API_KEY` for the worker
(or an LLM advice provider). Both commands consume their approval exactly once. Keep plans, approvals, journals and results outside the tracked tree.

After advice generation, inspect each chosen source and receipt for label
leakage, then seal and quote the paired worker plan. Review its separate method,
price and approval before running it:

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts advice /tmp/navigation-advice-plan.json /tmp/navigation-advice-config.json /tmp/navigation-advice-method.md /tmp/navigation-advice-approval.json /tmp/navigation-advice-journal.jsonl /tmp/navigation-advice.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts seal-worker scripts/failure-triage/navigation-cases.v1.json /tmp/navigation-advice-plan.json /tmp/navigation-advice.json /tmp/navigation-advice-journal.jsonl scripts/failure-triage/navigation-reference.v1.json /tmp/navigation-worker-plan.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts quote-worker /tmp/navigation-worker-plan.json /tmp/navigation-worker-config.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts worker /tmp/navigation-worker-plan.json /tmp/navigation-worker-config.json /tmp/navigation-worker-method.md /tmp/navigation-worker-approval.json /tmp/navigation-worker-journal.jsonl /tmp/navigation-sessions.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts blind /tmp/navigation-worker-plan.json /tmp/navigation-sessions.json /tmp/navigation-blind.json
```

A reviewer judges the blind rows before looking at arms, advice or costs.
The export omits case IDs because their names can reveal the intended diagnosis;
keep the case-to-blind-ID mapping in the sealed plan outside the review packet.
A reviewer records a JSON judgment containing `version: 1`, the blind packet's
`hash` as `packetHash`, the worker method's SHA-256 as `methodologyHash`, a
`reviewer` ID, and exactly one `{blindId, decision, reason}` for every row in
`decisions`. Do not provide the sealed plan or source-reference file to that
reviewer until their judgment file has been saved.
Mark `accepted` only for a supported cause (or justified `unclear`), a useful
read-only next check, and evidence actually read. Map each blind ID to
`accepted`, `rejected` or `unresolved` with a concrete reason, then run `score`
with the worker plan, sessions, frozen reference, blind packet, judgments,
worker method, worker journal and report path. The scorer rejects claimed
acceptance when the answer label or required evidence IDs disagree with the
frozen reference. The report includes all
pairs, quality regressions and advice-inclusive totals. Missing arms, missing
wall time, unresolved judgments or unknown charges are inconclusive. The current
blind export accepts one independent rater per answer. Record that reviewer,
retain their per-row reasons outside the tracked tree, and flag ambiguous rows
`unresolved`; do not call a single-rater result independently replicated.

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/failure-triage/workflow-navigation-cli.mts score /tmp/navigation-worker-plan.json /tmp/navigation-sessions.json scripts/failure-triage/navigation-reference.v1.json /tmp/navigation-blind.json /tmp/navigation-judgment.json /tmp/navigation-worker-method.md /tmp/navigation-worker-journal.jsonl /tmp/navigation-report.json
```

The scorer counts the first read of a required source, even when a case needs
another read. A zero-read arm counts as a miss; no-read counts remain visible.
Read/turn totals cover only equal-quality accepted pairs, with that conditional
denominator reported separately for named advice and abstentions. Those totals
do not establish overall savings. Compare advice-inclusive tokens, time and
independently judged quality before claiming efficiency.

Compare results by incident family and do not infer a population-wide gain from
eight synthetic cases.

### Recorded exploratory run

The first paired run used TypeSafe `jev-1.13.0` for the eight advice calls and
`gpt-6-luna` through the local `codex-lb` Responses route for both worker arms.
All 16 sessions answered in 48 attempted/completed turns. An independent rater
judged the blind answers before scoring against the frozen reference. The
scorer returned `inconclusive`: two cases were assisted-better, four were
rejected in both arms, and two had equal accepted quality. No case regressed
from an accepted baseline to a rejected assisted answer.

Both assisted-better cases had **no named TypeSafe recommendation**. The
assisted arm instead received an abstention message, so those gains cannot be
attributed to a recommended evidence source. On the two equal-accepted pairs,
assisted totals including first-use advice overhead were 3,774 versus 2,550
tokens (+48%), 16.49 versus 14.91 seconds (+10.6%), and $0.00044898 versus
$0.00039260 (+14.4%) at published API-equivalent rates. The local load
balancer's actual billing is unknown. The other six pairs have differing or
rejected quality, so a study-wide efficiency total is deliberately absent.
Do not rerun or retune this frozen corpus to seek a positive result. A new
study would need to isolate named hints from the abstention-prompt effect and
freeze new cases before further candidate calls.
All five named hints matched the baseline first read. Seven of eight references require two reads, the study limit, so this corpus could not demonstrate fewer reads for those cases. For new results, a provider abstention is recorded as null advice: the assisted worker receives the same prompt as the baseline for that case, while the advice call remains in assisted token, cost and time totals. Old sealed results and their generic abstention text are unchanged. Before another live study, independently review and freeze fresh cases with enough optional evidence and read budget for a better first choice to save work. Report named-hint and abstention cases separately, and retain advice-inclusive totals.

Private raw plans, approvals, journals, blind judgments and the scored report
are retained at `temp/triage/navigation-v1-luna/` in the operator checkout.
This gitignored folder is local evidence, not a published study artifact.

## Verify the boundaries

```bash
export TRIAGE_PROOF_OUT=/tmp/triage-proof-new-run
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json \
  node --import tsx scripts/failure-triage/prove.mts "$TRIAGE_PROOF_OUT"
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json \
  node --import tsx scripts/failure-triage/prove-v2.mts "$TRIAGE_PROOF_OUT-v2"
```

The living recipe is `scripts/runner-validation/failure-triage-evaluation.recipe.json`.
It invokes the real CLI through offline and explicitly simulated transport paths,
checks run/slot fixture snapshots and preserves proof JSON. No live provider
request is made by the proof. Do not interpret its passing status as model quality.

Rubric v1 also rejects a definite cause paired with `evidence: none`. Controlled
rejection sub-codes now distinguish answer shape, label/check vocabulary,
fabricated evidence, absent support and invalid confidence. The two invalid
responses in the original live run remain unattributed because those codes were
not recorded then. That run exceeded the pre-existing classifier by +0.554
macro-F1, but failed completion and abstention gates even without the cue sheet.
This arithmetic does not repair the corpus-integrity failure.

V1 quarantine takes precedence over key, price and budget diagnostics on its
live path. The proof records those cases as quarantine outcomes; simulated
transport exercises dollar/call budgets and response handling. No-network proof
is not evidence of live model quality.

## PR-preview regression proof

`scripts/runner-validation/pr-preview-no-assessment.recipe.json` covers the removed
inference hook and resumable discovery. Its second node owns a temporary gateway
and a local GitHub CLI fixture. It proves incomplete progress, persistence across
restart, cursor continuation and cancellation isolation without external requests.
Set a fresh `PR_PREVIEW_RESUME_OUT` and free `PR_PREVIEW_RESUME_PORT` for that node.

Only checkpointed bulk PR discovery gets the new wall-clock GraphQL budget,
including time queued for GitHub transport. `FARMSLOT_PR_SOURCE_BUDGET_MS` can lower
its 45-second default. Single-PR target/submission reads retain their prior behavior.
Authentication, local validation and other RPC work are outside this budget; it is
not an end-to-end RPC deadline.
