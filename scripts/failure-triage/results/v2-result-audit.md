# Failure-triage v2 result audit

Verdict: PASS. The valid held-out result meets MANUAL-000128's predefined evaluation gate and supplies the evaluation prerequisite for MANUAL-000129's limited pilot. No result-audit blockers or nits remain. This conclusion does not by itself approve a pilot implementation or certify all implementation acceptance criteria.

No provider calls or worktree edits were made during this review. Calculations used an independent Python implementation, not the evaluator's metrics code.

## Identity and preservation

Both live batches record clean revision `913a77829b3af5a5a8c06f1ea725fb2b1fdbd5de` and source snapshot `5aeff86098344c0bf333c1f28216a3333c69a631572ffc5f748d5abb1d955f59`. I recomputed the source-manifest hash and checked every listed source against that revision. Rubric/packet code, both baseline adapter code and the underlying classifier are unchanged from the previously reviewed base `eb1bee8b`. Both batch manifests contain the same admitted corpus, hash `f678519daa6c014922e1f89a046ec22e4985cb2d1a2155047674e781c3d13d62`.

Development completed before held-out began. Every corpus case has one recorded request, with 30 distinct case IDs and request IDs across both batches. Candidate JSON and JSONL agree. Baselines and candidate rows use identical packet/question hashes per case.

All eight original files in each `/tmp/farmslot-triage-v2-{development,held-out}-live` directory now have exact-byte copies under `scripts/failure-triage/results/{v2-development,v2-held-out}`. All 16 hashes in the added receipt manifests match. The initial incomplete-copy observation was resolved without changing original artifacts.

## Independent held-out calculation

| Measure | Existing classifier | Cue sheet | Candidate |
| --- | --- | --- | --- |
| Correct | 3/21 | 9/21 | 17/21 |
| Macro-F1 | 0.035714 | 0.333333 | 0.800000 |
| Equal-family accuracy | 6.25% | 25% | 75% |

Candidate definite precision is 14/14, coverage is 14/18, and all three unclear cases abstained. The four missed definite cases were abstentions: two test-harness and two missing-evidence cases. All 21 evidence references identify supplied evidence. Next-check labels match the reference in only 11/21 cases; this is weaker than cause classification and should remain visible.

All predefined gate checks pass: admitted audited corpus, 21 completed live held-out requests, zero recorded safety violations, all unclear cases abstain, precision at least 0.85, coverage at least 0.60, macro-F1 gain 0.466667 over the stronger baseline, and budget respected.

Development remains visible: 6/9 correct, one incorrect definite classification, definite precision 3/4. It was not used to satisfy the held-out gate, and no source adjustment occurred between batches.

## Accounting and limits

Development used 9 requests and estimated USD 0.000453768. Held-out used 21 requests and estimated USD 0.001093470. Total: 30 recorded attempts, 36,839 input tokens, 6,156 output tokens, estimated USD 0.001547238 and reserved USD 0.082575360. All per-row costs reconcile at the frozen input rate; output price is zero. No unknown charges or unavailable results are recorded. These are provider-usage estimates, not invoice verification.

The 21 held-out cases represent 16 families. External-service and unclear each cover only one family. Full synthetic contracts/source make diagnosis easier than typical production logs. The frozen cue sheet is a weak comparator here and was originally designed against v1. These results support a limited diagnostic pilot, not broad model accuracy or production effectiveness.

`efficiencyClaim=not_established` is correct. Operator time, useful next actions, total worker tokens, and end-to-end completion quality still need paired workflow measurements.
