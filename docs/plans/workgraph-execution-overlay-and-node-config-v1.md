# WorkGraph execution overlay and node dispatch config v1

Status: approved full-v1 implementation plan for the ADR-040 WorkGraph execution visibility follow-up after PR #157. External review found no boundary blocker; reviewer concerns are handled as guardrails inside one cohesive PR with no product-scope deferrals.
Scope: one PR covering Command Center active WorkGraph execution overlay, click-node dispatch configuration, dispatch queue context, fleet/slot pending-work visibility, and the gateway/protocol support required to keep those surfaces consistent.
Supports: [ROADMAP-next.md](../ROADMAP-next.md), [ADR-040](../adr/040-work-graph-orchestration.md), [ADR-041](../adr/041-roadmap-refinement-backlog.md), and [roadmap-refinement-graph-composer-v1.md](roadmap-refinement-graph-composer-v1.md).
Lifecycle: implement as a single full-v1 feature PR, then promote durable details into ADR/reference docs after the feature ships.

## Goal

Make active WorkGraphs explain not only _work dependency readiness_ but also _dispatch feasibility_:

```text
WorkGraph node
  -> dependency state from graph edges
  -> backlog spec dispatch config
  -> queue state
  -> run/family state
  -> fleet/slot state
  -> human-readable "why can/can't this start now?"
```

A human should be able to open an active graph, click a backlog node, see whether it is ready, queued, waiting for a specific slot, running, gated, or blocked by dependencies, and configure how that node should run before it is queued.

The inverse view should also exist: on fleet/slot surfaces, a human should see queued or ready graph/backlog work that is waiting for a slot.

## Product boundaries

- **WorkGraph topology** remains durable work ordering: backlog/reference nodes and graph edges only.
- **Backlog item dispatch config** owns dispatchable work preferences: priority, allowed slots, runner/model/effort hints, and auto-dispatch policy. WorkGraph nodes expose/edit that backlog-owned config; they do not create a second config store.
- **Dispatch queue** owns queued execution attempts and queue order.
- **Fleet/slots** own current resource availability and active run placement.
- **Runs/families** own execution history and current run status.
- **Execution overlay** is a derived read-only projection. It must not persist transient slot blockers as graph nodes or edges.

## Existing fields to reuse first

Current protocol already has these fields:

- `BacklogItem.priority`
- `BacklogItem.allowedSlots`
- `BacklogItem.autoDispatch`
- `BacklogItem.workGraphId` / `workNodeId`
- `BacklogItem.queuedQueueItemId`, `runId`, `lastDispatchError`
- `QueueItem.priority`
- `QueueItem.slotId` — interpret only according to existing queue/dispatcher semantics; the overlay must not invent stronger pinning semantics
- `QueueItem.allowedSlots`
- `QueueItem.runner`
- `QueueItem.model`
- `QueueItem.workGraphId` / `workNodeId`
- `Run.workGraphId` / `workNodeId`
- `Run.backlogItemId`, `slotId`, `allowedSlots`, `status`
- `Run.metrics.runner` / `metrics.model` for executed runner/model display, with `SlotStatus.runner` / `model` as live slot fallback
- `SlotStatus.lifecycle`, `phase`, `currentRunId`, `runner`, `model`, `project`

Use these before adding new schema. Full v1 adds the smallest backlog-owned runner/model/effort hint fields needed for click-node configuration and threads them through backlog update, queue handoff, and run creation. Do not create a graph-owned dispatch config unless a real graph-specific override is required.

## User stories

### 1. Node status explains dispatch feasibility

As an operator viewing an active WorkGraph, I can click a backlog node and see:

- graph/dependency status;
- backlog spec status;
- queue item, if queued;
- active run/family, if running;
- dispatch config: priority, allowed/preferred slots, runner/model if configured;
- human-readable blocker reasons.

Examples:

- `Dependency blocked: waiting on wn_core_release to merge.`
- `Ready: all required start edges are satisfied.`
- `Queued: position 3, allowed slots macwork-ff-1, macwork-ff-2.`
- `Waiting for slot: macwork-ff-2 is busy with run abc123.`
- `Running on macwork-ff-2 with codex/gpt-5.5.`
- `Needs attention: allowed slots do not belong to backlog project.`

### 2. Click node to configure dispatch hints

As an operator, I can click a backlog node and edit dispatch hints before it queues/runs:

- priority;
- allowed slots;
- auto-dispatch on/off, when applicable;
- runner/model/effort hints using backlog-owned fields added in this PR.

