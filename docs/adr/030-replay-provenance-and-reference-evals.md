# ADR-030: Eval Experiments and Result Packages on Run Families

**Status:** Accepted
**Date:** 2026-05-09
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-018](018-dev-flow-interactive-autonomous.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-025](025-run-family-observability.md), [ADR-027](027-unified-gateway-state.md), [ADR-029](029-production-logging-intelligence-evidence.md)

## Context

Farmslot already has most of the raw material needed to evaluate agent output:

- run families from ADR-024
- execution lanes: `production`, `validation`, and `comparison`
- run artifacts, diffs, screenshots, videos, logs, recipes, and review signals
- family observability from ADR-025
- local-first PR publication packages for `fix-bug`

The missing product concept is not a second “line” taxonomy, and it is not a new top-level `replay` flow. The missing concept is an **experiment** over **result packages**.

A human evaluating a prompt/template/harness/model change does not only compare two run IDs. They compare the packaged output of each trial:

- what code changed,
- what base/head commits were used,
- what screenshots/videos/logs/recipe evidence were produced,
- what self-review or independent review found,
- what acceptance criteria or bug reproduction proof was covered,
- and whether the package proves the original objective.

This applies differently by task profile:

- For `fix-bug`, the package must prove the original bug was reproduced or understood, fixed, and not regressed.
- For `dev`, the package must prove the requested feature or acceptance criteria were implemented.

The eval-experiment foundation work surfaced this architecture gap. The first draft framed replay/reference behavior around “lines,” but in this codebase ADR-024 already uses **lane** as the implemented concept. Keeping both “line” and “lane” would create needless ontology drift.

## Decision Drivers

1. **Do not add a separate line concept.** Use the existing family/lane/run model from ADR-024.
2. **Add experiment as the missing concept.** An experiment is a judgment/comparison over packaged run or reference outputs.
3. **Compare result packages, not bare runs.** Diffs, visuals, evidence, review signals, baseline/head identity, and missing-data state are first-class experiment inputs.
4. **Keep task behavior separate from experiment/replay provenance.** `dev` and `fix-bug` remain execution/task profiles; replay/reference tells how a package was derived.
5. **Keep evaluation separate from publication.** Bugfix publication gates can produce package data, but publication safety policy is not automatically eval methodology.
6. **Preserve v1 safety.** Artifact-only evals must not mutate or link merge-intended GitHub PRs.
7. **Ship incrementally.** The current PR may land a narrow foundation if it is honest about the larger package/eval model.

## Decision

### 1. Family remains the objective scope

A **run family** remains the top-level grouping for one task, ticket, PR lineage, or reference problem space.

The family answers: “what objective are these trials related to?”

Examples:

- the original `fix-bug` run and its follow-up `pr-complete` / `merge-main` runs,
- multiple comparison-lane trials for the same ticket,
- a reference PR and one or more recreated candidate trials,
- future corpus items for recurring prompt/template/harness regression checks.

### 2. Lane remains execution intent, not an eval or line substitute

ADR-024’s lane field keeps its existing meaning:

- `production` — canonical publish-oriented work,
- `validation` — safe validation/replay/certification work,
- `comparison` — intentionally duplicated sibling trials.

A lane is not an eval. A lane is not a second object called a line. It is just execution policy/intent on a run.

### 3. A run is one execution record

A **run** remains the operational execution record:

- flow type / task profile (`dev`, `fix-bug`, `review-pr`, `pr-complete`, `merge-main`),
- lane,
- runner/model/template metadata,
- task file and artifacts,
- slot/branch/commit state,
- completion policy and decisions.

Runs are necessary for execution and observability, but an eval should not depend on reading live run state forever. The output of a run should be captured into a package.

### 4. Add a result package concept

A **result package** is an immutable or versioned bundle of the data needed to judge one trial or reference output.

This is broader than the shipped `ReadyGatePrPackage`. A ready-gate PR package is a publication package; an eval result package is an assessment input package. An experiment package may reference a ready-gate package, but it must also support artifact-only validation outputs that never publish a PR.

A result package should carry, or reference by stable artifact path/hash:

