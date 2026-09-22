---
title: Monitor structured assessments
---

Open **Intelligence → Assessments** to inspect saved experimental assessments.
The history currently includes synthetic connection tests and historical PR-intake
advice. **PR rule previews and scheduled scans do not call the classifier.**
The earlier PR-metadata pilot has no demonstrated workflow benefit and its
automatic preview invocation has been removed.

A completed request means the provider returned an answer. It does not establish
correctness or lower workflow cost. Failure-triage evaluation and other consumers
must pass their own baseline comparisons before operator rollout. Recipe/result
assessment is outside the current implementation scope.

## Evaluate failure triage

The checkout-local `yarn triage:evaluate --out <new-directory>` command runs the
frozen failure-triage baselines offline. The initial corpus is quarantined for repair-commentary leakage and related
incidents crossing splits. `--live` is blocked for that corpus; no operator pilot
is enabled. Read the
result's per-baseline metrics and pilot/hold decision; it does not measure
operator time savings. This experiment does not create normal run classifications
or enable an operator pilot automatically.

## Inspect an attempt

History distinguishes completed, disabled, skipped, unavailable and interrupted
attempts. Interrupted means the gateway did not save a terminal result, including
a restart during a call. A storage failure suppresses the optional call and shows
an audit warning. The warning count covers the current gateway process only.

The `needs-review` recommendation means gateway policy abstained. Causes include
missing changed-path context, low confidence, an uncertain visual probability or
contradictory answers. The thresholds are experimental, not calibrated accuracy.
The detail view retains the provider's original answers.

For a question, submit an operator judgment and evidence reference. An incorrect
judgment requires a corrected answer. The form records that you saw the advice;
check **I used this advice** only if it affected your review. Revisions preserve
prior feedback. They remain observational labels, separate from independent
reference judgments.

## Read the numbers

- Usage counts every retained review attempt, including repeats and failures.
  Missing token usage is unknown. Smoke tests are excluded.
- Quality summaries use the earliest completed prediction for each PR/head and
  provider/model/question-schema/policy cohort. Labels on later attempts are not
  transferred to it. Each question shows correct, judged, insufficient-context
  and unlabeled counts separately.
- Provider latency covers responses with duration metadata. End-to-end latency
  also includes terminal failures. Interrupted calls have no completed duration.
- Efficiency savings stay unmeasured. A merged PR is not a correctness label.

## Freeze and score a sample

**Export effectiveness snapshot** downloads a frozen, content-hashed report.
When viewing a historical completed PR assessment, **Export selected case** freezes only its
PR/head/requested-model/policy cohort, including failures without a returned model.
Quality statistics still separate returned model versions. Use `assessmentId` in
the report RPC to select the same cohort. This keeps other PR usage out of a trial.

Use the shared RPCs from the checkout-local CLI:

```bash
cd apps/command-center
yarn farmslot rpc assessment.list '{"limit":50}'
yarn farmslot rpc assessment.summary '{}'
yarn farmslot rpc assessment.report '{}'
yarn farmslot rpc assessment.report '{"assessmentId":"<completed-assessment-id>"}'
yarn farmslot rpc assessment.report '{"id":"<report-id>"}'
yarn farmslot rpc assessment.evaluate '{"reportId":"<report-id>","references":[]}'
```

An empty reference set returns `inconclusive`. Each reference contains
`assessmentId`, `questionId`, `expected`, `evidenceRef`, `source` and `blinded`.
Source is `human` or `independent-model`; expected is a choice string or boolean.
Collect labels before revealing candidate answers. The importer declares
independence; Farmslot cannot verify how a label was produced.

Scoring reports per-question/cohort denominators, abstentions, unlabeled cases,
visual false negatives/positives and 95% Wilson intervals. Unused and rejected non-blinded references are reported separately. Abstention
is counted even without a reference, so abstained and unlabeled counts can
overlap. `excluded` counts records; `unsupportedQuestions` counts unscored
question types. A small sample or selective accuracy is not proof of safe routing.

The optional `pair` accepts hashed `baseline` and `assisted` result-package
manifests. They must be final, have distinct run IDs, matching objective, task,
source and reviewer axes, and no missing data. The assisted assessment axis
`ref` must equal the report ID. The report must contain one requested-model cohort for one PR/head
matching the packages' merged-PR source. Repeated calls may return different builds;
usage includes them all while accuracy remains grouped by returned build. Use explicit `ref` values for the model,
runner and review configuration, including effort in the review ref.

The report compares declared reviewer tokens and elapsed time. `assessmentTokensStatus` and `assessmentAttemptsMissingUsage` expose incomplete
usage. When all assessment usage is known, it also adds assessment tokens to the token delta.
Package `sessionTotalTokens` must exclude assessment tokens to avoid counting them
twice. Matching metadata does not prove independent sessions or equal findings
quality. Use blinded adjudication and counterbalanced order before claiming
savings. Start with a stratified pilot of at least 30 PR heads; keep tuning cases
out of the held-out evaluation.

## Storage and privacy

History is scoped to the authenticated owner and retained for 30 days, capped at
5,000 records across the gateway. Reads hide expired rows. New attempts prune
expired rows, with at most one sweep per minute. Records contain metadata and typed answers;
raw titles, diffs, model inputs and upstream error bodies are not stored.
Credential values known to the gateway are rejected. Use evidence references,
not copied review bodies, in feedback.

Reports and evaluations live in owner-scoped directories under `FARMSLOT_HOME`.
They expire after 30 days and are pruned on subsequent writes, with at most 100
artifacts per kind per owner and 20 MiB per artifact. Download reports you need
to keep longer. Imported package bodies are not persisted, only their hashes
and derived metrics. A failed write or expired artifact is an error, not success.