The editor is part of full v1. It edits the linked `BacklogItem`, not the `WorkNode`, so flat backlog dispatch and graph dispatch remain consistent. It must be disabled or read-only once the node is queued/running unless the queue already supports updating that field safely.

### 3. Fleet/slot surfaces show pending work

As an operator looking at fleet/slot views, I can see when work is waiting on a slot:

- slot card badge: `2 queued / 1 running` or similar for queue/run-backed work first;
- expanded slot detail shows queue items targeting this slot and active graph nodes constrained to it;
- optional graph-ready-but-not-queued items must be clearly labeled `scheduler-ready, not queued`;
- if a slot is busy, the waiting work explains: `will start when this slot frees` only when existing queue semantics actually target that slot;
- if multiple slots are allowed, the UI should not imply a single blocked slot unless all visible candidate slots are unavailable.

### 4. Queue panel aligns with graph/backlog context

As an operator in any queue surface, graph-linked queue items show:

- source WorkGraph and node id/title;
- backlog title/spec link;
- allowed slots and priority;
- current dispatch blocker if all allowed slots are unavailable.

## Derived execution overlay model

Add a pure view-model helper before UI rendering:

```ts
interface WorkGraphExecutionOverlayInput {
  graph: WorkGraphProjection;
  backlogItems: BacklogItem[];
  queueItems: QueueItem[];
  runs: Run[];
  slots: SlotStatus[];
}

interface WorkGraphNodeExecutionView {
  graphId: string;
  nodeId: string;
  kind: WorkNodeKind;
  title: string;
  project: string;
  graphStatus: WorkNodeStatus;
  executionStatus:
    | 'reference'
    | 'dependency-blocked'
    | 'config-blocked'
    | 'ready'
    | 'queued'
    | 'waiting-for-slot'
    | 'dispatching'
    | 'running'
    | 'gated'
    | 'needs-attention'
    | 'succeeded'
    | 'failed'
    | 'skipped';
  summary: string;
  blockers: WorkGraphNodeBlocker[];
  backlogItem?: BacklogItem;
  queueItem?: QueueItem;
  run?: Run;
  visibleCandidateSlots: SlotExecutionView[];
  editableConfig: boolean;
}

interface WorkGraphNodeBlocker {
  kind:
    | 'dependency'
    | 'backlog-status'
    | 'config'
    | 'queue'
    | 'slot-busy'
    | 'slot-unavailable'
    | 'run'
    | 'reference'
    | 'policy';
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  slotId?: string;
  queueItemId?: string;
  runId?: string;
}
```

The helper should be deterministic and heavily unit-tested. UI components should consume this projection instead of duplicating queue/run/slot matching logic. It is explanatory, not authoritative scheduler parity: exact dispatch selection still belongs to gateway queue/dispatch code (`findBestSlot`, affinity scoring, slot identity policy, branch/PR affinity, allowed-slot filtering, and ready/held semantics). Use labels such as `visible candidate slots`, not `will dispatch here`, unless the helper reuses authoritative gateway logic.

### Status derivation rules

Order matters:

1. Reference nodes are non-dispatchable; show reference status and blockers only.
2. `needs-attention` wins over queue/slot hints.
3. Terminal graph node states (`succeeded`, `failed`, `skipped`) usually win, but a terminal node with a live queue item or non-terminal run is a consistency warning/attention state, not silently hidden.
4. Active run linked by `workGraphId/workNodeId`, `backlogItemId`, or backlog `runId` drives execution status: `blocked`/human-gating maps to `gated`, terminal statuses map to succeeded/failed, and preparing/dispatching/working statuses map to running-ish labels.
5. Queue item linked by `workGraphId/workNodeId` or backlog `queuedQueueItemId` => `queued` or explanatory `waiting-for-slot`. Current `dispatch.queue.list` may not expose `dispatching` items, so dispatching should be inferred from run/slot state unless gateway later exposes it.
6. Graph `waiting` with `waitingOn` reasons => `dependency-blocked`.
7. Backlog not `ready` => `backlog-status` blocker.
8. Backlog ready + no blockers => `ready`.

### Slot/resource derivation rules

- `allowedSlots` absent/null means any dispatchable slot for the backlog project can be considered.
- `allowedSlots=[]` should never persist; if observed, show `config-blocked`.
- If allowed slots exist and none are visibly ready/dispatchable, show `waiting-for-slot` with per-slot reasons, but phrase this as an overlay explanation rather than dispatcher certainty.
- If at least one allowed slot is visibly ready, do not show a blocking slot reason; show visible candidate slots.
- If a queue item has `slotId`, explain that slot first, but keep copy aligned with existing dispatch semantics (preferred/pinned as implemented today).
- Held slots, branch affinity, PR reuse/nudge eligibility, and stale branch penalties are dispatcher-owned; v1 overlay may surface warnings but must not reimplement all scoring as authority.
- Do not create graph edges from slots to nodes.