- package identity: `packageId`, version, creation time, producer,
- family identity: `familyId`, project, root ticket/PR/objective,
- source identity: source run ID, source PR, source branch/ref, or source commit,
- task profile: `dev`, `fix-bug`, or another future profile,
- execution lane and completion policy,
- baseline identity: base ref/SHA, head ref/SHA, merge commit when relevant,
- diff data: diff artifact, diff stat, changed files, contribution vs review-input provenance,
- visual evidence: before/after screenshots, videos, visual diffs, missing markers,
- validation evidence: tests, recipe results, logs, traces, acceptance-criteria mapping,
- review evidence: self-review, independent review, bugbot/human review signals, review-depth metadata,
- outcome claims: what bug was fixed or what feature was implemented,
- missing-data list with explicit reasons.

The package is the unit that can be compared, archived, re-scored, and fed into future corpus/regression workflows.

### 5. Add experiment as comparison/judgment over packages

An **experiment** is a first-class record that compares or scores one or more result packages.

An experiment should carry:

- `experimentId`, version, creation time,
- `familyId` / objective scope,
- one `EvalCase`,
- candidate strategies,
- experiment trials,
- objective kind: bugfix, feature/dev, review-quality, harness-regression, etc.,
- rubric and verdict,
- diff-to-diff comparison,
- visual comparison pairs,
- evidence coverage comparison,
- review-signal comparison,
- missing-data state,
- optional human annotations.

Product paradigm:

- **dataset** = catalog of reusable eval cases,
- **dataset item** = one source/objective/reference target that can seed a case,
- **case** = the known PR, prior run, package, or git ref that defines the problem,
- **candidate strategy** = one planned configuration of template, prompt, harness, base recipe, runner, and model,
- **trial** = one artifact-only execution of a candidate strategy for the case,
- **result package** = immutable output/evidence bundle from a reference or trial,
- **experiment** = judgment/comparison over reference and candidate packages,
- **suite draft** = non-executing plan over many dataset items and candidate strategies,
- **scorer config ref** = future scoring intent, not a score result,
- **suite** = future executed batch of many experiments over many cases.

Runtime mapping:

- A case and its trials live inside a run **family**.
- A trial is implemented as a gateway **run**.
- A candidate strategy is mapped to a comparison-run `variant` only at dispatch/runtime boundaries.
- The eval product should lead with cases, strategies, trials, packages, and rubrics; `flowType`, `mode`, `lane`, and `completionPolicy` are runtime controls.

Non-overlap with ADR-024 runtime terminology:

| Term               | Eval product meaning                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `flowType`         | Execution carrier only. A candidate can run through `dev` without meaning the eval is a dev-only product.  |
| `taskProfile`      | Rubric semantics: bugfix evals ask “was the bug fixed?” while dev evals ask “was the feature implemented?” |
| `lane`             | Run policy. Eval trials use `comparison` because old/new templates or models are sibling trials.           |
| `variant`          | Candidate sibling label, not a mode. Examples: `current-template`, `proposed-template`, `codex-gpt-5-5`.   |
| `mode`             | Autonomy/validation behavior preset. It is not used to distinguish eval trials.                            |
| `completionPolicy` | Side-effect policy. Eval trials use `artifact-only` to prevent PR mutation.                                |

### 6. Reference experiment is the v1 experiment type

A **reference experiment** is the first concrete experiment type.

It compares a reference package derived from a known-good merged PR against a candidate package produced by a replay/recreation trial.

The reference package comes from the merged PR:

- PR metadata,
- base/head/merge commits,
- reference diff,
- reference visual/evidence artifacts when available,
- linked ticket/issue context.

The candidate package comes from a new artifact-only run:

- task profile and carrier flow,
- baseline ref/SHA actually used,
- candidate diff,
- candidate visual/evidence artifacts,
- review/validation signals,
- missing-data reasons.

The experiment then compares the two packages, not just the two run records.

### 7. Bugfix and dev have different success semantics

Eval methodology must respect task profile.

For `fix-bug` packages, the core question is:

> Does this package prove that the original bug or failure mode is fixed, with sufficient before/after or reproduction evidence, and without unacceptable regression risk?

Useful evidence includes:

- reproduction or bug-scope artifact,
- before/after UI or state evidence,
- targeted tests or recipe runs,
- changed-code diff,
- self-review/independent-review findings,
- CI or smoke result.

For `dev` packages, the core question is:

> Does this package prove that the requested feature or acceptance criteria are implemented, with sufficient evidence for the changed surfaces?

Useful evidence includes:

- acceptance-criteria mapping,
- feature screenshots/videos/logs,
- tests or recipe validation,
- diff and changed-file analysis,
- review findings.

