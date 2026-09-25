# Structured assessment evaluation and delivery

**Status:** Decision-advice observability pilot met on 2026-09-25; failure-triage
evaluation remains active. Supports
[the near-term roadmap](../ROADMAP-next.md) and the provider boundary in
[ADR-061](../adr/061-structured-assessment-providers.md).

## Correct the scope

The provider adapter and monitoring infrastructure shipped. Automatic PR-preview
classification did not demonstrate a workflow benefit and is being removed.
It did not complete the original failure-triage backlog items, MANUAL-000128
and MANUAL-000129. Transport success is not evidence of effectiveness.

Closeout requires one admitted public or synthetic run. Its TypeSafe answer
or abstention, provider/model, usage, cost and latency must appear in the run
panel; its decision context and feedback form must appear in Intelligence >
Assessments. This happened on 2026-09-25 for a public-PR-backed run; the
model abstained. Accuracy and workflow savings remain unmeasured and are not
required to keep the pilot opt-in.

The original consumers below are possible follow-ups, each requiring separate
scope approval. None is required to close this goal.

| Consumer                           | Useful outcome to test                                                | Comparison                                                    |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Recorded-failure triage            | Correct cause and useful read-only next diagnostic                    | Existing deterministic classifier plus a diagnostic cue sheet |
| Textual AC/evidence assessment     | Supported, contradicted or insufficient evidence for a supplied claim | Known-case labels and unassisted validation                   |
| Static-review checklist assessment | Accurate per-item findings and applicability                          | Known defects or an independent strong-reviewer reference     |
| Copilot context support            | Less context and fewer diagnostic steps at equal task quality         | Matched unassisted copilot tasks                              |
| Meaningful review-routing advice   | Correct review/validation path at lower total cost                    | Existing routing and matched review tasks                     |
| Pending decision advice            | Better human choices among existing, meaningful actions               | Same decisions without advice; matched quality, time and cost |

Exclude recipe planning, composition, parameterization, recipe/result quality
scoring and mm-harness changes. A text-only provider cannot validate screenshot
pixels. Structured runner state remains authoritative; failure content is only
assessed after a recorded failure establishes the condition. Publication,
recovery and dispatch retain existing owners and human gates.

## Failure triage first

The initial v1 corpus is quarantined after review found repair-commentary leakage
and incident-family overlap. Its frozen live run is not valid comparative
effectiveness evidence. MANUAL-000128 remains unfinished until a separately
versioned, methodology-reviewed corpus meets the specification. No repeated v1
live calls or operator pilot are permitted. V2 has a separate hash-bound methodology
audit and explicit corpus selection. Its frozen held-out pass meets the original
classification gate, as recorded in the [evaluation guide](../operations/failure-triage-evaluation.md).
The operator pilot and workflow efficiency study remain unfinished.

MANUAL-000128 defines the first experiment. Its detailed local backlog spec
remains authoritative:

- Thirty synthetic known-cause cases. Four each for environment, dependencies,
  implementation, test harness, missing evidence and external service; six
  ambiguous/mixed cases labeled unclear.
- Freeze nine development and 21 held-out cases before candidate calls. Keep
  incident variants in one split. Hide reference labels and rationale from input.
- Reuse `classifyFailureText` unchanged and freeze a diagnostic cue-sheet baseline.
- Return constrained cause, next-check and supplied evidence IDs. No commands.
- Offline by default; one request per case, no retry/fallback, at most 60 calls
  and USD 0.10 per explicitly live batch. Reserve conservatively before dispatch
  using a verified provider/model price snapshot. Unknown pricing blocks calls;
  missing usage is not zero cost.
- Admit only the bundled synthetic corpus initially. Reject unknown/private or
  altered input before transport. Bound required data, omit whole optional
  excerpts with an omission manifest, and test credential/prompt-injection cases.
- Report confusion matrix, accuracy, macro-F1, definite-answer precision and
  coverage, correct abstention, evidence validity, all attempts, tokens, cost and
  provider/end-to-end latency, with denominators and uncertainty intervals.

The pilot gate requires a complete live held-out evaluation; no data, secret or
control-authority violations; no definite answers on unclear cases; definite
precision at least 0.85; coverage on definite cases at least 0.60; and macro-F1
at least 0.05 above the stronger deterministic baseline, within budget.
A failed, missing or inconclusive evaluation reports `hold`. Do not retune the
corpus until the provider wins. Efficiency remains unestablished without a
separate timed workflow comparison.

MANUAL-000129 adds an on-demand recorded-failure action only when the predecessor's
immutable report and manifests establish `pilotGate.eligible=true`. A negative
benchmark completes the evaluation, not the operator pilot.

## Observable impact

For each subsequent consumer, freeze the hypothesis, rubric, reference labels,
baseline, held-out cases and quality floor before running candidate calls.
Use the existing assessment/evaluation infrastructure where its contracts fit;
do not duplicate planners or replace deterministic mechanisms.

The operator must be able to inspect:

- Consumer, project/case/run, source and rubric/model versions.
- Each typed answer, evidence references, abstention or failure, and any actual
  advice use. A suggestion is not an applied action.
- All attempted calls, known usage and unknown charges, latency and declared
  price provenance. Include failed/repeated attempts in accounting.
- Baseline and assisted quality on identical cases, exclusions and denominators.
- Paired total workflow tokens, cost and elapsed time at equal independently
  adjudicated quality. Label missing pairs or metrics inconclusive; never infer
  avoided calls or minutes saved from model confidence or successful runs.
- A per-consumer pilot/hold decision and measured improvement, regression or
  inconclusive result on the evaluated sample. Keep providers and rubric/model
  versions separate for accuracy.

Experiment observability is needed to establish evidence. It does not authorize
routine calls or bypass the failure-triage pilot gate. Keep each integration
opt-in; company/provider approval does not itself demonstrate utility.

## Pending decision advice pilot

[Issue #719](https://github.com/deeeed/farmslot/issues/719) and the [pilot procedure](../operations/decision-advice-pilot.md) record the separately approved
opt-in pilot for pending run-backed collision decisions. Profile-fit gates are
excluded until they offer a second non-decline action and have a separate
frozen fixture. For eligible collisions, ask on demand and only after the
operator admits the exact public or synthetic input and sets a provider,
model, verified price and spend limits.
Treat a `manual` ticket label as neither source approval nor public evidence.
The provider chooses only among current gateway action IDs or abstains. Advice
never resolves the decision, selects an action in the UI or authorizes recovery.

Freeze labeled cases and a no-advice baseline before candidate calls. Measure
valid selections, correct abstentions and mistaken confident choices across
collision cases. Compare matched operator decisions at equal independent quality and record
assessment overhead, all calls and unknown charges in total token/cost/time
results. No matched human decision timings means workflow efficiency remains
unknown, even if the classification result is accurate. Keep this experiment
separate from the recorded-failure and review-routing pilot gates.

## Delivery checks

Maintain the acceptance/evidence ledger in the active goal's worktree. Produce
real CLI/RPC proof and CDP proof for UI behavior, including failed/disabled
requests, persistence, bounded spend and unchanged authoritative workflow state.
Update relevant docs/changelogs and link implementation to its original backlog.
Independent cross-model review and green applicable CI on the exact reviewed
commit are required before merge. Do not mark an unimplemented consumer complete.