## Dispatch config storage decision

### v1 default: backlog-owned config

For backlog nodes, save editable execution config on the linked `BacklogItem`:

- existing: `priority`, `allowedSlots`, `autoDispatch`;
- new in this PR: optional `runner`, `model`, and `effort` hints.

Reason: ADR-040 says all dispatch config lives on the backlog item. It keeps direct backlog dispatch and graph dispatch consistent. This PR includes the required server-side validation and queue/run handoff so backlog update, graph-owned enqueue, and flat backlog enqueue all use the same config source.

### Out of scope: graph-specific overrides

Do not add `WorkNode.dispatchOverride`. Current invariant is one attached non-archived WorkNode per backlog item, so graph-specific overrides would create a second source of truth without solving a current product need.

## Protocol / gateway changes

Full v1 includes the gateway/protocol support needed for node config and consistent overlay display:

1. Extend backlog contracts with optional execution hints:
   - `runner?: string | null`
   - `model?: string | null`
   - `effort?: string | null`
2. Extend `BacklogCreateInput` / `BacklogUpdateInput` and store normalization/persistence for those fields.
3. Validate hints server-side enough to prevent invalid shapes and stale UI-only options:
   - trim strings;
   - null clears the field;
   - reject empty strings;
   - if runner definitions expose allowed runner/model/effort combinations, validate against that registry;
   - otherwise accept strings but keep validation centralized in gateway, not component-local.
4. Thread backlog hints into graph-owned and flat backlog enqueue so resulting `QueueItem.runner`, `model`, and `effort` match the saved backlog config.
5. Keep `QueueItem.slotId` and `allowedSlots` semantics unchanged; overlay copy must mirror existing dispatch behavior, not redefine it.
6. Add no WorkGraph write methods for execution config. WorkGraph remains topology/status only.
7. Keep the execution overlay as a UI-side pure helper for v1, but design its types so gateway/Companion can reuse the same shape later if needed.

## Command Center UI changes

### WorkGraph panel

- Use `WorkGraphNodeExecutionView` for node badge, color, subtitle, and detail panel.
- Clicking a node opens a side/detail panel with:
  - overview: dependency status, queue/run/slot status;
  - blockers list;
  - editable dispatch config controls for backlog nodes;
  - links to backlog spec, queue item, run/family, and slot.
- Active topology remains read-only.
- Planning topology editor remains separate from active execution overlay.

### Node dispatch config editor

- Ship in the same PR as the overlay.
- Reuse backlog update RPC.
- Reuse existing slot picker patterns from backlog/queue/dispatch surfaces.
- Scope slot choices by `BacklogItem.project`, not `WorkGraph.project`, because graphs are cross-project.
- Validate before save:
  - allowed slots belong to project;
  - empty selection means unrestricted, not `[]`;
  - runner/model/effort values are validated or normalized by gateway;
  - queued/running nodes disable unsafe fields unless queue update semantics already support them.

### Fleet / slot cards

- Ship in the same PR as the overlay.
- Add a compact pending-work badge to slot cards:
  - queued items pinned/allowed to this slot;
  - active run graph node, if current run has graph linkage;
  - optionally graph-ready nodes, but only with `scheduler-ready, not queued` labeling.
- Expanded slot view can list the pending items with graph/backlog titles.
- Do not overload slot lifecycle. These are overlays, not slot state transitions.

### Dispatch queue panel

- Ship in the same PR as the overlay.
- For graph-linked queue items, show graph/node metadata and allowed slot text.
- Show `waiting for allowed slot(s)` if no allowed slot is currently visibly ready, with copy that remains explanatory rather than authoritative dispatcher parity.

## Non-goals

- No automatic topology changes.
- No slot nodes or slot edges in persisted WorkGraphs.
- No graph scheduler bypass of dispatch queue.
- No runner/model override stored on WorkNode in v1; runner/model/effort hints are backlog-owned.
- No advanced capacity planning, time estimates, or multi-runner comparison graph fan-out.
- No editing active graph topology.

## Single-PR implementation milestones

This is one product PR. Internally, implement in this order to keep reviewable checkpoints while shipping the full scope together:

### Milestone 1 — pure execution overlay model