This means experiment policy is not one-size-fits-all. The package schema can be shared, but rubrics and required evidence vary by task profile.

### 8. Replay is provenance for producing a package

Replay/reference behavior should be modeled as provenance on a result package, not as a separate top-level flow.

Replay provenance answers:

- what source PR/run/commit/branch was used,
- what base SHA was checked out,
- what task prompt/template/harness generated the candidate,
- what runner/model executed it,
- whether the output was artifact-only or publishable.

This leaves `dev` and `fix-bug` as task profiles while allowing “candidate package recreated from PR 123 at commit X” to be compared against the reference package from that PR.

### 9. The foundation is the eval experiment package model

The product contract is now the experiment/package model, not the earlier pairwise eval manifest. Because the product has not shipped to external users, keeping a legacy bridge would create needless dual-source-of-truth debt.

The foundation establishes:

- `ResultPackageManifest` as the durable, hashable evidence bundle for reference/control/candidate outputs,
- `EvalExperimentManifest` as the experiment envelope over one case, candidate strategies, trials, rubric, and package comparison state,
- explicit `EvalCase`, `CandidateStrategy`, and `ExperimentTrial` records instead of generic package entries,
- `EvalDatasetManifest` / `EvalDatasetItem` as the reusable catalog of case seeds,
- `EvalSuiteDraftManifest` as a planning envelope over dataset items and candidate strategy refs,
- `EvalScorerConfigRef` as a future scoring configuration pointer, not a score value,
- package IDs/hashes, `experimentKey`, and idempotent candidate strategy fingerprints,
- `completionPolicy: 'artifact-only'`,
- `eval.experiment.create` and `eval.trial.start`,
- no-PR mutation guards,
- family-observability projection from experiment manifests and result packages.

It does **not** complete the full product. Remaining work includes:

- replay closure with stronger baseline/head identity and richer package metrics,
- gateway-owned suite execution from suite drafts with persisted progress/history,
- scorer execution, score values, and aggregate reports,
- corpus/history dashboards,
- promotion recommendations for template changes,
- external eval exports.

### 10. The `dev` carrier is an implementation detail; experiment trials use comparison lane

Experiment trials currently reuse `flowType: 'dev'` as the runner/template carrier so no new `FlowType` is required. Product semantics live in the experiment manifest and result packages:

- `taskProfile: 'fix-bug' | 'dev'` records what success means,
- `lane: 'comparison'` and a unique `variant` distinguish parallel trials,
- `completionPolicy: 'artifact-only'` prevents PR linking/mutation,
- `mode:'validation'` is not used for comparison-lane candidates under the current run classification invariant.

This does not mean eval “is dev.” It means the runner executes through the existing dev carrier while the experiment/package record stores the real semantics.

Concrete example for a bugfix-template regression:

- Reference source: merged PR `owner/repo#123` that fixed the bug.
- Experiment record: one `EvalExperimentManifest` for the case and rubric.
- Candidate A: `flowType:'dev'`, `taskProfile:'fix-bug'`, `lane:'comparison'`, `variant:'current-template'`, `completionPolicy:'artifact-only'`.
- Candidate B: `flowType:'dev'`, `taskProfile:'fix-bug'`, `lane:'comparison'`, `variant:'proposed-template'`, `completionPolicy:'artifact-only'`.
- Comparison output: result-package rows for diff, visual evidence, validation, review signals, timing, and cost.

### 11. Publication review policy remains separate from evaluation policy

`fix-bug` publication review-depth, ready gates, and public PR mutation rules remain publication safety policy.

Eval packages may include that review evidence, and future bugfix-style evals may choose a rubric that requires independent review evidence. But the current PR should not silently turn publication gates into global eval requirements.

### 12. Baseline identity is required for replay closure

Reference/candidate packages must ultimately persist baseline identity clearly enough to support reliable comparison:

- reference package: original PR base/head SHA and merge commit SHA when available,
- candidate package: actual replay base ref/SHA and resulting head/diff identity,
- harness identity: prompt/template/model/runner/config hashes.

The current PR may only partially capture this. Replay closure is a required follow-up before eval experiments become a durable template-regression program.

### 13. Local suite launch is an ephemeral operator cockpit, not a new durable suite runtime

The near-term suite builder may help an operator search/filter/preview hydrated PRs and runs, add manual package or git-ref cases, collect a UI-local basket, and launch the selected cases against a candidate-strategy matrix. That cockpit is allowed to fan out only through the existing single-case APIs:

