# ADR-044: Backlog Launch Plans and Comparison Candidate Sets

**Status:** Accepted
**Date:** 2026-06-30
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-030](030-replay-provenance-and-reference-evals.md), [ADR-038](038-gate-held-worker-session.md), [ADR-040](040-work-graph-orchestration.md), [ADR-043](043-scripted-runner-execution-policy.md), [ROADMAP-next](../ROADMAP-next.md)

## Context

Backlog and WorkGraph can schedule one dispatchable objective today. Dispatch comparison lanes can also run one extra same-family candidate from an existing run. What is missing is the operator workflow Arthur described:

- configure how many executions should launch for one backlog objective
- choose runner/model per execution
- choose exact slots or a slot pool per execution
- launch a baseline plus multiple comparison candidates without creating separate WorkGraph nodes
- keep unavailable candidates queued/blocked instead of showing a disabled dead end such as “Already dispatched: demo-work-1 disabled”

This is not an eval-suite replacement and not a new WorkGraph fan-out model. It is a launch-time expansion of one dispatchable backlog item into one baseline run plus zero or more ADR-024 comparison-lane siblings.

## Decision

Add a persisted **Backlog Launch Plan** to `BacklogItem`. A launch plan defines a finite set of launch candidates for one backlog objective.

### 1. A launch plan belongs to one backlog item

```ts
interface BacklogItem {
  launchPlan?: BacklogLaunchPlan;
}

interface BacklogLaunchPlan {
  /** Stable launch-plan identity used for queue/run linkage and idempotency. */
  id: string;
  version: 1;
  candidates: BacklogLaunchCandidate[];
}

interface BacklogLaunchCandidate {
  id: string;
  role: 'baseline' | 'comparison';
  label?: string;
  runner?: string;
  model?: string;
  effort?: string;
  /** Required for comparison candidates; generated from runner/model when omitted in UI drafts. */
  variant?: string;
  slotPolicy: LaunchSlotPolicy;
}

type LaunchSlotPolicy =
  | { kind: 'exact'; slotId: string }
  | { kind: 'pool'; allowedSlots: string[] }
  | { kind: 'spread'; allowedSlots?: string[] };
```

Rules:

- exactly one candidate must have `role: 'baseline'`
- the baseline is the family root attempt; it must not set `variant` or `lane: 'comparison'`
- comparison candidates require unique `variant` values within the launch plan
- all candidates use the same backlog objective/spec/task body
- per-candidate differences in v1 are limited to runner/model/effort/variant/slot policy; `effort` is a runner/model option, not a new execution axis
- per-candidate task templates, prompts, start refs, or separate acceptance criteria are out of scope

Identifier invariants:

- `workNodeId`, `backlogItemId`, `launchPlanId`, `launchGroupId`, `launchCandidateId`, `familyId`, and `parentRunId` are distinct namespaces
- `parentRunId` remains ADR-024 vertical lineage only; it is never a WorkGraph edge or launch-group id
- one WorkNode points to one BacklogItem; one BacklogItem with a launch plan owns one launch group

### 2. Baseline creates the family; comparisons materialize after baseline run creation

`backlog.enqueue(itemId)` changes from “enqueue one queue item” to “enqueue the item’s launch plan”.

If `launchPlan` is absent, existing single-run behavior remains unchanged.

If `launchPlan` is present:

1. enqueue only the baseline candidate first
2. when the baseline queue item creates a run, record:
   - `familyId = baselineRun.familyId || baselineRun.id`
   - `parentRunId = baselineRun.id`
3. materialize each comparison candidate into the dispatch queue with:
   - `lane: 'comparison'`
   - `familyId`
   - `parentRunId`
   - `familyRootTicketOrPr: backlogItem.ticketOrPr`
   - candidate `variant`
   - candidate runner/model/effort
   - candidate slot policy translated to queue constraints

This preserves ADR-024: comparison siblings are run-family members, not graph edges.

Baseline materialization rule:

