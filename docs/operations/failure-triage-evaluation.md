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

## Paired worker study

`MANUAL-000128` still needs a matched worker study. The offline study tool seals the
21 held-out v2 cases into two counterbalanced arms. Arm A receives the recorded
failure packet. Arm B receives the same packet and the frozen JEV advice that the
pilot would display. The worker never receives labels, rationale, provider
receipts or the post-hoc component-owner comparator.

The denominator is 21 paired cases, covering all 42 planned responses. Savings
compare pairs where both answers succeed; full-cohort spend is separate. A
reviewer judges whether each check is safe, specific and supported. Diagnosis is
scored against the frozen label. Invalid complete or incomplete replies with
known usage fail quality. First-use totals charge the recorded JEV tokens, cost
and duration once per assisted case.

The blind export includes bounded `rawAnswerText` for invalid structured replies.
The reviewer must inspect it for unsafe next steps even when `answer` is null.
An absent or unresolved safety verdict on a malformed completed or incomplete
reply leaves savings inconclusive. The gate permits zero unreviewed invalid
replies. Answers can reveal advice through copied check IDs; reviewers should
judge each row against its packet without trying to infer or compare arms, and
record any suspected arm inference as a study limitation.

Give the independent reviewer only `blind-review.json`. The reviewer must not
have access to this repository or study directory, since matching packet contents
to the frozen corpus could reveal the label. The generated private `blind-salt`
file stays in the study directory for repeat scoring and must not be shared. Keep
`plan.json`, `score.json`, the attempt journal and the frozen corpus separate
until adjudications are recorded; those files contain arm or answer-key information.

Preparing, scoring and adjudicating remain offline. They do not call a provider:

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/workflow-study.mts prepare /absolute/new-study /absolute/worker-plan.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/workflow-study.mts score /absolute/new-study /absolute/native-worker-attempts.json
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/workflow-study.mts score-journal /absolute/new-study /absolute/journal.jsonl /absolute/approval.json /absolute/frozen-methodology.md
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/workflow-study.mts adjudicate /absolute/new-study /absolute/decisions.json
```

`worker-plan.json` names the provider and model, HTTPS price source and date,
request limits, cache accounting and dollar cap. Each plan gets a unique nonce
and pins scorer, runner and transport hashes. Before paid calls, an independent
reviewer must approve the exact plan, source admission and price policy. Pin a
snapshot model ID if an alias can change its returned ID. Model mismatches
invalidate the row and stop the runner.

Providers must report cache counts where their multiplier differs from 1. Missing
counts leave cost unknown. Local proxies use `public-reference-only` pricing;
they cannot pass the token gate without direct measured cost, although known
quality or safety failures still fail. Offline `score` cannot claim savings.
`score-journal` checks the prior approval, and `adjudicate` checks its retained
snapshots. The token gate needs 16 equally successful pairs, 16 assisted
successes, a 20% first-use token reduction, no unsafe checks in either arm and
no baseline-success/assisted-failure regression. Separate 20% time and cost
thresholds label diagnostics. Missing receipts or metrics stay inconclusive.
The component-owner comparator is post-hoc; this study cannot prove wider
Farmslot workflow savings.

Only the separate runner sends worker requests. Set `STUDY_API_KEY` in its process
environment, then invoke it once with the frozen plan, a new absolute journal
path, an independent approval JSON, and this methodology file:

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
  scripts/failure-triage/workflow-study-runner.mts run \
  /absolute/new-study/plan.json /absolute/journal.jsonl \
  /absolute/approval.json /absolute/frozen-methodology.md
```

The approval JSON contains the reviewed `planHash`, methodology SHA-256 hash,
absolute `journalPath`, reviewer name and `"conclusion":"approved"`. A new path
needs a new approval. The runner records a one-use approval marker and syncs a
start before each request. It cannot resume or retry. An exception, unknown
charge, invalid receipt, missing usage or model mismatch stops further requests.
The transport has a 60-second timeout. A closed journal is required for approved
scoring. Snapshots prove internal consistency, not provider billing. Run
`score-journal` for this study, then give only `blind-review.json` to its
blinded reviewer.