1. `eval.experiment.create` once per selected case, carrying stable `datasetId` and `datasetItemId` hooks.
2. `eval.trial.start` once per enabled candidate strategy for that experiment.

`datasetId` is grouping metadata for the local basket/suite draft; it is not part of the single-case experiment identity. PR #78 intentionally re-keys any pre-release/local on-disk experiments that included `datasetId` in `experimentKey`; recreate those experiments rather than trying to reconcile duplicate/forked experiment roots.

The durable records remain the single-case `EvalExperimentManifest`, `ResultPackageManifest`, runs, and family-observability projections. The local launch summary may show operational status, timing/cost estimates, evidence counts, package paths, missing data, and row errors, but it must not become a quality-judgment, report-generation, export, or recommendation surface.

A future gateway-owned suite runner can add restart safety, persisted progress/history, suite-draft execution, scorer execution, and aggregate reports after the UX and fan-out semantics are proven.

## Alternatives Considered

### A. Add a separate line concept alongside lane

**Rejected.**

This duplicates ADR-024 terminology and confuses the implemented model. If the product later wants to rename `lane` to `line`, that should be a deliberate rename, not a new parallel concept.

### B. Add a top-level `replay` or `reference-eval` flow now

**Rejected for now.**

A new flow would mix task behavior, replay provenance, and eval methodology into one axis. It also increases blast radius across protocol, gateway, UI, worker templates, and tests before the experiment/package model is clear.

### C. Compare runs directly without packages

**Rejected.**

Runs are operational records. Experiments need stable, portable, hashable evidence bundles containing diff, visual evidence, validation output, review signals, missing-data state, and baseline identity. Direct run comparison keeps evals too coupled to mutable gateway state.

### D. Reuse `ReadyGatePrPackage` as the only package type

**Rejected.**

The ready-gate package is publish-oriented. Reference experiments and validation runs must support artifact-only outputs with no public PR mutation. The experiment package concept should be broader and may reference ready-gate packages when they exist.

### E. Reuse bugfix publication review depth for all evals immediately

**Rejected for this PR.**

This conflates publication safety with evaluation methodology. Bugfix-style evals can require stronger evidence later, but the foundation slice should record review signals without globally imposing publication gates.

## Consequences

### Positive

- Clarifies that experiments compare evidence packages, not abstract “lines.”
- Preserves ADR-024’s family/lane/run model without duplicating terminology.
- Gives bugfix and dev evals correct task-specific success semantics.
- Allows artifact-only validation packages and publishable PR packages to be compared through one model.
- Gives future corpus/regression workflows a stable experiment/package boundary.

### Negative

- The `dev` carrier remains semantically awkward until the product fully hides carrier details from operators.
- Artifact-only evals still need richer closure before they can be used as a strict quality gate across every template change.

## Follow-Ups

1. Finish the single-experiment cockpit: reference selector, candidate matrix, package comparison table, and family observability `experiments[]` detail.
2. Capture candidate baseline SHA, head SHA, prompt/template/harness hashes, and task-profile metadata for every eval trial package.
3. Add visual and diff comparison UX directly from package evidence.
4. Add operator workflow for selecting a merged PR or prior run, generating several candidate packages, and comparing packages inside a family.
5. Add task-profile-specific rubrics: bugfix proves the issue is fixed; dev proves the feature/ACs are implemented.
6. Add corpus/history views only after package identity and replay closure are reliable.
7. Revisit generalized eval-review policy separately from bugfix publication gates.
8. Make the artifact-only/comparison replay delta portable across slots. Those work branches are kept local-only by `services/gateway/src/projects/start-ref-policy.ts` (`assertStartRefWorkBranchIsLocalOnly`), and only the ≤50MB evidence diff artifact reaches the gateway, so such a run cannot be hydrated onto another slot. Persist a complete, re-appliable contribution patch as a package payload (tracked + untracked + binary), or push to a gateway-owned ref namespace (`refs/farmslot/runs/<runId>`), recorded on `ResultPackageManifest`, so any slot can fetch-and-apply. Enables the ADR-024 activate-on-slot swap for comparison runs without polluting PR remotes.
9. Cross-gateway reference seeding for worktree sandboxes — see [ADR-039](039-run-portable-bundles.md) (`farmrun` bundle export/import). Complements package-based eval references; does not replace slot-level replay delta in item 8.
