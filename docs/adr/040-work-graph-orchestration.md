# ADR-040: Work-Graph Orchestration for Backlog Dependency DAGs

- **Status:** Proposed
- **Date:** 2026-06-27
- **Relates-to:**
  - ADR-013 (gateway-mediated orchestration) — graph reuses the single dispatch path
  - ADR-024 (run lanes & run-family model) — family stays vertical; graph never overloads `parentRunId`
  - ADR-030 (replay provenance & reference evals) — experiments stay orthogonal to the graph
  - ADR-038 (gate-held worker session) — publication gate is a run-step gate the graph observes
  - ADR-039 (run portable bundles) — `artifact` edge evidence may reference a bundle path
  - PR #95 (backlog intake) — a work node is a thin pointer to exactly one backlog item
  - ADR-041 (roadmap idea refinement) — roadmap can promote one refined item into many backlog items plus an optional work graph

**Review signoffs:** Reconciled from independent planning/review proposals (2026-06-27 tmux brainstorm). The consensus draft was approved with operational patches D13–D15 (§13, §15). Design only — not an implementation order until roadmap-approved.

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
across runners, respects dependencies, auto-unlocks downstream work (including rebase +
pr-complete on stacked PRs), and humans appear only at explicit surface gates (visual
validation/demo, publication/code review, dangerous tier).

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
  WorkGraph (dependency DAG)  ← HORIZONTAL: ordering between dispatchable objectives
  ├── WorkNode A  ──edge──▶ WorkNode B  ──edge──▶ WorkNode C
  │      │                     │                     │
  │   backlogItemId         backlogItemId         backlogItemId   ← intake + dispatch config (PR #95)
  │      │                     │                     │
  │   familyId=fa           familyId=fb           familyId=fc     ← VERTICAL: lineage of one objective
  │   ├ fix-bug (root run)
  │   ├ review-pr (parentRunId→root)
  │   ├ pr-complete (parentRunId→root)
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
edges, then **enqueues ready backlog items through the existing dispatch queue** (or, for
stacked rebase, reuses ci-watch's chaining mechanism). It **never calls `run.create`
directly.** ADR-013's gateway-mediated dispatch stays the single execution path
(hard-constraint #5).

---

## 3. Core entities (final types)

New protocol contracts (`packages/protocol/src/contracts/work-graph.ts`). Backlog stays flat;
the graph store owns relationships, scheduling projection, waiting reasons, edge evidence, and
the idempotency ledger.

```ts
// ---- Graph ----
export interface WorkGraph {
  id: string; // wg_<slug>
  version: 1;
  project: string; // single-project in v1 (§12 non-goals)
  title: string;
  source: WorkGraphSource;
  /** Shared label keys from ADR-041; propagated from roadmap/backlog when graph is drafted from promotion. */
  labelKeys?: string[];
  /** Roadmap provenance when this graph was created by ADR-041 promotion. */
  roadmapItemIds?: string[];
  roadmapEpicId?: string;
  roadmapSnapshotHash?: string;
  promotionEntryId?: string;
  status: WorkGraphStatus;
  defaultFailurePolicy: NodeFailurePolicy; // default 'halt'
  scheduler: SchedulerLease; // single-writer guard
  createdAt: string;
  updatedAt: string;
}

export interface WorkGraphSource {
  kind: 'manual' | 'roadmap-promotion' | 'external-import';
  ref?: string; // roadmap item/epic id, external issue/milestone url, or operator note
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

// ---- Node: thin pointer — NOT a run, NOT a family, NOT a second backlog row ----
export interface WorkNode {
  id: string; // wn_<short>
  graphId: string;
  backlogItemId: string; // 1:1 — ALL dispatch config (flow, lane, model, slots, priority) lives HERE
  /** Shared label keys from ADR-041; usually inherited from the backlog item / roadmap promotion. */
  labelKeys?: string[];
  /** Roadmap provenance mirrored from the backing backlog item for graph queries. */
  roadmapItemId?: string;
  roadmapEpicId?: string;
  roadmapSnapshotHash?: string;
  promotionEntryId?: string;
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

export type WorkNodeStatus =
  | 'planned' // authored but graph not active / scheduler hasn't evaluated it yet
  | 'waiting' // active: ≥1 unsatisfied required upstream edge (≠ run.blocked)
  | 'ready' // all required edges satisfied; eligible to enqueue
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
  status: 'pending' | 'satisfied' | 'failed' | 'waived';
  evidence?: EdgeEvidence; // durable proof of satisfaction (merge SHA, artifact path, manual resolution)
  unlock: UnlockAction; // one unlock per edge in v1 (see §6 for node-level plan)
  lastEvaluatedAt?: string;
}

// Conditions are idempotently evaluable from EXTERNAL durable state, so a restart tick rebuilds them.
export type EdgeCondition =
  | { kind: 'family-done'; outcome?: 'success' | 'terminal' } // family terminal; no PR semantics
  | { kind: 'pr-open' } // v2: from's PR exists & open (stacked work)
  | { kind: 'merged'; targetRef?: string } // v1: DURABLE merge SHA or GitHub closed+merged — NOT a terminal run state
  | { kind: 'artifact'; artifactKind: string; path?: string } // v2: named artifact present in from's bundle (ADR-039)
  | { kind: 'manual'; gateId: string }; // v1: operator flips it (graph-native gate, §8)

export interface EdgeEvidence {
  mergeSha?: string;
  prNumber?: number;
  artifactPath?: string;
  manualResolution?: GraphGateResolution;
  observedAt: string;
}

// One unlock per edge in v1. The scheduler composes a node-level plan from all inbound edges (§6).
export type UnlockAction =
  | { kind: 'enqueue' } // default: enqueue to's backlog item
  | { kind: 'mark-ready' } // mark eligible without enqueuing (operator/gate sequencing)
  | { kind: 'rebase-onto'; flow: 'merge-main' | 'pr-complete' }; // stacked PRs — reuses ci-watch's chaining mechanism (§6)

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
 planned ──graph active──▶ waiting ──all required edges satisfied──▶ ready
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

A node reaches `succeeded` on **family terminal-success**. Its _outbound_ edges carry their
own satisfied-bit; a `merged` edge only fires once the PR actually merges (possibly after the
family's last run). So a node can be `succeeded` while a downstream `merged` edge is still
`pending`. **UI must render "succeeded — merge edge pending," never a bare "done"** (consensus
log D2).

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
      kind: 'pr.opened' | 'pr.merged' | 'pr.closed';
      repo: string;
      prNumber: number;
      mergeSha?: string;
    }
  | { kind: 'gate.opened' | 'gate.resolved'; gateId: string; runId?: string }
  | { kind: 'artifact.indexed'; runId: string; artifactKind: string }
  | { kind: 'scheduler.tick'; graphId?: string }; // periodic (~60s) + on gateway boot
```

Event sources (all emit today or are cheap to add):

- **`family.terminal`** — run engine already computes family completion
  (`buildRunFamilyReadinessSummaries`). Subscribe the scheduler.
- **`pr.merged`** — ci-watch already polls PR state and detects merge. Emit a graph event
  carrying the **merge SHA** (durable evidence) instead of only chaining intra-family.
- **`gate.opened/resolved`** — ADR-038 publication gate already transitions slot phase;
  surface the transition as a graph event.
- **`scheduler.tick`** — recomputes every `active` graph's edge satisfied-bits and node statuses
  from current **durable** external state. The idempotent backstop: on restart the first tick
  rebuilds everything, so no event is "lost." Webhooks (v2) just lower `pr.merged` latency.

**Scheduler loop (per tick / per event), under lease:**

```
acquire/renew per-graph lease            // skip the graph if another worker holds the lease
load graph + linked backlog/queue/runs + family summaries + PR facts + gates + artifact indexes
for each edge:  re-evaluate status from DURABLE source facts (pure, idempotent)
for each node:  recompute waitingOn + status projection
for each node whose ALL required inbound edges are satisfied AND not gate-required:
   compute a NODE-LEVEL unlock plan from all inbound satisfied edges (deterministic order)
   execute via existing services (default: backlog.enqueue(backlogItemId))
   record node-level ActionKey in the idempotency ledger
persist graph + ledger atomically; broadcast graph update
detect cycles at activate; an edge added to an active graph that introduces a cycle → needs-attention
```

**Node-level unlock plan (consensus log D5).** Multiple inbound edges may satisfy together with
possibly conflicting actions. The scheduler does **not** fire the satisfying edge's action in
isolation; it computes one deterministic node-level plan: if any required satisfied edge carries
`rebase-onto`, the rebase runs first (idempotently), then a single `enqueue`. `mark-ready` edges
gate without enqueuing. Exactly one enqueue per node-readiness transition.

**Idempotency ledger.** Every node-level unlock records
`ActionKey = ${graphId}:${nodeId}:${actionKind}:${readinessVersion}` with
`startedAt/completedAt/result`. `readinessVersion` is a deterministic hash of the graph version,
the node id, satisfied required inbound edge ids, and the computed node-level action plan. It is
not a single `edgeId`, because multiple inbound edges may satisfy together while still producing
exactly one enqueue. If the gateway crashes after `backlog.enqueue` returns but before the graph
persists, the next tick reconciles by `workGraphId+workNodeId` (the additive linkage fields): it
finds the existing queue/run and marks the action complete instead of double-enqueuing.
Conditions are idempotent for _reading_; the ledger covers the _write_ side.

**Concurrency rules:**

- One active root run per production-lane node. Multiple attempts allowed, but one active
  attempt unless the lane is explicitly `comparison`.
- The scheduler may enqueue many ready nodes, but **never bypasses** the existing dispatch
  queue, slot scoring, or eval slot caps (D14). Parallel graph fan-out is throttled the same
  way as flat backlog/queue dispatch — the graph only decides _which_ items become eligible
  to enqueue, not _how many slots_ they may claim.
- A required failed upstream blocks dependents until retried, replaced, waived, or skipped.

---

## 6. Integration with backlog / queue / family / ci-watch / gates / bundles

| Existing primitive             | Graph reuse                                                                                           | New glue                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Backlog (PR #95)**           | `WorkNode.backlogItemId` 1:1; `unlock` calls `backlog.enqueue`; all dispatch config lives on the item | `workGraphId`+`workNodeId` back-ref                                                      |
| **Dispatch queue**             | unchanged — graph enqueues, queue dispatches/throttles                                                | `workGraphId`+`workNodeId` on `QueueItem` for reconcile                                  |
| **Family (ADR-024)**           | graph reads current family terminal state; never writes family fields or `parentRunId`                | resolve `currentFamilyId`+`currentRootRunId` onto node once first run dispatches         |
| **ci-watch chain**             | intra-family auto `pr-complete`/`merge-main` stays exactly as-is                                      | ci-watch _also_ emits `pr.merged`(+SHA)/`family.terminal` graph events                   |
| **Publication gate (ADR-038)** | `gated` node status mirrors the gate-held run                                                         | `gate.resolved` emits a graph event; downstream `merged` edges wait for the actual merge |
| **Bundles (ADR-039)**          | `artifact` edge condition resolves against a run bundle path                                          | bundle path lookup in the edge evaluator; bundles are evidence, never the graph store    |
| **Webhooks (v2)**              | low-latency `pr.merged`/gate facts                                                                    | GitHub webhook receiver; reconciliation stays authoritative                              |

### Backlog auto-dispatch exclusivity (D13)

PR #95 backlog items may set `autoDispatch: true` and are picked up by
`backlog.autoDispatchTick` independently of any graph. **Graph-linked backlog items must not
double-enqueue.**

Rules:

1. When a backlog item is attached to a non-terminal work graph node (`workGraphId` +
   `workNodeId` set), the **graph scheduler is the sole enqueue authority** for that item.
   This includes `planning`, `active`, `paused`, `waiting`, and `needs-attention`: paused means
   no new enqueues, and waiting/needs-attention must not be bypassed by the operator UI.
2. `backlog.autoDispatchTick` **skips** items with `workGraphId` set unless the parent graph
   is `archived`/`failed`/`done` and the item was explicitly detached.
3. `backlog.enqueue` from the operator UI on a graph-linked item while the graph is non-terminal
   is rejected with a clear error — same as today's guard against duplicate handoff; the graph
   path owns readiness.
4. Standalone backlog items (no `workGraphId`) keep today's flat auto-dispatch behaviour.

This prevents races between the graph scheduler and the flat backlog tick from creating
duplicate queue items or runs for the same objective.

### Eval slot caps (D14)

Shared dispatch queue / eval slot caps (PR #86) apply unchanged. The graph scheduler calls
`backlog.enqueue`; `tryDispatchNext` and eval-matrix caps decide when items actually claim
slots. A graph with ten ready nodes may enqueue ten items, but only `N` may run concurrently
per project eval cap — same as today. The graph does not add a parallel slot-allocation path.

### Comparison-lane nodes (D15)

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

**`rebase-onto` (stacked PRs) — the one place the graph triggers a flow, not just an enqueue.**
When edge `A ──merged──▶ B` fires and B's PR already exists, the scheduler dispatches
`merge-main`/`pr-complete` on **B's existing family** to rebase onto the newly-merged main —
reusing **`buildCIWatchChainedRunParams`'s exact mechanism** (the same path ci-watch already
uses intra-family). The graph only supplies the trigger ci-watch would otherwise supply, so
there is still exactly one run-creation path. The downstream node records `baseRef` /
`upstreamBaseNodeIds` / rebase run ID / before+after SHAs as evidence, since ADR-024 branch
naming is per-family and cross-family base relationships aren't recorded anywhere today. The
upstream merge **never** becomes `parentRunId` of the downstream run.

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

**v1 — deterministic, operator-authored over dispatchable backlog items:**

ADR-041 is the roadmap/product-planning layer. Rough or refined roadmap items do not enter a
work graph directly. The normal layered path is:

```text
RoadmapItem(stage=refined) -> promote -> BacklogItem(s) -> optional WorkGraph -> dispatch
```

Direct PR #95 backlog intake remains supported only for items that are already dispatchable.
External themes or milestones that still need product discovery should import to roadmap first,
not directly to backlog or work graph.

Execution steps:

```
1. Operator creates, imports, or receives roadmap-promoted dispatchable backlog items
2. workGraph.create({ project, title, source, roadmapItemIds?, roadmapEpicId?, roadmapSnapshotHash? }) → status 'planning'
3. workGraph.addNode({ graphId, backlogItemId })   ×N    (wrap existing items)
4. workGraph.addEdge({ from, to, condition, required, unlock }) ×M
5. Gateway validates: acyclic, project match, required fields, branch topology (if rebase edges)
6. workGraph.activate(graphId)  → cycle check → scheduler takes over
7. Scheduler marks dependency-free nodes ready, enqueues them; queue creates root runs
8. Family / run / PR / gate / artifact events unlock downstream nodes
9. Graph 'done' when every required node is succeeded, skipped-by-policy, or explicitly waived
```

Methods (v1): `workGraph.create / get / list / addNode / addEdge / updateNode / activate /
pause / gateResolve / schedulerTick`.

`source: 'external-import'` in v1 only **records provenance + bulk-creates nodes** from
external children that are already dispatchable (one node per Jira subtask / milestone issue →
one backlog item). It does **not** infer edges — edges are operator-authored in v1. Rough
external themes import through ADR-041 roadmap first.

**Deferred:**

- Auto-edge inference (Jira "blocks" links, GitHub task-list refs) — v2.
- LLM decomposition of a prose roadmap item into nodes+edges — v3, always gated behind a
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

**Retry vs replace (consensus log D7).** Retry re-enqueues the **same node's** backlog item and
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

**Partial completion / revert.** If an upstream PR is reverted after merge, ci-watch emits an
"unmerged" signal → the edge satisfied-bit flips back to `pending` → downstream nodes that were
`ready`/`queued` but **not yet `running`** revert to `waiting`. Already-`running` downstream
nodes are **not** clawed back (can't un-dispatch a worker) — they're flagged for operator review.
Honest boundary: the graph prevents premature _starts_; it can't undo _in-flight_ work.

**Cycle handling.** Cycles are rejected at `activate` (DFS, reject with the offending edge set →
graph `failed`). A cycle introduced by editing an active graph is an **authoring error, not an
execution failure**: graph → `needs-attention`, dispatch nothing until fixed (consensus log D3).

**Gateway restart.** No durable scheduler state needed beyond graph/node/edge records + the
action ledger. The first tick after boot recomputes every satisfied-bit and node status from
runs + **durable** PR state (merge SHA / closed+merged), and the ledger + back-refs prevent
re-running an unlock that already enqueued. This is why conditions must be idempotently evaluable
from external state rather than from consumed events; `manual` edges persist their resolution.

---

## 10. Phased rollout

- **v0 (this doc).** ADR-040 Proposed — vocabulary, entity model, and review signoffs promoted
  to `docs/adr/040-work-graph-orchestration.md` (2026-06-27). No implementation code.

- **v1 — execution engine + stacked-PR proof, operator-authored graphs.**
  The brief requires v1 to prove **stacked-PR rebase-unlock AND parallel fan-out**
  (hard constraint), so `rebase-onto` is **in v1**, scoped to the operator-authored stacked-PR
  proof case (consensus log D6). Ships:
  - `work-graph.ts` contracts; gateway store (`services/gateway/src/work-graph/store.ts`,
    `.work-graphs/{id}.json`, same pattern as backlog) + action ledger.
  - `workGraph.create/get/list/addNode/addEdge/updateNode/activate/pause/gateResolve` +
    `schedulerTick`.
  - Scheduler with **per-graph lease** + **idempotency ledger**, reacting to `family.terminal`,
    `pr.merged`, and `scheduler.tick`.
  - Conditions: `family-done`, `merged` (durable), `manual`. Unlock: `enqueue` + `rebase-onto`
    (via `buildCIWatchChainedRunParams`) + `mark-ready`.
  - `baseRef`/`upstreamBaseNodeIds` + rebase evidence for the stacked case.
  - Additive `workGraphId`/`workNodeId` back-refs on backlog/queue/run.
  - **Read-only Command Center surface**: graph list, node statuses, waiting reasons, linked
    runs (DAG render optional).
  - **Proves:** parallel fan-out across runners + stacked-PR auto-rebase-unlock with
    hand-authored edges. Validation: restart reconciliation, no duplicate enqueue, no
    `RunStatus.blocked` for uncreated downstream work.

  > If during v1 build the rebase path proves riskier than the basic scheduler warrants, it may
  > be split to a **v1.5** milestone — but the ADR's headline v1 goal is the stacked-PR proof,
  > so it is planned _into_ v1, not deferred by default.

- **v2 — intake + UI editing.** Jira/GitHub bulk source import with auto-edge
  inference from native dependency links; graph editor in Command Center; full DAG
  visualization; GitHub webhooks for low-latency `pr.merged`; `artifact`/bundle edge conditions;
  operator actions for retry/replace/waive/skip.

- **v3 — LLM decomposition + advanced orchestration.** Prose roadmap item → proposed graph
  (human-reviewed before activate); cross-project graphs; critical-path scheduling; priority
  inheritance; analytics; portable cross-gateway graph execution.

**Roadmap relationship (ADR-041).** WorkGraph is an executable dependency DAG over already-created
BacklogItems. A RoadmapEpic is a planning grouping and is never stored as a WorkGraph. Roadmap
promotion may draft a graph plan as non-canonical markdown/frontmatter, but the first canonical
graph write is `workGraph.create(...)` into `.work-graphs/{id}.json` with `status=planning`.
After that graph exists, roadmap stores only links and promotion snapshots; it must not maintain
a second edge list. Graph records carry `roadmapItemIds`, optional `roadmapEpicId`,
`roadmapSnapshotHash`, and `promotionEntryId` so scheduler/progress queries do not need to parse
mutable roadmap markdown.

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
- **No scheduler-forged runs** — unlock is `enqueue` / `mark-ready` / `rebase-onto` (the last via
  ci-watch's mechanism). ADR-013 stays the only execution path.
- **No fat node config** — dispatch policy (flow/lane/model/slots/priority) lives on the backlog
  item, never duplicated onto the node.
- **No `WorkNodeAttempt[]` array on the node** — attempt history derives from family/run queries.
- **No LLM graph decomposition** — v3, always human-reviewed before activate.
- **No graph editing UI** — read-only in v1 after creation; editor in v2. Activation
  approval is the explicit `planning -> active` transition in `workGraph.activate`, not a
  separate run gate.
- **No auto-edge inference** from Jira/GitHub links — v2.
- **No cross-project graphs** — single-project in v1 (slot pools, default branches, project hooks
  are per-project).
- **No clawing back in-flight downstream runs** on upstream revert — flagged for operator.
- **No new human-gate machinery** — reuse ADR-038 / ADR-023 / recipe gates + the one `manual` edge.
- **No holding slots for graph dependencies** — `waiting` nodes hold _nothing_; no run exists.
- **No experiments in the graph** — ADR-030 stays orthogonal; comparison work uses ADR-024
  comparison lane on the node's backlog/run path, not graph-internal fan-out (D15).
- **No portable-bundle contents in graph state** — bundles are edge evidence, not the store.
- **No bypassing backlog auto-dispatch guards** — graph-linked items are scheduler-only (D13).
- **No bypassing eval slot caps or queue throttling** — graph enqueues; queue dispatches (D14).

---

## 13. Consensus log

Disputed points across the two proposals/reviews and the agreed resolution. Both models had
**converged** on the load-bearing decisions (horizontal/vertical split, thin node pointer, new
gateway store, readiness-oracle scheduler, durable `merged` evidence, lease + ledger,
`needs-attention`, no LLM in v1) before this reconciliation. The remaining disputes:

| #   | Disputed point                            | Proposal A                                           | Proposal B                                                                      | **Resolution**                                                                                                            | Rationale                                                                                                                                                                                   |
| --- | ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Node fatness                              | thin pointer (`backlogItemId` + edges + lazy family) | fat node (`flowType`/`priority`/`allowedSlots`/`dispatchPolicy`/`objectiveRef`) | **Thin pointer.** All dispatch config on the backlog item.                                                                | One source of truth; avoids the "overload one model" anti-pattern the alternative proposal warned against. The thin-pointer model won in review.                                            |
| D2  | Node terminal naming                      | node `done` on family-success                        | `succeeded`, UI shows merge-edge pending                                        | **`succeeded` + edge pending shown separately; UI never renders bare "done."**                                            | Same semantics; the clearer wording prevents operators reading "done" as "merged."                                                                                                          |
| D3  | Cycle after edit                          | hard `failed`                                        | `needs-attention`                                                               | **`needs-attention`.**                                                                                                    | A post-activate edit cycle is an authoring error, not an execution failure. The stricter failure-state proposal won in review.                                                              |
| D4  | Unlock cardinality                        | one `unlock` per edge                                | `UnlockAction[]` array                                                          | **One unlock per edge in v1.**                                                                                            | Array + ledger is more machinery than v1 needs; revisit only if a real two-side-effect case appears.                                                                                        |
| D5  | Unlock dispatch                           | fire the satisfying edge's action                    | node-level action plan from all inbound edges                                   | **Node-level deterministic plan.**                                                                                        | Multiple inbound edges can satisfy together; per-edge firing risks conflicting/duplicate actions. Adopt the node-level plan.                                                                |
| D6  | `rebase-onto` timing                      | v1 (highest-value feature)                           | v1.5 (highest branch-topology risk)                                             | **v1**, scoped to the operator-authored stacked-PR proof; may split to v1.5 only if build risk demands.                   | BRIEF hard constraint: v1 must prove **stacked-PR rebase-unlock + parallel fan-out**. The headline goal can't be deferred. Both allowed "v1 if stacked PR is the first proof case" — it is. |
| D7  | Retry semantics                           | "new family member or fresh family per lane rules"   | attempts stay attached to same node                                             | **Retry re-enqueues the same node, attached to the same node, per its lane rules; replace is an explicit operator edit.** | Prevents silent new-family/new-objective drift. Adopt the same-node framing while deferring lane-rule details.                                                                              |
| D8  | Run linkage                               | initially "no Run fields"                            | additive `workGraphId`/`workNodeId` on Run/QueueItem                            | **Additive back-refs on BacklogItem + QueueItem + Run.** No `waitingOn` on Run.                                           | Restart reconciliation + UI joins need them; they're observation, not orchestration. Additive observation links are required for restart reconciliation.                                    |
| D9  | `WorkNodeAttempt[]` on node               | derive from family/run                               | persist on node                                                                 | **Derive from family/run; persist only the idempotency ledger.**                                                          | Storing attempts on the node duplicates family/run data and risks drift.                                                                                                                    |
| D10 | Status set size                           | tight (`waiting` only)                               | `planned` + `waiting-upstream` distinction                                      | **Keep both `planned` (authored/inactive) and `waiting` (active dependency wait); add `needs-attention`.**                | The distinction is operationally real; one merged set with the extra status.                                                                                                                |
| D11 | "One new primitive" framing               | only `WorkEdge` is new                               | `WorkGraph`/`WorkNode`/`WorkEdge` all first-class                               | **All three are first-class persisted records.**                                                                          | Operators + scheduler need graph lifecycle, node status, waiting reasons; the edge is the core new _behavior_ but not the only record. Adopt the first-class record model.                  |
| D12 | `merged` evidence                         | "PR merged"                                          | merge SHA / closed+merged, durable                                              | **Durable evidence (merge SHA or GitHub closed+merged), never a transient terminal run.**                                 | Makes restart reconciliation sound. Both agreed; pinned here.                                                                                                                               |
| D13 | Backlog `autoDispatch` vs graph scheduler | (unstated in consensus)                              | (unstated)                                                                      | **Graph-linked items: scheduler-only enqueue while graph is non-terminal; flat auto-dispatch skips them.**                | Operational review — prevents double-enqueue or premature enqueue races with PR #95 `backlog.autoDispatchTick`.                                                                             |
| D14 | Eval slot caps under parallel fan-out     | (implied queue owns throttling)                      | (implied)                                                                       | **Graph never bypasses queue eval caps or slot selection.**                                                               | Operational review — explicit contract for parallel graph fan-out.                                                                                                                          |
| D15 | Comparison-lane nodes in a graph          | (unstated)                                           | (unstated)                                                                      | **Production node = one active root; comparison via ADR-024 lane on backlog/run, not graph-internal fan-out.**            | Operational review — keeps eval methodology out of the DAG scheduler.                                                                                                                       |

---

## 14. Open questions for Arthur

Only genuinely unresolved (architecture calls are made above):

1. **`merged` target ref** — is "merged to the project default branch" the right universal
   condition, or do some objective sets merge to a feature integration branch? (`targetRef` is in the type;
   default behaviour is the only open call.)
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

## 15. Review record

The draft was reconciled from local tmux brainstorm artifacts and independent review passes.
The consensus accepted D1–D12 as written and added operational patches D13–D15 for backlog
auto-dispatch, eval slot caps, and comparison-lane boundaries.

Brainstorm artifacts (local, gitignored): `.omc/adr040-brainstorm/`.

**Promotion:** Arthur requested promotion with operational patches (2026-06-27). ADR status
remains **Proposed** until a ROADMAP-next implementation milestone is approved.