- comparisons materialize when the baseline run is created, not when the baseline succeeds
- if the baseline queue item cannot create a run, comparisons stay `planned` and the launch plan needs attention
- if the baseline run later fails, already-materialized comparisons are not automatically cancelled; the launch plan rolls up as failed / needs attention unless the operator retries or replaces the plan

### 3. Slot policy is candidate-level

Slot policy maps to dispatch queue constraints:

| Policy   | Queue behavior                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact`  | set `slotId` and `allowedSlots: [slotId]`; wait if unavailable                                                                                                                        |
| `pool`   | set `allowedSlots`; any listed slot may run it                                                                                                                                        |
| `spread` | use `allowedSlots` when supplied, otherwise all eligible project slots; avoid co-locating active launch-group siblings when another eligible slot exists; queue when no distinct slot |

`spread` requires the queue to understand a launch group. Additive queue/run linkage:

```ts
interface QueueItem {
  backlogItemId?: string;
  launchPlanId?: string;
  launchCandidateId?: string;
  launchGroupId?: string;
}

interface Run {
  backlogItemId?: string;
  launchPlanId?: string;
  launchCandidateId?: string;
  launchGroupId?: string;
}
```

`spread` is intentionally not global optimization. It only means: during queue dispatch, do not intentionally place a candidate on a slot already occupied by an active sibling in the same `launchGroupId` when another eligible slot is available. The baseline counts as an active sibling once it has a slot. If candidates outnumber eligible slots, remaining candidates stay queued/blocked until an eligible slot frees or the operator changes the plan.

The dispatch queue remains the only slot allocator. The launch planner may attach queue constraints/preferences, but it must not reserve slots, call `run.create` directly, or bypass queue throttling.

### 4. Materialization is idempotent

Baseline and comparison materialization must survive gateway restart and event replay without duplicating queue items.

The store must enforce one materialization record per `(backlogItemId, launchPlanId, launchCandidateId)`. On replay of a baseline `RUN_CREATED` event, the gateway reconciles existing queue/run records by that key and must not enqueue a second copy of the same candidate.

Existing single-run backlog fields such as “queued queue item” or “latest run” become summary/legacy fields for launch-plan items. Backlog and WorkGraph status must derive from the candidate projection/ledger, not from one latest run id.

### 5. Backlog status becomes a roll-up over launch candidates

The backlog item stays one item. Candidate state is a projection from queue/run state plus a small materialization ledger.

```ts
type LaunchCandidateStatus =
  | 'planned'
  | 'queued'
  | 'running'
  | 'gated'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

