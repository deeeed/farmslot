# ADR-058: Static review and farm-owned QA

**Status:** Accepted for implementation; validation pending
**Date:** 2026-09-15
**Owner:** Farmslot maintainers
**Scope:** [Review intake](../PRD-automation-intelligence-canonical.md#7-declarative-trigger-rules-and-review-intake-planned) and [near-term roadmap](../ROADMAP-next.md), item 20
**Related:** [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-037](037-prepare-profiles.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-054](054-run-resource-posture.md), [ADR-055](055-persistent-pr-monitoring-and-review-intake.md), [ADR-057](057-structured-runner-transports.md)
**Lifecycle:** Retain as a decision record. This decision changes ADR-055's slot-bound review execution and combined review/live-QA contract. Existing behavior remains until the explicit migration lands.

## Delivery stages

The first PR delivers slot-free static review. Existing slot-based `review-pr` requests with `full-live` depth retain their current execution path. QA workflow/profile migration, shared task-template changes and QA controls ship in the follow-up PR. The QA mappings below describe that second stage; they are not enabled by the static-review PR.

Client and intake cutover (2026-09-23): new independent review rounds (dispatch plans, backlog plans, ready-gate requests) are static. Intake refuses a new `full-live` loop with `REVIEW_QA_NEEDS_CONFIGURATION`; a queued legacy loop waits for operator repair, and started or completed reviews keep their recorded depth. Review continuation no longer offers a live escalation. Runtime validation runs as QA with a farm preset.

Review publication and feedback-loop work remain explicit follow-ups in the aggregate plan. The first static capability retains local results.

## Context

PR review currently combines review tiers with `static-code` and `full-live` validation depth. Static review skips app preparation, but review intake still selects allowed slot/model combinations. Device-slot availability therefore constrains work that only needs source files and a reviewer.

Runtime QA answers a different question: whether the selected behavior works in the app. Its coverage depends on the farm. A project's release-validation workflow should not become a framework-wide mode.

A new ADR is needed because separating these workflows changes execution ownership, resource allocation, intake identity and completion semantics. Renaming dispatch controls would leave those contracts inconsistent.

## Decision

### Review and QA are distinct workflows

| Workflow | Required work                                                         | Result                                                   |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Review   | Inspect frozen source changes, domain guidance and available evidence | Static findings, reviewed SHA and unchecked areas        |
| QA       | Execute a farm-owned validation profile against a recorded target     | Runtime coverage, evidence and pass/fail/blocked results |

Review defaults to cheap read-only inspection. It does not install application dependencies, build, run test suites or acquire an app runtime. Additional static review passes may change reviewer coverage without changing this resource contract.

Successful app QA requires at least a passing in-app smoke check defined by the canonical project workflow. For headless projects, use real command/controller runtime assertions rather than requiring a UI. Starting the app or passing a health probe alone is insufficient. Missing runtime evidence produces incomplete or blocked QA; it cannot silently become a successful static review. Static findings and runtime verdicts remain separate even when displayed together.

### Static review executes without a farm slot

Use an isolated checkout pinned to the reviewed SHA and a gateway-owned execution record. Allocate host and runner capacity through the existing admission system, without reserving a device slot or creating placeholder slots. Preserve queue receipts, cancellation, restart reconciliation, logs, artifacts and run-family relationships.

The execution node owns checkout creation and cleanup. A retained reviewer session is associated with one PR and team review configuration; new commits supply the delta and unresolved findings. Static review also checks whether the changed code still matches the supplied recipe and evidence, without claiming this proves runtime behavior. Persist artifacts outside disposable checkouts before cleanup. A detached worktree does not enforce read-only access: use supported runner permissions and keep report output separate from source. Do not describe same-user approval bypass as filesystem isolation.

Record the exact base/head, selected profile, workflow content and domain-library revisions. Bootstrap required review tooling and skill inputs independently of app preparation. Reuse ADR-049 snapshots and ADR-057 runner adapters rather than adding workflow-specific runner commands.

Keep existing per-PR execution ownership during migration. Removing device-slot dependence does not authorize competing repair and review work on the same PR. Host limits still apply when many PRs are submitted together.

### Farms own QA profiles

Each farm declares its profiles and default through project configuration. Farmslot owns generic discovery, validation, selection, scheduling and result tracking. Farm skills/templates own workflow instructions and domain semantics.

A QA profile is a thin preset: a stable id and label, a canonical skill or catalog template reference, and ordinary inputs/defaults passed to it. It is not a workflow language, a recipe registry or another copy of a team's checklist. Existing execution policy and capability contracts still constrain placement; profile selection cannot grant new authority.

For example, a farm can offer presets for a PR, a release, or changes from the previous 24 hours. Each invokes the same reusable validation workflow with a different change-scope input. The skill and harness resolve that scope to exact commits, select or compose recipes from the team library, execute the resulting dynamic recipe set, and report coverage and limitations. Freeze time-window boundaries and resolved refs before execution so retries validate the same changes. Missing recipe coverage is explicit, never a successful empty validation.

Skills and harness commands must also work directly for engineers without Farmslot. Farm execution consumes the same materialized team process, apart from run-specific metadata. Team knowledge and recipe libraries have one canonical home. Farm fixtures retain infrastructure context and point to that process; they do not restate it.

Keep QA presets distinct from prepare profiles and runner/model placement policy. Required runtime actions and evidence follow the canonical skill and existing proof contract, not a second profile-specific gate language. The framework records the resolved scope, selected recipe digests and evidence; project skills own change discovery and recipe selection.

The framework has no built-in release-validation or daily-validation workflow. A time-window preset does not introduce a scheduler. Automatic merge and author-branch repair remain separate policies outside this change.

### Review can hand off to QA

Completed review offers **Run QA** with the farm's eligible profiles and default. This is an explicit action unless a saved profile opts into automatic QA. A reviewer reporting runtime uncertainty does not itself authorize resource allocation.

QA is a linked execution with its own outcome. Carry over the reviewed target and findings. If the operator selects a newer target, record the change and treat earlier evidence as historical. QA may reuse matching static evidence but never inherit runtime proof from a static verdict.

Review and QA intents must remain distinct for deduplication. Freeze the effective profile revision at admission; revalidate pending work after configuration changes without rerunning completed work automatically. Execution and publication authority remain separate.

Retain reviewer history independently of disposable workspaces. Continue only when the shared runner adapter confirms a compatible persisted session; otherwise record a fresh fallback. Slot-independent session compatibility needs an explicit contract before implementation.

### Farm defaults and PR publication

Farm/project configuration supplies review eligibility, reviewer/template and execution defaults, QA presets and review publication policy. Repository/team rules refine those defaults; explicit requests may override permitted choices. Constraints remain binding. Manual requests and PR automation resolve the same policy and show its source before dispatch.

PR intake routes eligible needs-review PRs into workspace reviews and deduplicates by reviewed commit and review purpose. Command Center and Companion expose Review and Run QA from the PR, with workspace progress, findings and publication state on the existing run detail.

A request can select **Publish review to PR**. Explicitly opted-in projects publish completed reviews by default; other projects keep results in Farmslot. Permitted request and automation-rule overrides refine that project default. Snapshot the effective publication choice with the request. Publish through the existing authorized provider path, with the reviewed commit, current-head validation and a durable publication receipt to prevent duplicate posts on retry. Publication failure does not erase the completed review. Static publication cannot claim runtime QA proof or grant merge authority.

## Implementation contract

### Execution identity

Keep `review-pr` as the static workflow identifier and introduce `qa` for runtime validation. A QA preset may select a catalog template whose own flow is `review-pr`; workflow identity describes orchestration, while the selected template reference describes the shared process being invoked. Resolve that explicit preset reference without relabelling or copying the source template.

Add a workspace execution binding to the existing run record, alongside its nullable slot binding. A workspace binding records execution node, authorized repository source, owned checkout and task/artifact locations. Slot and workspace bindings are mutually exclusive. Use the shared queue and runner adapters, with capability-based support checks; an unsupported transport produces a configuration error, never a silent runner switch.

An execution node creates disposable SHA-pinned checkouts under its managed workspace root from a project repository cache. Persist the admission/run identity before workspace creation and runner launch. Reconcile each phase by that identity after restart; cancel the owned execution before deleting its checkout. Retain reports and compatible native reviewer session references outside the checkout. Re-check owner, repository and node permissions before delayed starts. Remote nodes use the same ownership contract.

Workspace admission counts active reviewer executions against host/runner limits and host pressure independently of device slots. Explicit node/model/effort constraints remain binding. Existing slot constraints are not implicitly converted into unrestricted node selection.

Static reviews wait at the shared review/publish gate by default. The reviewer remains available for questions until the operator posts or dismisses the review. Requests and automation policies may explicitly choose `autoFinish`. Posting uses the selected recommendation and inline comments, with the existing exact-head and account checks. Saved reports reuse the same review workspace in read-only mode, including diff, code, comments and artifact previews. Reopening its publication gate never dispatches another worker.

### Preset shape and inputs

Use a small `qa` project configuration containing `default_profile` and `profiles`. Each preset has `id`, `title`, optional `description`, `template_id`, and optional JSON `inputs`. Canonical skill-backed catalog entries are the executable source; profile configuration cannot embed a checklist, shell program or recipe-selection algorithm.

The effective profile comes from an explicit request, then the applicable team/repository policy, then the farm default. A rule's allow-list still constrains explicit choices. Inputs combine the preset defaults with explicit task inputs, and the run snapshots the selected preset, effective inputs and template provenance. Invalid/missing references are configuration errors. Pending requests re-resolve current policy before admission; started runs retain their snapshot.

For PR QA, handoff supplies the PR and reviewed SHA. Release and time-window meanings remain project-owned skill inputs. The shared workflow resolves those inputs into immutable changes and a dynamic recipe plan before runtime execution. Record selected recipe digests, change-to-recipe coverage and gaps with the existing evidence contract. No matching recipes means uncovered or explicitly not applicable, not passing QA.

The canonical workflow supplies runtime proof obligations, including smoke. Completion verifies the existing typed recipe result/trace and required artifacts, rather than trusting a prose report or checklist tick. Profile configuration does not define another assertion or gate language.

### Legacy migration

Persist a versioned normalized workflow request and migration provenance at intake/run boundaries. Migration must be idempotent; retain receipt keys and source records. Do not rewrite completed verdicts or running executions to claim the new contract. Their UI labels explain the original static/live mode.

| Existing unstarted request                                                     | New behavior                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Explicit static depth with no conflicting runtime instructions                 | Static `review-pr`; require an authorized workspace execution target                                                       |
| Explicit `full-live`                                                           | `qa` using the farm's configured PR-QA preset; retain the original inputs and apply the new minimum runtime-proof contract |
| No depth, but a current stored/default contract unambiguously specifies static | Static `review-pr`                                                                                                         |
| Legacy tier/recipe strategy with ambiguous or conflicting intent               | Needs configuration with the original values visible                                                                       |
| Slot-pinned static work without explicit workspace authorization               | Needs configuration; offer a node/workspace choice without releasing or claiming a slot                                    |
| Missing QA preset or unsupported runner/workspace capability                   | Needs configuration; no substitute template or runner                                                                      |

Keep legacy fields only in the compatibility reader and historical records. New clients send distinct Review/QA requests; new worker prompts do not contain Review Tier, Static/Full live or recipe-strategy branches. Existing external clients receive either deterministic normalization or a typed migration error. Repeated admission cannot dispatch both the old and normalized intent. Review and QA use separate purpose keys, and linked automatic QA uses a durable parent-review/profile identity.

### Gates and source cutover

Internal publication review passes retain their existing contracts until explicitly migrated. Do not replace a required live gate with a static verdict. Standalone QA results remain distinct from review approval and never grant publication authority.

Before changing farm defaults, materialize the current worker and canonical skill templates for every platform/flow. Classify differences as team process, infrastructure or dead content. Move still-needed process into its shared home; keep infrastructure in task/context adapters. Compare dispatch previews and exact materialized content before and after cutover. Preserve current slots and selected template snapshots throughout.

Shared task production already separates the task document and verbatim checklist. This change consumes that contract; it does not introduce another task producer. Dependency/source revisions remain explicit so an open shared-skills change cannot be mistaken for a released prerequisite.

### Delivery and measurements

Deliver the profile/migration contract, workspace review execution, shared-template cutover, QA invocation and client migration as separate verifiable slices under this ADR. Measure queue wait, checkout/tooling setup, reviewer execution and total elapsed time separately. The initial capacity proof is three concurrent static reviews while all device slots are occupied, under configured host limits. Establish warm/cold timing from those runs; do not invent a latency promise before measurement.

The operator authorized implementation on 2026-09-15, including migration. Runtime validation and independent review remain required before the implementation is complete.

## Alternatives

- Keep live QA as a review-depth option: preserves the ambiguity between static approval and runtime proof.
- Add more device-backed review slots: spends scarce resources without changing the execution requirement.
- Launch untracked review processes: loses durable intake, resource accounting and review history.
- Hardcode smoke/PR/release profiles in Farmslot: embeds project workflow semantics in the framework.

## Required validation

- Submit several static reviews while all device slots are busy. They execute within host limits without changing device assignments.
- Cancel and restart during checkout creation, execution and completion. Reconcile ownership without duplicate runs or orphaned checkouts; retain reports after cleanup.
- Install a newly revised review skill into a temporary workspace without app preparation. Verify the run records the content and library revisions it used.
- Configure two farms with different QA presets. All clients show the selected farm's presets and default without framework changes. Direct skill execution and farm execution materialize the same workflow content.
- Resolve PR, release and time-window inputs through the project skill into frozen changes and a dynamic recipe set. Retries retain scope and recipe provenance; uncovered changes cannot become passing QA.
- An unavailable runtime or failed smoke check cannot produce passing QA. Evidence identifies the executed target, profile and required coverage.
- Manual QA handoff and opt-in automatic QA create linked, distinct work exactly once. Static completion cannot satisfy a pending QA request.
- A changed PR head, profile edit or unavailable reviewer session cannot inherit an old verdict or bypass recorded execution constraints.

Prove these through gateway endpoints and real runner execution, plus Command Center and Companion flows. Documentation checks alone do not establish implementation readiness.

## Amendment 1: Optional QA defaults and required choices (2026-10-15)

**Status:** Accepted by lead, 2026-10-15, after R2 paired review of #1092 at `a2d95439`. This amendment makes the farm default optional while preserving existing request and workflow-policy precedence.

### Decision

`qa.default_profile` is optional. When supplied, it must identify a configured profile. The existing `resolvePRWorkflowDefaults` owner resolves the request id before repository, team and farm workflow-policy ids, including `workflow_defaults.qa.review.qaProfileId`. Its effective id is then passed to QA selection; only when no effective id exists does selection use `qa.default_profile` or the only profile when exactly one exists. Several profiles without an effective id or configured default require a choice. Invalid explicit ids never fall through to another profile.

Missing selection returns the existing typed `REVIEW_QA_NEEDS_CONFIGURATION` refusal and lists the available ids and titles. Admission must refuse before creating a run, claiming a slot or starting work. Empty or invalid profile configuration remains an error.

Command Center and Companion resolve the same applicable workflow policy before preselection. They show its effective profile id, otherwise the configured default or sole profile. A user change overrides that resolved policy choice. Otherwise they preselect nothing and disable Dispatch until the user chooses. The visible selection is sent with the request. Manual dispatch, PR requests and automation use the same selection rules; a saved policy may supply an explicit profile id. Clients must not select the first array entry as a substitute.

The admitted run retains the resolved profile id, title, inputs and template snapshot. Run detail and existing QA report or PR evidence presentation show the id and title. Replays and migrations preserve an already-admitted selection; configuration edits cannot silently select a different profile. Unstarted legacy full-live requests and queued QA without a captured selection follow the same selection and typed-choice rules.

Remove existing `default_profile` values from first-party packs. Other projects may continue to configure a default. Publish and deploy the shared optional-default contract before cutting those packs over; the old pack validator requires a default. Retained task and evidence bytes are unchanged.

### Public surface

`ProjectQaConfig` and `selectQaProfile` remain owned by `@farmslot/protocol`; the existing `default_profile` field becomes optional. An additive `resolveQaProfileId` export provides the same pure id selection to `selectQaProfile`, Command Center and Companion; callers pass the effective request/policy id from `resolvePRWorkflowDefaults`, then it returns that id, the configured-default or sole id, or no id when a choice is required. It does not add another policy resolver. Existing gateway QA request fields and CLI `--qa-profile` are unchanged. The CLI permits omission when existing policy supplies an id or the farm resolves a configured default or sole profile; otherwise it prints the choices and a command using `--qa-profile`. Harnesses inherit the shared selection and admitted snapshot without a second parser, allocator or store.

### Rationale and validation

A default is valid project policy, while array order is not selection intent. The sole-profile case needs no prompt. First-party multi-profile packs require a deliberate choice by omitting their defaults.

Verify request-over-policy selection, workflow-policy-over-farm-default selection, configured default, sole profile, ambiguous multi-profile refusal and invalid ids through shared contract tests and public gateway/CLI controls. Verify UI preselection and disabled Dispatch through Command Center and Companion flows. Retained/restart controls must preserve the captured profile. Release and installed-node readback follow the accepted implementation.

## Amendment 2: Frozen head for ref and range QA (2026-10-17)

**Status:** Accepted (2026-10-17, lead-approved after delta review of #1244 at `e4b7cc4f`).

### Decision

When an admitted QA scope of kind `ref` or `range` names its commits exactly (`expectedHeadSha`/`expectedBaseSha`, or full SHAs in `ref`, `head` and `base`), the run records that frozen source identity, as PR QA already does from the reviewed PR. Prepare checks out the frozen head, detached when the run has no work branch, and refuses dispatch when the prepared HEAD differs. Completion validates retained evidence against the same identity. A branch or tag name and a time window keep resolving inside the skill.

### Rationale

This makes the existing "freeze resolved refs before execution" rule explicit for non-PR scopes. Without it, a ref QA run prepared on the default-branch tip, its worker had to ask whether to detach, and completion refused the run for a missing source identity.

### Public surface

No new field, command or export. The framework reads only the documented `ref` and `range` keys of the admitted scope; all other scope keys stay skill-owned.
