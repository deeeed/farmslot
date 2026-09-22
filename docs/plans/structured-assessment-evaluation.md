# Structured assessment evaluation plan

**Status:** Approved supporting plan for [ADR-061](../adr/061-structured-assessment-providers.md)
**Scope:** Farmslot gateway assessment providers and eval-package comparison

This plan validates the provider boundary before any assessment result is used
to route or review real work. Recipe planning remains in `mm-harness`.

## Opt in locally

Set the key in the gateway's execution environment. A key alone does nothing.
Enable the feature and select a provider explicitly:

```bash
export TYPESAFE_API_KEY="..."
export FARMSLOT_ASSESSMENT_ENABLED=true
export FARMSLOT_ASSESSMENT_PROVIDER=typesafe
export FARMSLOT_ASSESSMENT_MODEL=jev-1.13.0
```

The equivalent persisted file is `~/.farmslot/assessment-config.json`. It must
contain only `enabled`, `provider`, `model`, `timeoutMs`, and `maxStateBytes`.
Use the gateway-local commands to inspect and test the setup:

```bash
cd apps/command-center
yarn farmslot rpc assessment.status '{}'
yarn farmslot rpc assessment.test '{"provider":"typesafe","model":"jev-1.13.0"}'
```

`assessment.status` never calls the provider. `assessment.test` sends only a
synthetic color question. Missing credentials return `skipped`; an upstream
failure returns `unavailable`; neither changes a run.

## Review-intake pilot

Run the same static PR intake corpus twice:

1. control: assessment disabled;
2. candidate: assessment enabled with a pinned provider/model.

The candidate receives only PR identity, title, and an allowlisted set of
normalized facts. It does not receive the head SHA, existing review
observations, or screenshots. The advisory
classifies risk, visual-review need, and a review surface. It is attached to the
preview item and never changes `match`, execution, review profile, admission,
publication, or merge state.

Compare against a human/strong-model reference for:

- risk classification accuracy;
- visual-review recall, with false negatives counted as blocking;
- uncertain-routing recall;
- latency, input/output tokens, and provider cost;
- behavior when the provider is disabled, unavailable, over size limits, or
  returns malformed typed answers.

Create one Reference result package for the existing review corpus and one
Candidate package for the assessment-assisted lane. Add an `assessment` axis
to the candidate strategy and use the `structured-assessment` scorer kind for
the advisory comparison. Keep the packages artifact-only and do not publish
PR comments from this experiment.

## Exit criteria

The pilot is useful only if it improves visual-review recall or routing quality
without increasing false approvals, and the normal disabled path remains
byte-for-byte behaviorally unchanged. A low-confidence or unavailable answer
must abstain with `needs-review`, never to a cheaper one. If the
reference comparison does not show a useful gain, keep the provider adapter
available for explicit experiments but do not enable it in review defaults.

## Follow-up: assessment monitoring and effectiveness

**Status:** Implementation authorized; separate worktree and PR. Merge only after
independent cross-review and green CI on the final commit.

### Questions the product must answer

1. Was advice requested, completed, skipped, or lost to an outage?
2. What did the provider answer, and what did gateway policy recommend?
3. Did an operator see or use that advice, and was it correct?
4. Does using advice save total review time or tokens at equal review quality?

A completed API call answers only the first question. Preview suggestions do not
currently change reviewer selection. Do not display inferred savings or count a
successful PR as proof that its assessment was correct.

### Durable records and responsibility

The gateway owns versioned assessment records under `FARMSLOT_HOME`. Record an
attempt before provider dispatch and its terminal result afterwards. A restart
leaves unfinished attempts explicitly interrupted, never successful. Keep a
separate assessment store rather than forcing records into the recovery-action
schema, which requires a run and an applied recovery action.

Each record carries an ID, authenticated owner, consumer, timestamps, PR identity
and frozen head SHA, optional run link, question-schema and routing-policy
versions, prepared-input digest when available, requested/returned provider model, typed answers,
probabilities, confidence, abstention/reason codes, usage, provider latency and
end-to-end duration. Head SHA is provenance and need not be sent to the provider.
Do not persist titles, raw diffs, full state, secret values, or upstream error
bodies. Unknown monetary cost stays unknown. Estimate fields must name their
price version and never masquerade as billed spend.

A disabled preview records its requested assessment as disabled. Ordinary run
polling does not manufacture assessment attempts. Budget-exhausted items are
explicitly skipped, not silently missing. Smoke tests are a separate consumer
and excluded from production effectiveness totals. Repeated previews remain
counted as actual calls/spend but are deduplicated by PR/head/question/model for
accuracy statistics. Audit write failure suppresses that optional provider call
and reports monitoring degraded, without blocking the original PR workflow.

RPCs expose owner-scoped paginated history, details, aggregate metrics and
structured feedback. Use existing auth and protocol method registration, with
no direct UI filesystem access. Default history and artifact retention is 30 days; report retained
coverage and never imply that the view contains deleted history.

