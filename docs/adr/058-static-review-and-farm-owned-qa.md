# ADR-058: Static review and farm-owned QA

**Status:** Proposed; implementation not authorized by this draft
**Date:** 2026-09-15
**Owner:** Farmslot maintainers
**Scope:** [Review intake](../PRD-automation-intelligence-canonical.md#7-declarative-trigger-rules-and-review-intake-planned) and [near-term roadmap](../ROADMAP-next.md), item 20
**Related:** [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-037](037-prepare-profiles.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-054](054-run-resource-posture.md), [ADR-055](055-persistent-pr-monitoring-and-review-intake.md), [ADR-057](057-structured-runner-transports.md)
**Lifecycle:** Retain as a decision record. This draft proposes changes to ADR-055's slot-bound review execution and combined review/live-QA contract; it does not change current behavior or acceptance status.

## Context

PR review currently combines review tiers with `static-code` and `full-live` validation depth. Static review skips app preparation, but review intake still selects allowed slot/model combinations. Device-slot availability therefore constrains work that only needs source files and a reviewer.

Runtime QA answers a different question: whether the selected behavior works in the app. Its coverage depends on the farm. A project's release-validation workflow should not become a framework-wide mode.

A new ADR is needed because separating these workflows changes execution ownership, resource allocation, intake identity and completion semantics. Renaming dispatch controls would leave those contracts inconsistent.

## Proposed decision

### Review and QA are distinct workflows

| Workflow | Required work                                                         | Result                                                   |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Review   | Inspect frozen source changes, domain guidance and available evidence | Static findings, reviewed SHA and unchecked areas        |
| QA       | Execute a farm-owned validation profile against a recorded target     | Runtime coverage, evidence and pass/fail/blocked results |

Review defaults to cheap read-only inspection. It does not install application dependencies, build, run test suites or acquire an app runtime. Additional static review passes may change reviewer coverage without changing this resource contract.

Successful app QA requires at least a passing in-app smoke check defined by the farm. Starting the app or passing a health probe alone is insufficient. Missing runtime evidence produces incomplete or blocked QA; it cannot silently become a successful static review. Static findings and runtime verdicts remain separate even when displayed together.

### Static review executes without a farm slot

Use an isolated checkout pinned to the reviewed SHA and a gateway-owned execution record. Allocate host and runner capacity through the existing admission system, without reserving a device slot or creating placeholder slots. Preserve queue receipts, cancellation, restart reconciliation, logs, artifacts and run-family relationships.

The execution node owns checkout creation and cleanup. Persist artifacts outside disposable checkouts before cleanup. A detached worktree does not enforce read-only access: use supported runner permissions and keep report output separate from source. Do not describe same-user approval bypass as filesystem isolation.

Record the exact base/head, selected profile, workflow content and domain-library revisions. Bootstrap required review tooling and skill inputs independently of app preparation. Reuse ADR-049 snapshots and ADR-057 runner adapters rather than adding workflow-specific runner commands.

Keep existing per-PR execution ownership during migration. Removing device-slot dependence does not authorize competing repair and review work on the same PR. Host limits still apply when many PRs are submitted together.

### Farms own QA profiles

Each farm declares its profiles and default through project configuration. Farmslot owns generic discovery, validation, selection, scheduling and result tracking. Farm skills/templates own workflow instructions and domain semantics.

A profile describes:

- Stable identity, title and description.
- Selected execution template or skill-backed catalog entry.
- Required inputs, runtime capabilities and evidence requirements.
- Applicable runner/model defaults and optional automatic-QA policy.

Keep QA profiles distinct from prepare profiles, which describe environment setup, and execution preferences, which constrain runner/model placement. Reuse those existing contracts rather than copying their definitions into a new workflow language.

The framework has no built-in release-validation profile. A farm may offer that profile with a build/ref input, suite and device coverage; another farm may offer entirely different checks. PR URLs are not mandatory for all QA. Profile configuration references canonical workflow content instead of duplicating checklists.

### Review can hand off to QA

Completed review offers **Run QA** with the farm's eligible profiles and default. This is an explicit action unless a saved profile opts into automatic QA. A reviewer reporting runtime uncertainty does not itself authorize resource allocation.

QA is a linked execution with its own outcome. Carry over the reviewed target and findings. If the operator selects a newer target, record the change and treat earlier evidence as historical. QA may reuse matching static evidence but never inherit runtime proof from a static verdict.

Review and QA intents must remain distinct for deduplication. Freeze the effective profile revision at admission; revalidate pending work after configuration changes without rerunning completed work automatically. Execution and publication authority remain separate.

Retain reviewer history independently of disposable workspaces. Continue only when the shared runner adapter confirms a compatible persisted session; otherwise record a fresh fallback. Slot-independent session compatibility needs an explicit contract before implementation.

## Migration and unresolved details

Before acceptance, specify:

1. The resource binding for executions without slots, including remote ownership, cleanup and restart recovery. Keep ADR-054's runtime lease work separate from this capability.
2. The profile schema and precedence among farm defaults, team/rule policies and explicit requests. Existing slot constraints must not silently become unrestricted host access.
3. The flow identifiers and migration of `review-pr`, `full-live`, review tiers, recipe strategies, intake receipts and client defaults. Ambiguous pending work requires a visible resolution; historical results retain their original meaning.
4. How publication review gates consume separate static and QA outcomes without weakening existing requirements. Internal review passes are not automatically migrated by this draft.
5. The first farm profiles and their proof requirements, plus a measured startup/concurrency target for static review.

Then update the canonical PRD and create scoped implementation specifications. Deliver slot-independent review and farm-profile QA as separate verifiable slices after ADR acceptance.

## Alternatives

- Keep live QA as a review-depth option: preserves the ambiguity between static approval and runtime proof.
- Add more device-backed review slots: spends scarce resources without changing the execution requirement.
- Launch untracked review processes: loses durable intake, resource accounting and review history.
- Hardcode smoke/PR/release profiles in Farmslot: embeds project workflow semantics in the framework.

## Required validation

- Submit several static reviews while all device slots are busy. They execute within host limits without changing device assignments.
- Cancel and restart during checkout creation, execution and completion. Reconcile ownership without duplicate runs or orphaned checkouts; retain reports after cleanup.
- Install a newly revised review skill into a temporary workspace without app preparation. Verify the run records the content and library revisions it used.
- Configure two farms with different QA profiles. All clients show the selected farm's profiles and default without framework changes.
- An unavailable runtime or failed smoke check cannot produce passing QA. Evidence identifies the executed target, profile and required coverage.
- Manual QA handoff and opt-in automatic QA create linked, distinct work exactly once. Static completion cannot satisfy a pending QA request.
- A changed PR head, profile edit or unavailable reviewer session cannot inherit an old verdict or bypass recorded execution constraints.

Prove these through gateway endpoints and real runner execution, plus Command Center and Companion flows. Documentation checks alone do not establish implementation readiness.