- Add `work-graph-execution-overlay` helper and tests.
- Join WorkGraph, backlog, queue, run, and slot state into `WorkGraphNodeExecutionView`.
- Keep it explanatory, not an authoritative replacement for dispatch scoring.

### Milestone 2 — WorkGraph panel overlay + node detail

- WorkGraph panel consumes derived node status/details.
- Clicking a node shows blockers, queue/run/slot links, and dispatch config.
- Active topology remains read-only.

### Milestone 3 — backlog-owned node dispatch config

- Add optional backlog execution hint fields for runner/model/effort.
- Reuse `backlog.update` from the node detail editor.
- Edit priority, allowed slots, autoDispatch, runner, model, effort before queue/run start.
- Propagate backlog hints into queue items for both graph-owned and flat backlog enqueue.

### Milestone 4 — queue and fleet/slot visibility

- Queue panel shows graph/backlog context and slot blockers for graph-linked queue items.
- Slot cards/expanded slot detail show queued/running graph/backlog work.
- Optional graph-ready items are visually separate as scheduler-ready/not queued.

### Milestone 5 — CDP full-flow validation

- Seed/create a graph with dependency-blocked, queued waiting-for-slot, running, and ready nodes.
- Validate WorkGraph details, node config save, queue context, and fleet pending badges in browser.

## Validation plan

### Unit tests

- Overlay helper:
  - dependency-blocked node with `waitingOn`;
  - ready node with no queue/run;
  - queued node with unrestricted slots and at least one visibly ready slot;
  - queued node with all allowed slots busy/manual/disabled => explanatory `waiting-for-slot`;
  - queued node with a `slotId` busy => slot-specific explanation first, without overstating pin semantics;
  - running node resolves linked run/slot;
  - `Run.metrics.runner/model` display falls back to `SlotStatus.runner/model`;
  - dispatching/preparing inferred from run/slot state because queue list may only expose queued items;
  - reference node never dispatchable;
  - missing backlog item => `config-blocked` or `needs-attention` display;
  - `allowedSlots=[]` observed from bad state displays invalid/config-blocked, while update APIs still avoid persisting it;
  - unknown/invalid allowed slot and wrong-project allowed slot explanations;
  - terminal graph node with live queue/non-terminal run surfaces a consistency warning;
  - cross-project graph uses `BacklogItem.project` for slot/config explanation, not `WorkGraph.project`;
  - held-slot PR affinity is labeled as informational unless authoritative dispatch logic is reused.
- Backlog config editor tests:
  - runner/model/effort hints persist through backlog create/update/reload;
  - backlog hints propagate into queue item on graph-owned and flat enqueue;
  - queued/running node config is read-only or safely rejected;
  - updating backlog config after a queue item exists does not silently mutate the existing queue item.
- Slot pending-work selector tests:
  - counts queue items allowed to a slot;
  - does not mark a slot blocked when another allowed slot is ready;
  - maps current run graph linkage to active graph node.

### Browser/CDP validation

Seed or create a scenario with:

1. active WorkGraph with at least three backlog nodes and one reference blocker;
2. one node dependency-blocked;
3. one node queued with allowed slot busy;
4. one node running on a slot;
5. one ready node with multiple visible candidate slots;
6. one cross-project node whose backlog project differs from graph owner project.

Validate via CDP:

- WorkGraph badges and node detail explanations render correctly;
- WorkGraph details explain node dependency/queue/run/slot state;
- node config editor updates backlog allowed slots/priority/runner/model/effort and recomputes overlay;
- queue panel shows graph-linked context;
- fleet slot card shows pending/running graph work;
- no persisted WorkGraph edges/nodes are created for slot blockers.

### Quality gates

- `yarn --cwd apps/command-center typecheck`
- `yarn --cwd apps/command-center format:check`
- `yarn --cwd apps/command-center lint:type-escapes && yarn --cwd apps/command-center lint`
- gateway/protocol tests touched by backlog fields or queue handoff
- `git diff --check`

## Open questions for implementation review

1. Which gateway runner/model registry helper should validate backlog runner/model/effort hints so UI options cannot drift from backend support?
2. Should `QueueItem.slotId` be described as hard-pinned or preferred in each UI surface? Existing queue semantics decide; this PR should document the wording it chooses.
3. Should fleet slot cards show ready-but-not-queued graph nodes, or only queue/run-backed work? If shown, the label must remain `scheduler-ready, not queued`.
4. Should the UI-side overlay helper be promoted to a shared package or gateway method after this full v1 ships and Companion wants the same projection?