### Presentation

Add an Assessments tab to the existing Intelligence route and link to an
assessment from its PR preview. Show:

- consumer and PR/head, completion status and skip/failure reason;
- raw model answer separately from the gateway recommendation;
- confidence/uncertainty, conflicts between questions and missing context;
- latency, tokens, known cost, repeated calls and audit health;
- feedback and links to the reviewed evidence.

The detail view states "advisory only; no action applied". Later consumers must
record their actual action explicitly. An active fix-bug run with no assessment
shows "not assessed by this integration", never a green assessment badge.

### Uncertainty policy

Low confidence, missing context and contradictory questions produce
`needs-review`, with no recommendation to reduce existing review requirements.
Retain the raw answers so the operator can see why the gateway abstained. The
observed multimodal choice with confidence 0.18 and visual probability 0.53 is
a required regression case. Absence of an assessment is unknown, not approval.
Confidence thresholds are versioned experimental policy, not calibrated truth.

### Effectiveness evidence

Collect per-question operator labels (correct, incorrect, insufficient context),
corrected outcomes, evidence references, and whether advice was shown or used.
Feedback revisions are attributable and preserve the original assessment. An
operator's agreement is not independent ground truth; keep it separate from
blinded reference labels. PR merge/approval is not a risk or visual-need label.

Start with an explicitly frozen, stratified reference set of at least 30 PR heads,
covering visual, state-only, security-sensitive and ambiguous cases. This is a
pilot, not a statistically sufficient proof by itself. Independent strong-model
or human labeling is performed before revealing candidate answers; disagreements
require adjudication. Keep tuning cases separate from held-out evaluation.
Store references and candidate results as immutable eval artifacts linked by
package hashes, input/question/policy/model identities and PR/head.

Report accuracy per question, visual false negatives and false positives,
coverage/abstention, disagreement counts, latency percentiles, and total tokens
including failed attempts. Every percentage includes numerator, denominator,
and unlabeled count; confidence intervals expose small samples. Do not blend
providers, model revisions or routing policies into one quality score.

Workflow efficiency requires a separate opt-in baseline-versus-assisted trial:
same frozen PR task, same reviewer model and effort, matched context, independent
sessions and counterbalanced order. Baseline sees no advice; treatment sees it.
Measure time to usable review, total tokens including assessment, rework and
independently adjudicated findings quality. A suggested initial target is 20%
lower total tokens or elapsed time with no lost confirmed critical findings;
freeze the target before running and report inconclusive results honestly.
Monitoring-only shadow calls cannot establish causal savings.

### Delivery and proof

Deliver durable capture and uncertainty policy first, then the Intelligence/PR
views and feedback, then an effectiveness report over frozen eval artifacts in
the same follow-up branch. Do not turn the new scorer-kind enum into a claim
that an evaluation runner already exists.

Acceptance criteria:

- Live gateway requests survive restart as bounded, owner-scoped records; skipped,
  failed, interrupted and completed outcomes are distinguishable.
- Missing key, disabled policy, oversize input, provider outage, deadline and audit
  write failure are visible and leave admission/publication unchanged.
- Raw payload and credential sentinels are absent from files, RPC output and UI.
- The low-confidence contradictory fixture abstains and shows both model answers.
- Real browser interactions open assessment details and submit feedback, which
  survives gateway restart; screenshots and RPC reads prove the same record.
- Repeated same-head previews affect usage counts but not unique-case accuracy;
  smoke tests and unjudged cases cannot inflate accuracy.
- Frozen reference/candidate artifacts produce a reproducible report with
  denominators, exclusions and honest unknown savings; a missing pair cannot pass.
- Existing internal scans make no new provider calls. No advice automatically
  changes reviewer, runner state, visual proof, publication or merge authority.

### Non-goals

Recipe planning, automatic routing, screenshot inspection, model-auth changes,
new recovery actions, and claims of efficiency before the paired trial. Companion
UI parity can follow the shared RPC contract after the desktop flow is proven.

### Implementation reference

The operator workflow and RPC contract are documented in
[Monitor structured assessments](../../apps/docs/docs/guides/assessment-monitoring.md).
The paired comparison is descriptive. It validates imported metadata and hashes;
it does not verify the independence of sessions or findings quality. The initial
scorer supports the review-intake choice/boolean questions. Recipe planning and
image evaluation remain outside this lane.

For repeatable validation, use `scripts/assessment-validation/monitoring.recipe.json`
against an isolated gateway with orchestration disabled. Its startup fixtures are
synthetic, not evidence of provider quality. Run `seed.mts` with a dedicated
`FARMSLOT_HOME` containing `assessment-proof` and
`FARMSLOT_ASSESSMENT_VALIDATION=1`, then point `FARMSLOT_GATEWAY` at that gateway
and run `prove.mjs`. Rerun after restart to prove feedback and report persistence.
