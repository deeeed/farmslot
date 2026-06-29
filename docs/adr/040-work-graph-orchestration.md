# ADR-040: Work-Graph Orchestration for Backlog Dependency DAGs

- **Status:** Proposed
- **Date:** 2026-06-27
- **Relates-to:**
  - ADR-005 (state persistence) — graph store follows gateway-owned atomic state patterns
  - ADR-013 (gateway-mediated orchestration) — graph reuses the single dispatch path
  - ADR-024 (run lanes & run-family model) — family stays vertical; graph never overloads `parentRunId`
  - ADR-030 (replay provenance & reference evals) — experiments stay orthogonal to the graph
  - ADR-038 (gate-held worker session) — publication gate is a run-step gate the graph observes
  - ADR-039 (run portable bundles) — `artifact` edge evidence may reference a bundle path
  - ADR-027 (unified gateway state) — graph store is durable gateway state with restart reconciliation
  - PR #95 (backlog intake) — a work node is a thin pointer to exactly one backlog item
  - ADR-041 (roadmap idea refinement) — roadmap produces dispatchable backlog specs before any future graph scheduling

---

## 1. Context

Farmslot orchestrates **one objective** end-to-end today. A family (`familyId` +
`parentRunId`, ADR-024) carries a single ticket/PR from `fix-bug` → `review-pr` →
`pr-complete` → `merge-main`, with ci-watch auto-chaining the mechanical follow-ups.
Backlog (PR #95) is flat intake with a 1:1 item→run handoff and no edges. `run.blocked`
means a _live run_ is stopped at a human/engine decision inside its own pipeline.

What is missing is a layer **above** the family that knows objective B must wait for
objective A's PR to merge, and that schedules both across the fleet in parallel without a
human babysitting each handoff. The user's end-state: pass a set of dispatchable objectives, Farmslot fans work out
across runners, respects dependencies, unlocks downstream work, and humans appear only at
explicit surface gates (visual validation/demo, publication/code review, dangerous tier).
Stacked-PR `rebase-onto` is modeled in v1 as a completion blocker with operator attention;
automated ci-watch chaining can replace that attention path once the helper integration is wired.

Two hard problems this ADR must not get wrong:

1. **Do not overload ADR-024 family.** `familyId`/`parentRunId` = _vertical_ lineage for one
   objective. Cross-objective dependency is a different concept and needs a different
   namespace. Reusing `parentRunId` for a cross-objective edge corrupts branch naming,
   family-context inheritance, and readiness summaries.
2. **Do not conflate `run.blocked` (human/engine decision on a live run) with "waiting on
   upstream work" (no run exists yet).** These are distinct states owned by different layers.

---

## 2. Decision

Add a gateway-owned **work graph** layer: a horizontal dependency DAG over objective nodes,
sitting **on top of** the existing backlog → queue → dispatch path. It introduces three
first-class records — `WorkGraph`, `WorkNode`, `WorkEdge` — persisted in a new gateway store.

The load-bearing model is **three orthogonal axes, each with its own identifier namespace,
none reusing another's key**:

```
  WorkGraph (implementation DAG / execution view)  ← HORIZONTAL: ordering across work + blockers
  ├── WorkNode A ──edge──▶ WorkNode B ──edge──▶ WorkNode C ──edge──▶ WorkNode D
  │      │                    │                    │                    │
  │   backlogItemId       reference          backlogItemId          reference
  │   dispatch config     external PR        dispatch config        package publish
  │      │                                     │
  │   familyId=fa                            familyId=fc            ← VERTICAL: lineage of one objective
  │   ├ fix-bug (root run)                   ├ fix-bug (root run)
  │   ├ review-pr (parentRunId→root)         ├ review-pr (parentRunId→root)
  │   ├ pr-complete (parentRunId→root)       └ merge-main (parentRunId→root)
  │   └ merge-main (parentRunId→root)
  │
  Experiment (ADR-030)        ← ORTHOGONAL: eval comparison; cuts across, owns neither
```

**Why family stays vertical (unchanged).** A family is a causal chain about one branch.
Branch naming (`<flow>/<ticket>-<intent-slug>-<variant>`), context inheritance (root's
`report.md`/`learnings.md`/`recipe.json`), and `parentRunId` ("this run _continues_ that one
on the same objective") are all correct _because_ every member shares the root's scope.

**Why the graph stays horizontal (new).** Node B depends on node A's **terminal external
state** (PR merged), not A's run lineage — it inherits A's _side effect_ (merged code on
main), not A's context. Horizontal nodes run on different runners **in parallel** the instant
their upstream edges clear. The graph never writes branch names or family artifacts; its only
outputs are _enqueue / unlock_ decisions.

**Invariant:** `workNodeId`, `familyId`, and `parentRunId` are distinct namespaces. A node
_references_ a family (via its backlog item) but never _is_ one. `parentRunId` is never a
graph edge; the graph-owned `waitingOn` is never a family follow-up. Wanting to set
`parentRunId` to a run in a _different_ family is the signal you actually need a `WorkEdge`.

**The scheduler is a readiness oracle + enqueuer, not a second orchestrator.** It evaluates
edges, then **enqueues ready backlog items through the existing dispatch queue**. For stacked
rebase, v1 records the `rebase-onto` completion blocker and surfaces operator attention until
the existing ci-watch chaining helper is wired into the graph scheduler. It **never calls
`run.create` directly.** ADR-013's gateway-mediated dispatch stays the single execution path
(hard-constraint #5).

---

## 3. Core entities (final types)

New protocol contracts (`packages/protocol/src/contracts/work-graph.ts`). Backlog stays flat;
the graph store owns relationships, scheduling projection, waiting reasons, edge evidence, and
the idempotency ledger.

A work graph is intentionally **cross-project** in v1. `WorkGraph.project` is a graph owner/scope label used for filtering and provenance; it is not a constraint that every node belongs to the same project. The motivating case is one epic whose execution spans multiple project farms and external milestones (for example a source-of-truth package/release task followed by client tasks). Dispatchable backlog nodes use their linked `BacklogItem.project`, so dispatch still uses the correct project hooks, slots, default branch, runner/model policy, and task template. Reference nodes represent external blockers or milestones and are never dispatched.

```ts
// ---- Graph ----
export interface WorkGraph {
  id: string; // wg_<slug>
  version: 1;
  project: string; // graph owner/scope label; nodes may point to backlog items from multiple projects
  title: string;
  source: WorkGraphSource;
  /** Shared normalized tags, compatible with existing Run.tags. */
  tags?: string[];
  status: WorkGraphStatus;
  defaultFailurePolicy: NodeFailurePolicy; // default 'halt'
  scheduler: SchedulerLease; // single-writer guard
  createdAt: string;
  updatedAt: string;
}

export interface WorkGraphSource {
  kind: 'manual' | 'external-import';
  ref?: string; // external issue/milestone url or operator note
  url?: string;
}

export interface SchedulerLease {
  leaseOwner?: string; // gateway worker id
  leaseUntil?: string; // lease expiry (ISO)
  lastTickAt?: string;
}

export type WorkGraphStatus =
  | 'planning' // nodes/edges being authored, scheduler paused
  | 'active' // scheduler ticking
  | 'paused' // operator halt; in-flight runs continue, no new dispatch
  | 'waiting' // healthy: every incomplete node waits on upstream/gate/cap/backoff
  | 'needs-attention' // operator must decide: node failed (policy=halt), cycle after edit, missing rebase metadata, gate rejection
  | 'done' // all required nodes terminal-success / skipped-by-policy / waived
  | 'failed' // unrecoverable (cycle at activate, or operator abandons)
  | 'archived';

export type WorkNodeKind = 'backlog' | 'reference';

export type WorkReferenceKind =
  | 'jira'
  | 'github-pr'
  | 'github-issue'
  | 'package-release'
  | 'artifact'
  | 'manual'
  | 'url'
  | 'other';

export type WorkReferenceStatus =
  | 'unknown'
  | 'pending'
  | 'blocked'
  | 'satisfied'
  | 'failed'
  | 'waived';

// ---- Node: thin pointer — NOT a run, NOT a family, NOT a second backlog row ----
export interface WorkNode {
  id: string; // wn_<short>
  graphId: string;
  kind: WorkNodeKind;
  backlogItemId?: string; // required for kind='backlog'; ALL dispatch config lives HERE
  reference?: WorkNodeReference; // required for kind='reference'; never dispatchable
  /** Shared normalized tags, usually inherited from the backlog item. */
  tags?: string[];
  status: WorkNodeStatus;
  // resolved lazily once the backlog item dispatches; lets the graph observe the CURRENT
  // family without re-deriving it. Retry may update currentFamilyId if lane policy creates
  // a fresh family; supersededFamilyIds keeps restart/evidence history explicit.
  currentFamilyId?: string;
  currentRootRunId?: string;
  latestRunId?: string;
  supersededFamilyIds?: string[];
  // rebase topology — recorded ONLY for nodes targeted by a rebase-onto edge
  baseRef?: string;
  upstreamBaseNodeIds?: string[];
  // why this node is not advancing (operator-facing projection)
  waitingOn: WaitingReason[];
  // failure policy override (else inherits graph.defaultFailurePolicy)
  onFailure?: NodeFailurePolicy;
  updatedAt: string;
}

export interface WorkNodeReference {
  kind: WorkReferenceKind;
  title: string;
  ref: string; // e.g. JIRA-123, org/repo#42, @scope/pkg@1.2.3, manual milestone key
  status: WorkReferenceStatus;
  url?: string;
  project?: string; // optional external/project label for filtering
  owner?: string;
  evidence?: string; // short human-readable proof/status note
  labels?: string[]; // normalized with the same label/tag rules as runs/backlog
  updatedAt?: string;
}

export type WorkNodeStatus =
  | 'planned' // authored but graph not active / scheduler hasn't evaluated it yet
  | 'waiting' // active: ≥1 unsatisfied required upstream edge (≠ run.blocked)
  | 'ready' // all required start edges satisfied; eligible to enqueue
  | 'queued' // backlog item enqueued to dispatch queue
  | 'running' // family active
  | 'gated' // family hit a run-step gate (publication/visual/dangerous)
  | 'succeeded' // family terminal-success (outbound edges satisfied independently)
  | 'failed' // family terminal-failure (raw outcome)
  | 'needs-attention' // failed with policy=isolate, missing rebase metadata, or gate rejection
  | 'skipped'; // operator pruned, or upstream failed with policy=skip-dependents

// ---- Edge: the core new behavior ----
export interface WorkEdge {
  id: string; // we_<short>
  graphId: string;
  fromNodeId: string; // upstream
  toNodeId: string; // downstream
  condition: EdgeCondition;
  required: boolean; // hard dep vs optional input
  blocks?: 'start' | 'completion'; // default 'start'; completion blockers allow downstream start but block finalization/rebase
  status: 'pending' | 'satisfied' | 'failed' | 'waived';
  evidence?: EdgeEvidence; // durable proof of satisfaction (merge SHA, artifact path, manual resolution)
  unlock: UnlockAction; // one unlock per edge in v1 (see §6 for node-level plan)
  lastEvaluatedAt?: string;
}

// `blocks` separates two common dependency shapes:
// - `start` (default): downstream backlog item must not enqueue until the edge is satisfied.
// - `completion`: downstream work may start from an earlier contract/mock/base, but cannot
//   finish/release until the edge is satisfied and its unlock action is handled. This is the
//   stacked/cross-project rebase case: B can start while A is in progress, but after A merges
//   B must rebase before completion.

// Conditions are idempotently evaluable from EXTERNAL durable state, so a restart tick rebuilds them.
export type EdgeCondition =
  | { kind: 'family-done'; outcome?: 'success' | 'terminal' } // family terminal; no PR semantics
  | { kind: 'merged'; targetRef?: string } // DURABLE merge SHA or GitHub closed+merged — NOT a terminal run state
  | { kind: 'manual'; gateId: string } // operator flips it (graph-native gate, §7)
  | { kind: 'reference-status'; status?: WorkReferenceStatus }; // v1 external blocker/reference node status

export interface EdgeEvidence {
  mergeSha?: string;
  prNumber?: number;
  referenceStatus?: WorkReferenceStatus;
  referenceRef?: string;
  manualResolution?: GraphGateResolution;
  observedAt: string;
}

// Future condition extensions stay out of the v1 final type until implemented.
// Expected additions are `{ kind: 'pr-open' }` for stacked work and
// `{ kind: 'artifact'; artifactKind: string; path?: string }` for ADR-039
// artifact-backed edges.

// One unlock per edge in v1. The scheduler composes a node-level plan from all inbound edges (§6).
export type UnlockAction =
  | { kind: 'enqueue' } // default: enqueue to's backlog item
  | { kind: 'mark-ready' } // mark eligible without enqueuing (operator/gate sequencing)
  | { kind: 'rebase-onto'; flow: 'merge-main' | 'pr-complete' }; // completion blocker: rebase downstream onto upstream result (§6)

export type NodeFailurePolicy =
  | 'halt' // graph → needs-attention; no new enqueues (default)
  | 'skip-dependents' // transitive dependents → skipped; independent branches keep running
  | 'isolate'; // only this node → needs-attention; dependents wait for operator

export interface WaitingReason {
  kind: 'upstream' | 'manual-gate' | 'resource' | 'retry-backoff' | 'policy';
  edgeId?: string;
  upstreamNodeId?: string;
  detail: string;
}

export interface GraphGateResolution {
  gateId: string;
  nodeId?: string;
  edgeId?: string;
  reason: string;
  decision: 'approved' | 'rejected' | 'waived';
  resolvedAt: string;
}
```

**Additive linkage (the only writes outside the graph store) — observation, not orchestration:**

```ts
interface BacklogItem {
  workGraphId?: string;
  workNodeId?: string;
}
interface QueueItem {
  workGraphId?: string;
  workNodeId?: string;
}
interface Run {
  workGraphId?: string;
  workNodeId?: string;
}
```

`waitingOn` is **not** added to `Run`: a run that doesn't exist yet can't be "waiting." Upstream
waiting is a `WorkNode` property; `RunStatus.blocked` stays a human/engine state for an
_existing_ run. The graph otherwise reads only existing run fields
(`familyId`/`status`/`prNumber`/outcome) — one-directional observation.

---

## 4. State machines

### Graph

```
 planning ──activate(cycle check)──▶ active ⇄ paused
                                       │  │  └─ no runnable node ──▶ waiting ──▶ active
            node failed (policy=halt)  │  └─ all required nodes terminal ──▶ done
            or cycle after edit         ▼
                            needs-attention ──operator resolves──▶ active
 needs-attention ──operator abandons──▶ failed
 any non-terminal ──▶ archived
```

`waiting` is **healthy** (everything is correctly blocked on upstream/gate/cap/backoff).
`needs-attention` means the scheduler cannot make a deterministic choice and a human must act.

### Node

```
 planned ──graph active──▶ waiting ──all required start edges satisfied──▶ ready
   ▲                          ▲                                       │ scheduler enqueues backlog item
   │             (edge added / upstream reset)                        ▼
   │                                                                queued ──dispatch──▶ running
   │                                                                                       │
   │                                        family hits run-step gate                      │ family terminal
   │                                       ┌──────────────────────────┐                    │
   │                                       ▼                          │                    ▼
   │                                     gated ──gate resolved────────▶ running        ┌───┴────┐
   └────────── failed / needs-attention ◀── (onFailure policy) ──────────────────────┘    succeeded
```

A node reaches `succeeded` on **family terminal-success** only after any required completion blockers have been handled. Its _outbound_ edges carry their own satisfied-bit; a `merged` edge only fires once the PR actually merges (possibly after the family's last run). So an upstream node can be `succeeded` while a downstream completion/rebase edge is still `pending`. **UI must render the edge state explicitly, never a bare "done" for the whole graph.**

### Edge

```
 pending ──(durable evidence observed)──▶ satisfied
    ▲   └──(required upstream terminal-failure)──▶ failed ──operator waives──▶ waived
    └──── upstream node reset / PR reverted (before downstream runs) ───────────────┘
```

### Run-waiting vs run-blocked (hard-constraint #2)

- **`run.blocked`** (existing) — a live run stopped at an engine/human decision inside its own
  pipeline. Owned by the run engine. **Unchanged.**
- **`WorkNode.waiting`** (new) — _no run exists yet_; required upstream edges unsatisfied. Owned
  by the scheduler. Nothing to block — the backlog item simply isn't enqueued.

These never overlap: a node only leaves `waiting` when it is ready to create a run. Once a run
exists, normal `run.blocked` applies; the graph does not reinterpret it.

---

## 5. Scheduler + events

**Event-driven first, periodic reconcile tick as the idempotent backstop, guarded by a
per-graph lease.**

```ts
type WorkGraphEvent =
  | { kind: 'graph.created' | 'graph.updated'; graphId: string }
  | { kind: 'family.terminal'; familyId: string; outcome: 'success' | 'failure' | 'cancelled' }
  | { kind: 'run.status-changed'; runId: string; status: RunStatus }
  | {
      kind: 'pr.opened' | 'pr.merged' | 'pr.closed' | 'pr.unmerged';
      repo: string;
      prNumber: number;
      mergeSha?: string;
    }
  | { kind: 'gate.opened' | 'gate.resolved'; gateId: string; runId?: string }
  | { kind: 'artifact.indexed'; runId: string; artifactKind: string }
  | { kind: 'scheduler.tick'; graphId?: string }; // periodic (~60s) + on gateway boot
```

Event sources (v1 glue; some source facts exist today, while graph events are new emissions to add where noted):

- **`family.terminal`** — run engine already computes family completion
  (`buildRunFamilyReadinessSummaries`); v1 emits a graph event when that projection changes.
- **`pr.merged` / `pr.unmerged`** — ci-watch already polls PR state and detects merge or
  revert; v1 emits graph events carrying the **merge SHA** (durable evidence) or revert signal
  instead of only chaining intra-family.
- **`gate.opened/resolved`** — ADR-038 publication gate already transitions slot phase; v1
  surfaces that transition as a graph event.
- **`scheduler.tick`** — recomputes every `active` or `waiting` graph's edge satisfied-bits and node statuses
  from current **durable** external state. The idempotent backstop: on restart the first tick
  rebuilds everything, so no event is "lost." Webhooks (v2) just lower `pr.merged` latency.

**Scheduler loop (per tick / per event), under lease:**

```
acquire/renew per-graph lease            // skip the graph if another worker holds the lease
load graph + linked backlog/queue/runs + family summaries + PR facts + gates + artifact indexes
for each edge:  re-evaluate status from DURABLE source facts (pure, idempotent)
for each node:  recompute waitingOn + status projection
for each node whose ALL required `start` inbound edges are satisfied:
   compute a NODE-LEVEL start unlock plan from satisfied `start` edges (deterministic order)
   if the plan permits enqueue (not mark-ready/manual-gate-only):
      execute via existing services (default: backlog.enqueue(backlogItemId))
   record node-level ActionKey in the idempotency ledger
persist graph + ledger atomically; broadcast graph update
detect cycles at activate; an edge added to an active graph that introduces a cycle → needs-attention
```

**Node-level unlock plan.** Multiple inbound `start` edges may satisfy together with possibly conflicting start actions. The scheduler does **not** fire the satisfying edge's action in isolation; it computes one deterministic node-level plan for start readiness. `mark-ready` edges gate without enqueuing. Exactly one enqueue per node-readiness transition.

**Completion blockers.** `blocks: 'completion'` edges are evaluated and rendered like other edges, but they do not block the downstream node from starting. They block finalization/release readiness and are where `rebase-onto` belongs: after upstream durable evidence appears (usually `merged`), the downstream family must be rebased/continued before it can be treated as complete for graph purposes.

**Idempotency ledger.** Every node-level unlock records
`ActionKey = ${graphId}:${nodeId}:${actionKind}:${readinessVersion}` with
`startedAt/completedAt/result`. `readinessVersion` is a deterministic hash of the graph version,
the node id, satisfied required start-edge ids, and the computed node-level action plan. It is
not a single `edgeId`, because multiple inbound edges may satisfy together while still producing
exactly one enqueue. If the gateway crashes after `backlog.enqueue` returns but before the graph
persists, the next tick reconciles by `workGraphId+workNodeId` (the additive linkage fields): it
finds the existing queue/run and marks the action complete instead of double-enqueuing.
Conditions are idempotent for _reading_; the ledger covers the _write_ side.

**Concurrency rules:**

- One active root run per production-lane node. Multiple attempts allowed, but one active
  attempt unless the lane is explicitly `comparison`.
- The scheduler may enqueue many ready nodes, but **never bypasses** the existing dispatch
  queue, slot scoring, or eval slot caps. Parallel graph fan-out is throttled the same
  way as flat backlog/queue dispatch — the graph only decides _which_ items become eligible
  to enqueue, not _how many slots_ they may claim.
- A required failed upstream blocks dependents until retried, replaced, waived, or skipped.

---

## 6. Integration with backlog / queue / family / ci-watch / gates / bundles

| Existing primitive             | Graph reuse                                                                                                                      | New glue                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Backlog (PR #95)**           | `WorkNode.kind='backlog'` points to one `backlogItemId`; `unlock` calls `backlog.enqueue`; all dispatch config lives on the item | `workGraphId`+`workNodeId` back-ref                                                      |
| **External blockers**          | `WorkNode.kind='reference'` records typed refs/status/evidence; never dispatches                                                 | `reference-status` edges block/unblock downstream work                                   |
| **Dispatch queue**             | unchanged — graph enqueues, queue dispatches/throttles                                                                           | `workGraphId`+`workNodeId` on `QueueItem` for reconcile                                  |
| **Family (ADR-024)**           | graph reads current family terminal state; never writes family fields or `parentRunId`                                           | resolve `currentFamilyId`+`currentRootRunId` onto node once first run dispatches         |
| **ci-watch chain**             | intra-family auto `pr-complete`/`merge-main` stays exactly as-is                                                                 | ci-watch _also_ emits `pr.merged`(+SHA)/`family.terminal` graph events                   |
| **Publication gate (ADR-038)** | `gated` node status mirrors the gate-held run                                                                                    | `gate.resolved` emits a graph event; downstream `merged` edges wait for the actual merge |
| **Bundles (ADR-039)**          | `artifact` edge condition resolves against a run bundle path                                                                     | bundle path lookup in the edge evaluator; bundles are evidence, never the graph store    |
| **Webhooks (v2)**              | low-latency `pr.merged`/gate facts                                                                                               | GitHub webhook receiver; reconciliation stays authoritative                              |

### Cross-project graph semantics

A graph may contain backlog items from multiple projects plus reference nodes from external systems. The graph-level `project` field is an owner/scope label, not a dispatch project. Every dispatch decision still reads `BacklogItem.project` from the node's linked backlog item, so project-specific hooks, slots, templates, default branches, and validation remain owned by the target project. Reference nodes have only typed refs/status/evidence and are never dispatched. Cross-project graphs therefore coordinate order; they do not merge project configuration.

### Backlog auto-dispatch exclusivity

PR #95 backlog items may set `autoDispatch: true` and are picked up by
`backlog.autoDispatchTick` independently of any graph. **Graph-linked backlog items must not
double-enqueue.**

Rules:

0. A `BacklogItem` may be attached to at most one non-archived backlog `WorkNode`; graph node creation
   and updates must reject attempts to reuse the same backlog item in another live graph.
1. When a backlog item is attached to a work graph node (`workGraphId` + `workNodeId` set),
   graph-owned scheduler/retry/reopen/detach actions are the only enqueue authority for that
   item. This includes `planning`, `active`, `paused`, `waiting`, `needs-attention`, and
   terminal graph states while linkage remains: paused means no new enqueues, and
   waiting/needs-attention/done must not be bypassed by the operator UI.
2. `backlog.autoDispatchTick` **skips** every item with `workGraphId` set. Terminal graph
   status does not make the item standalone again.
3. `backlog.enqueue` from the operator UI is rejected for any item whose `workGraphId` /
   `workNodeId` linkage is still set, regardless of graph status. Operators must detach the
   item first, or use an explicit graph-owned retry/reopen action that records why a terminal
   node is being rerun.
4. Detaching a backlog item means an explicit operator/API action that clears both `workGraphId`
   and `workNodeId` after the graph is terminal, or after the node is removed before activation;
   detached items then behave like standalone backlog items.
5. Standalone backlog items (no `workGraphId`) keep today's flat auto-dispatch behaviour.

This prevents races between the graph scheduler and the flat backlog tick from creating
duplicate queue items or runs for the same objective.

### Eval slot caps

Shared dispatch queue / eval slot caps (PR #86) apply unchanged. The graph scheduler calls
`backlog.enqueue`; `tryDispatchNext` and eval-matrix caps decide when items actually claim
slots. A graph with ten ready nodes may enqueue ten items, but only `N` may run concurrently
per project eval cap — same as today. The graph does not add a parallel slot-allocation path.

### Comparison-lane nodes

A work node in the **production** lane has at most **one active root run** at a time
(ADR-024 duplicate guard). The graph does **not** model comparison siblings or eval rubrics
(ADR-030 stays orthogonal).

If a graph node needs multi-runner comparison:

- Use ADR-024 `lane: comparison` + `variant` on the **backlog item / run.create** path for
  that node, with the graph treating the node as `running` until the comparison family
  subtree is terminal per family-readiness rules; or
- Run a separate ADR-030 experiment outside the graph and satisfy an `artifact` edge (v2)
  from the winning package.

The graph never fans out multiple comparison variants of the same node internally — that
would conflate horizontal scheduling with eval methodology.

**`rebase-onto` (stacked PRs) — completion blocker, not a new run path.**
When edge `A ──merged──▶ B` fires and B's PR already exists, v1 marks B as needing operator
attention for a downstream rebase/continue step. That keeps the dependency visible without
forging runs or inventing a second orchestration path. A follow-up can wire this to
**`buildCIWatchChainedRunParams`'s exact mechanism** (the same path ci-watch already uses
intra-family); at that point the graph should only supply the trigger ci-watch would otherwise
supply. The downstream node records `baseRef` / `upstreamBaseNodeIds` / rebase run ID /
before+after SHAs as evidence when that integration exists, since ADR-024 branch naming is
per-family and cross-family base relationships aren't recorded anywhere today. The upstream
merge **never** becomes `parentRunId` of the downstream run.

---

## 7. Human gate taxonomy

Two distinct gate locations — never conflated:

1. **Run-step gates (inside a family — existing, reused unchanged).**
   - Publication / code review approval (ADR-038)
   - Visual validation / recipe demo
   - Dangerous safety-tier confirmation (ADR-023)
   - Engine ambiguity decisions inside a live run

   They fire _during_ a node's run, owned by the run engine. The graph observes them as node
   status `gated` and does **not** advance downstream `merged` edges until the gate resolves and
   the PR actually merges. No new gate machinery.

2. **Graph gates (between objectives — new but minimal, owned by ADR-040).**
   - `{ kind: 'manual'; gateId }` edge condition — "operator must flip this before downstream
     unlocks." The one graph-native sequencing gate.
   - Dependency waiver after a required upstream fails or optional evidence is missing.
   - Graph activation approval (`planning` → `active`).
   - Scope split/merge decisions that edit nodes/edges.

   Graph gates are explicit `GraphGateResolution` records (`gateId/nodeId?/edgeId?/decision`).
   They are **never** represented as `RunStatus.blocked` unless a run already exists and is
   genuinely waiting on that gate.

**Rule of thumb:** if the decision is whether an existing run may _continue or publish_, it's a
run-step gate. If it's whether a node may _become schedulable relative to other nodes_, it's a
graph gate.

Mapping the user's vision — _"human only at visual validation/demo and publication/code
review"_: both map to **existing run-step gates**. ADR-040 adds **one** gate type (the `manual`
edge) and otherwise defers entirely to the per-objective gates that already stop the line. No
graph-level approval system is invented.

---

## 8. Work-graph intake and roadmap positioning (v1 vs deferred)

**v1 — deterministic, operator-authored over backlog work plus reference blockers:**

ADR-041 is the roadmap/product-planning layer. Rough or refined roadmap items do not enter a
work graph directly. The normal layered path is:

```text
RoadmapItem(stage=refined) -> promote -> Backlog markdown spec(s) + optional references -> WorkGraph -> dispatch
```

Direct PR #95 backlog intake remains supported only for items that are already dispatchable.
External themes that still need product discovery should import to roadmap first. External
blockers/milestones that are already known but not Farmslot-owned may enter the work graph as
reference nodes.

Execution steps:

```
1. Operator creates, imports, or receives dispatchable backlog items and known external references
2. workGraph.create({ project, title, source }) → status 'planning'
3. workGraph.addNode({ graphId, backlogItemId }) ×N and/or workGraph.addNode({ graphId, kind:'reference', reference }) ×R
4. workGraph.addEdge({ from, to, condition, required, unlock }) ×M
5. Gateway validates: acyclic graph, required fields, branch topology (if rebase/completion edges); nodes may reference backlog items from different projects and external blocker refs
6. workGraph.activate(graphId)  → cycle check → scheduler takes over
7. Scheduler marks dependency-free backlog nodes ready/enqueued; reference nodes only expose status/evidence
8. Family / run / PR / gate / reference / artifact events unlock downstream nodes
9. Graph 'done' when every required node is succeeded/skipped and every required edge is satisfied or waived
```

Methods (v1): `workGraph.create / get / list / addNode / addEdge / updateNode / activate /
pause / gateResolve / schedulerTick`.

`source: 'external-import'` in v1 only **records provenance + bulk-creates explicit nodes** from
external children: dispatchable items become backlog nodes, non-owned blockers become reference
nodes. It does **not** infer edges — edges are operator-authored in v1. Rough external themes import
through ADR-041 roadmap first.

**Deferred:**

- Auto-edge inference (Jira "blocks" links, GitHub task-list refs) — v2.
- LLM decomposition of existing backlog specs into nodes+edges — v3, always gated behind a
  human-reviews-the-graph step. **Never auto-activate an LLM-proposed graph** — a wrong edge
  silently serializes parallel work or unlocks downstream work prematurely. Prove the engine
  with hand-authored graphs first; the engine is identical regardless of who authored the edges.

---

## 9. Failure / recovery

**Per-node `onFailure` policy** (default `halt`), evaluated when a node's family reaches
terminal-failure:

- **`halt`** — graph → `needs-attention`; no new enqueues; in-flight nodes finish. Operator
  retries, replaces, edits edges, or aborts. Safest default — a failed upstream usually
  invalidates downstream assumptions.
- **`skip-dependents`** — transitive dependents → `skipped`; independent branches keep running.
- **`isolate`** — only this node → `needs-attention`; direct dependents stay `waiting` for the
  operator.

**Retry vs replace.** Retry re-enqueues the **same node's** backlog item and
**stays attached to the same node**. If lane policy continues the existing family,
`currentFamilyId` is unchanged. If lane policy creates a fresh family, the node moves the old
`currentFamilyId` into `supersededFamilyIds` and sets `currentFamilyId/currentRootRunId` to the
new family. Edge evaluation always uses `currentFamilyId`; historical evidence can query both
current and superseded family ids. Retry does **not** silently mint a new objective. Replacing a
node's objective is an explicit operator edit, not a retry.

**Required vs optional edges.** A required failed upstream blocks dependents until retry,
replace, waive, skip, or graph cancellation. An optional edge may be waived automatically only
if node policy explicitly allows it, and the downstream task context must record the missing
optional input.

**Partial completion / revert.** If an upstream PR is reverted after merge, ci-watch emits a
`pr.unmerged` graph event → the edge satisfied-bit flips back to `pending` → downstream nodes that were
`ready`/`queued` but **not yet `running`** revert to `waiting`. Already-`running` downstream
nodes are **not** clawed back (can't un-dispatch a worker) — they're flagged for operator review.
Honest boundary: the graph prevents premature _starts_; it can't undo _in-flight_ work.

**Cycle handling.** Cycles are rejected at `activate` (DFS, reject with the offending edge set →
graph `failed`). A cycle introduced by editing an active graph is an **authoring error, not an
execution failure**: graph → `needs-attention`, dispatch nothing until fixed.

**Gateway restart.** No durable scheduler state needed beyond graph/node/edge records + the
action ledger. The first tick after boot recomputes every satisfied-bit and node status from
runs + **durable** PR state (merge SHA / closed+merged), and the ledger + back-refs prevent
re-running an unlock that already enqueued. This is why conditions must be idempotently evaluable
from external state rather than from consumed events; `manual` edges persist their resolution.

---

## 10. Phased rollout

- **v0 (this doc).** ADR-040 Proposed — vocabulary and entity model only. No implementation code.

- **v1 — execution engine + stacked-PR visibility, operator-authored graphs.**
  The brief requires v1 to prove parallel fan-out and represent stacked-PR completion blockers,
  so `rebase-onto` is **in v1** as a modeled completion unlock that currently surfaces operator
  attention instead of launching the chained run automatically. Ships:
  - `work-graph.ts` contracts (`version: 1`; future incompatible schema changes require a
    version bump plus read/migration handling); gateway JSON snapshot store
    (`services/gateway/src/work-graph/store.ts`, `.work-graphs/{id}.json`) with atomic
    write/rename semantics + action ledger.
  - `workGraph.create/get/list/addNode/addEdge/updateNode/activate/pause/gateResolve` +
    `schedulerTick`.
  - Scheduler with **per-graph lease** + **idempotency ledger**, reacting to `family.terminal`,
    `pr.merged`, and `scheduler.tick`.
  - Cross-project nodes: graph owner/scope may differ from each linked `BacklogItem.project`; dispatch uses the backlog project.
  - Nodes: dispatchable `backlog` nodes plus non-dispatchable `reference` nodes for external blockers/milestones.
  - Conditions: `family-done`, `merged` (durable), `manual`, `reference-status`. Edge `blocks`: `start` and `completion`. Unlock: `enqueue` + `mark-ready` + `rebase-onto` as an operator-attention completion blocker until `buildCIWatchChainedRunParams` is wired.
  - `baseRef`/`upstreamBaseNodeIds` + rebase evidence fields for the stacked case.
  - Additive `workGraphId`/`workNodeId` back-refs on backlog/queue/run.
  - **Read-only Command Center surface**: graph list, node statuses, waiting reasons, linked
    runs, and typed external blockers/milestones in the same DAG.
  - **Proves:** parallel cross-project fan-out across runners + stacked/completion rebase-unlock with
    hand-authored edges. Validation: restart reconciliation, no duplicate enqueue, no
    `RunStatus.blocked` for uncreated downstream work.

  > If during v1 build the rebase path proves riskier than the basic scheduler warrants, it may
  > be split to a **v1.5** milestone — but the ADR's headline v1 goal is the stacked-PR proof,
  > so it is planned _into_ v1, not deferred by default.

- **v2 — intake + UI editing.** Jira/GitHub bulk source import with auto-edge
  inference from native dependency links; graph editor in Command Center; full DAG
  visualization; GitHub webhooks for low-latency `pr.merged` and reference status refresh; `artifact`/bundle edge conditions;
  operator actions for retry/replace/waive/skip.

- **v3 — LLM decomposition + advanced orchestration.** Proposed graph from existing backlog specs
  (human-reviewed before activate); critical-path scheduling; priority
  inheritance; analytics; portable cross-gateway graph execution.

**Roadmap relationship (ADR-041).** WorkGraph v1 is an implementation orchestration DAG over backlog specs and execution blockers.
Roadmap still owns idea/epic intent, while Backlog owns dispatchable implementation specs. A
roadmap item may link to zero or more backlog items and zero or more WorkGraphs, but roadmap-level
visualization remains a separate ADR-041 concern. WorkGraph can be displayed as an epic execution
view, cross-project release train, project-specific subset, or operator-defined implementation
slice, but its active scheduler semantics apply only to backlog/reference nodes inside the graph.

**Reference blockers and drilldown (v1 decision).** v1 supports generic reference nodes for work
or milestones not implemented through Farmslot: Jira tickets owned by another team, GitHub PRs,
release approvals, package publishes, artifacts, or manual operational milestones. A reference node
has a typed source ref, status/evidence, labels, and human-readable notes. It is non-dispatchable by
default and therefore cannot own acceptance criteria, runner/model policy, slots, or task templates.
If Farmslot should own the work, the operator promotes it into a backlog item with acceptance
criteria and dispatch config, then links that backlog item into the graph. Otherwise it stays a
reference node or edge condition/evidence, clearly distinct from dispatchable backlog nodes so the
scheduler never tries to enqueue work Farmslot does not own.

Drilldown is intentionally shallow in v1: a backlog node links to its backlog markdown/spec and run
family; a reference node links to its external URL/ref/evidence. Nested epic decomposition stays in roadmap/ADR-041. Implementation drilldown is modeled with
multiple WorkGraphs and shared tags/source refs rather than a separate hierarchy table in ADR-040.
Promotion from roadmap/LLM planning into an active orchestration graph remains explicit and
human-reviewed, because only active WorkGraphs affect scheduler behavior.

**Roadmap graph boundary.** Long-term roadmap visualization should not reuse active WorkGraph
semantics. A roadmap graph is a high-level planning view over epics, rough/refined ideas, external
milestones, and conceptual dependencies. It is non-dispatchable and has no scheduler authority. An
implementation WorkGraph begins when the operator expands/refines roadmap intent into concrete
backlog specs and chooses the dependencies that should affect execution. This prevents a rough idea
from accidentally behaving like a queueable task while still allowing UI drilldown from roadmap epic
→ backlog specs → implementation WorkGraph → run families.

**Multi-level graph UX (future ADR-041/Command Center work).** Command Center should eventually expose a Graphs index before the canvas: searchable graph artifacts with filters for level, project scope, labels/tags, status, and recently updated. The operator selects a specific graph to view; the UI must not silently infer a graph from all matching specs. Supported levels should remain explicit: roadmap/epic planning graphs, implementation WorkGraphs, and run/family execution graphs. Users should be able to work with a refinement agent to create proposed roadmap graphs or epics before any job is deployed. Those planning graphs make dependencies visible early, but remain non-dispatchable artifacts until the operator promotes parts of them into backlog specs and explicitly creates or updates an active WorkGraph. Backlog/spec detail views can show graph membership and offer “add to graph/create graph” actions, but selection still resolves to a concrete graph artifact.

**Node configuration boundary (v1 decision).** Clicking a graph node should make execution
readiness/configuration visible, but it must not move dispatch configuration into the graph. For a
backlog node, the drilldown/editor opens the backing backlog spec and edits the BacklogItem fields
that already own execution policy: status/readiness, acceptance criteria in markdown, tags, priority,
flow type, allowed slots, auto-dispatch policy, and any future runner/model selection. For a
reference node, the editor only changes reference fields: type, URL/ref, status, evidence, owner,
and labels. The graph can visualize both layers at once — graph execution state
(`waiting/running/gated/succeeded`) and spec/reference readiness (`candidate/ready/done/pending`) —
but the scheduler still dispatches only backlog nodes whose backing spec is ready.

**Persistence (v1 decision): new gateway store, not extending backlog.** Backlog rows stay flat
(PR #95's clean contract); graph/node/edge + ledger live in a sibling store. Node→backlog is a
foreign key. Cramming `dependsOn[]` into `BacklogItem` would re-create the exact "overload one
model for many jobs" anti-pattern ADR-024 §0 warns against.

---

## 11. Failure/recovery quick-reference

(Detail in §9; summary for operators.)

| Situation                                     | Graph result                                 | Operator options                           |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| Node family fails, `onFailure=halt`           | graph `needs-attention`                      | retry / replace / waive / skip / cancel    |
| Node family fails, `skip-dependents`          | dependents `skipped`                         | none required; independent branches run on |
| Node family fails, `isolate`                  | node `needs-attention`, dependents `waiting` | hand-fix, then resume                      |
| Required upstream edge `failed`               | dependents blocked                           | retry upstream / waive edge / replace node |
| Optional edge `failed`                        | downstream proceeds (if policy allows)       | auto-waive records missing input           |
| Upstream PR reverted (downstream not running) | edge → `pending`, node → `waiting`           | none; auto-reverts                         |
| Upstream PR reverted (downstream running)     | flagged for review                           | manual cancel if desired                   |
| Cycle at activate                             | graph `failed`                               | fix edges, re-activate                     |
| Cycle after edit                              | graph `needs-attention`                      | remove edge                                |
| Gateway restart                               | tick recomputes from durable state           | none; idempotent                           |

---

## 12. Non-goals (v1)

- **No overloading ADR-024 family / `parentRunId` / branch naming** for cross-objective deps.
- **No new `RunStatus.blocked` meaning** for dependency-waiting.
- **No scheduler-forged runs** — unlock is `enqueue` / `mark-ready` / `rebase-onto`; v1
  `rebase-onto` surfaces operator attention until it can reuse ci-watch's existing mechanism.
  ADR-013 stays the only execution path.
- **No fat node config** — dispatch policy (flow/lane/model/slots/priority) lives on the backlog
  item, never duplicated onto the node.
- **No `WorkNodeAttempt[]` array on the node** — attempt history derives from family/run queries.
- **No LLM graph decomposition** — v3, always human-reviewed before activate.
- **No graph editing UI** — read-only in v1 after creation; editor in v2. Activation
  approval is the explicit `planning -> active` transition in `workGraph.activate`, not a
  separate run gate.
- **No auto-edge inference** from Jira/GitHub links — v2.
- **No clawing back in-flight downstream runs** on upstream revert — flagged for operator.
- **No new human-gate machinery** — reuse ADR-038 / ADR-023 / recipe gates + the one `manual` edge.
- **No holding slots for graph dependencies** — `waiting` nodes hold _nothing_; no run exists.
- **No experiments in the graph** — ADR-030 stays orthogonal; comparison work uses ADR-024
  comparison lane on the node's backlog/run path, not graph-internal fan-out.
- **No portable-bundle contents in graph state** — bundles are edge evidence, not the store.
- **No bypassing backlog auto-dispatch guards** — graph-linked items are scheduler-only.
- **No bypassing eval slot caps or queue throttling** — graph enqueues; queue dispatches.

---

## 13. Open questions for Arthur

Only genuinely unresolved (architecture calls are made above):

1. **`merged` target ref** — is "merged to the project default branch" the right universal
   condition, or do some objective sets merge to a feature integration branch? (`targetRef` is already in the type;
   the open call is the default behaviour when it is omitted.)
2. **Default `onFailure`** — `halt` is the chosen default (safest). Do you want `skip-dependents`
   as the default for _exploratory_ graphs so one dead objective doesn't freeze the whole graph?
3. **Manual-gate placement** — is a `manual` _edge_ enough for graph checkpoints, or do you want a
   first-class "checkpoint" node that pauses everything downstream regardless of branch? (We
   lean edge-only for minimalism.)
4. **Revert handling** — is "don't claw back in-flight runs, just flag" acceptable, or should the
   graph attempt cancellation of in-flight dependents when an upstream merge is reverted?
5. **v2 intake priority** — Jira or GitHub bulk-source importer first?
6. **v1 Command Center surface** — is a list/table with waiting reasons enough for v1, or do you
   want the read-only DAG view in the first cut?
7. **Stacked-PR base tracking depth** — is per-node `baseRef`/`upstreamBaseNodeIds` enough, or do
   you want stack topology as a first-class edge attribute from the start?

---
