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

## Run the baselines

From the installed checkout:

```bash
yarn triage:evaluate --out temp/triage/development --split development
yarn triage:evaluate --out temp/triage/held-out-offline
```

Output directories must be new. The default is offline even when the gateway's
assessment setting and API key are present. The bundled corpus has 30 cases,
with nine development and 21 held-out. The generator executes 24 controlled
fault/repair pairs and supplies six ambiguous, mixed or injected-instruction
fixtures. Reference fields were excluded structurally, but repair commentary leaked
semantically into the packets; that is one reason v1 is quarantined.

The existing classifier and frozen diagnostic cue sheet see the same redacted
packets as the candidate. Unmapped or conflicting diagnostic cues abstain.
`source-manifest.json` records code hashes; the corpus and every packet/question
also carry hashes. Regenerating the corpus starts a new experiment, never a way
to tune held-out cases after seeing candidate answers.

## Candidate command and current hold

This command currently returns `not_run` with `corpus-integrity-failed` when the
key, price and budget checks pass. It cannot send v1 packets again:

```bash
yarn triage:evaluate --out temp/triage/held-out-live \
  --live --provider typesafe --model jev-1.13.0
```

The TypeSafe adapter reads `TYPESAFE_API_KEY`. No key is accepted in arguments.
Only the bundled synthetic corpus is admitted. Arbitrary packet/file inputs and
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