interface BacklogLaunchCandidateProjection {
  candidateId: string;
  status: LaunchCandidateStatus;
  queueItemId?: string;
  runId?: string;
  slotId?: string;
  waitingReason?: string;
}
```

Roll-up rules for v1:

- baseline run-creation failure prevents comparison materialization and marks the launch plan needs attention
- baseline terminal failure does not cancel already-materialized comparisons, but the backlog item cannot be `done`; it remains failed / needs attention until the baseline is retried or replaced
- explicit operator cancellation marks the launch plan/backlog item `cancelled` or failed, not `done`
- comparison candidates are required by default; the backlog item is not complete until every planned candidate reaches terminal success
- a candidate waiting on slot availability is `blocked` or `queued`, not disabled
- a candidate at a publication/visual/dangerous human gate follows ADR-038/ADR-040 run-step gate semantics and projects as `gated`
- ADR-038 gate-held candidates continue to occupy their slots; v1 does not hot-switch or auto-release those slots for another candidate

Optional/nonblocking comparison candidates are deferred until real usage proves the need.

### 6. WorkGraph observes one objective

ADR-040 remains unchanged:

- a WorkNode still points to one backlog item
- the graph does not create one node per comparison candidate
- `parentRunId` is never used as a WorkGraph edge
- graph node status rolls up the backlog launch plan

A graph node with a launch plan remains active while any required launch candidate is queued/running/gated/blocked, and reaches `succeeded` only when the backlog launch plan succeeds. Resource-blocked launch candidates should surface as a resource waiting reason in the node projection, not as a new graph edge.

ADR-040 should be read as: WorkNode → one BacklogItem remains true, but BacklogItem → one Run becomes BacklogItem → one launch group / family roll-up when `launchPlan` exists.

### 7. UI surfaces

Command Center backlog surfaces should expose launch-plan authoring; graph surfaces may display or deep-link to the linked backlog plan without creating graph-native candidate nodes:

- add/remove comparison candidates
- choose runner/model/effort per candidate
- edit unique variant labels
- choose slot policy: exact slot, pool, spread
- show candidate rows with planned/queued/running/gated/succeeded/failed/blocked status
- unavailable slots must explain the waiting reason and keep the candidate schedulable when policy allows queueing

The dispatch wizard may continue to support one-off comparison forks from prior runs, but the persisted backlog launch plan is the canonical scheduled-run workflow.

UI implementation constraints:

- reuse existing Command Center primitives where possible: backlog rows/actions, dispatch runner/model controls, slot selector / fleet picker affordances, queue status display, and shared status chips
- do not introduce a second bespoke slot picker or runner/model selector unless the existing component cannot express the launch-plan row use case
- build a dev-harness/mock-data surface before live gateway integration so the operator can inspect a 3-candidate plan without depending on a live fleet
- keep the graph UI read-only or deep-linking for v1 unless editing the linked backlog plan can reuse the same backlog launch-plan editor
- CDP validation must exercise the real UI flow, not direct state injection

## Explicit Non-Goals

V1 must not include:

- WorkGraph-native comparison fan-out
- ADR-030 eval suite replacement or scoring/reporting
- per-candidate task body, acceptance criteria, prompt, or task-template overrides
- automatic human-gate hot switching from a held slot
- operator waiver/nonblocking comparison semantics
- arbitrary shell execution or new runner identities
- a generic multi-step execution DAG
- cross-backlog dependency inference
- optimizing global fleet throughput beyond existing queue scoring and the new launch-group spread constraint

## Consequences

**Positive:**

- Operators can plan baseline plus multiple comparison runs before scheduling backlog work.
- Comparison siblings keep ADR-024 family identity and variant labels.
- Graph orchestration remains simple: one node, one objective, one backlog item.
- Busy or disabled candidate slots become queued/blocked states instead of dead-end UI.

**Negative:**

- Backlog item status is no longer a simple one-run projection when `launchPlan` exists.
- Queue dispatch must understand launch-group spread constraints.
- Failure/retry UI needs candidate-level clarity.

**Risks:**

- Scope creep into eval-suite semantics. Keep scoring/reporting out of this ADR.
- Scope creep into graph fan-out. Keep comparison expansion below WorkGraph.
- Slot spread can become over-specified. V1 should guarantee “do not intentionally co-locate active siblings when eligible distinct slots exist”, not solve global optimization.

## Implementation Scope

Full implementation should be delivered in slices but against this complete model:

1. protocol types and validators for `BacklogLaunchPlan`
2. backlog create/update/list persistence for launch plans
3. launch materialization ledger and projection
4. backlog enqueue baseline-first behavior
5. baseline-run-created hook that materializes comparison queue items
6. queue/run additive linkage for launch group and candidate ids
7. spread-aware queue slot selection within one launch group
8. Command Center launch-plan editor on backlog/graph item surfaces
9. CDP validation for exact, pool, and spread policies

## Validation Guidance

Minimum acceptance tests:

- no-launch-plan backlog enqueue preserves existing behavior
- launch plan rejects zero or multiple baselines
- duplicate comparison variants are rejected
- baseline queue item is created first
- baseline `RUN_CREATED` materializes all comparison candidates with `lane: 'comparison'`, shared `familyId`, correct `parentRunId`, and unique variants
- exact slot candidate waits on its exact slot
- pool candidate carries `allowedSlots`
- spread candidates avoid active sibling slots when another eligible slot exists
- graph-linked backlog item remains one WorkNode and rolls up candidate state
- UI can create/edit a 3-candidate plan and queue it without direct state injection
- dev-harness/mock-data route renders a baseline plus two comparison candidates with exact, pool, and spread slot policies
