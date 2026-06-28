# ADR-041: Operator Roadmap Idea Refinement Layer

**Status:** Proposed
**Date:** 2026-06-28
**Relates to:** [ADR-005](005-state-persistence.md), [ADR-011](011-structured-task-tracking.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-027](027-unified-gateway-state.md), [ADR-039](039-run-portable-bundles.md), [ADR-040](040-work-graph-orchestration.md), PR #95 backlog intake

## Context

Farmslot now has three execution-side primitives:

1. **Runs and run families** — the vertical lifecycle for one objective, from dispatch through review, CI, gates, and publication.
2. **Backlog items** — dispatchable intake records that can be queued into the existing dispatch path.
3. **Work graphs** — proposed horizontal dependency orchestration over backlog items.

What is missing is the planning layer **before** backlog intake. Operators often start with rough ideas: a product goal, an implementation hunch, a private note in `~/dev/roadmap`, or a raw prompt. That rough idea is not a backlog item yet. It must stay in roadmap space until it becomes a deployable, dispatchable spec with acceptance criteria.

The desired product direction is embedded project management:

```text
roadmap item (rough idea)
  -> interactive refinement
  -> roadmap item (refined spec)
  -> promote -> backlog item(s)
             -> optional work graph
             -> dispatch -> runs/bundles
```

This ADR defines the durable boundary for that planning layer. It intentionally does **not** implement a full project-management suite. The scope is capture, refine, organize, promote, and track.

## Decision

Add a gateway-owned **operator roadmap layer** with markdown-backed roadmap items, epics, refinement sessions, and a shared label catalog. This is distinct from canonical product docs (`docs/ROADMAP.md` / `docs/ROADMAP-next.md`) and from Arthur's personal `~/dev/roadmap` notebook.

The load-bearing distinction:

- **RoadmapItem** can be rough, refining, refined, or promoted. It owns discovery, product intent, acceptance criteria, and human-editable markdown.
- **BacklogItem** starts only after promotion. It represents one clear executable objective, like a Jira ticket ready to dispatch. A single refined roadmap item may decompose into many backlog items.

The roadmap layer sits above backlog and work graphs:

```text
RoadmapItem(stage=rough)
  -> RefinementSession
  -> RoadmapItem(stage=refined, acceptance criteria present)
  -> RoadmapEpic membership
  -> promote -> BacklogItem(s)
             -> optional WorkGraph draft
             -> DispatchQueue -> RunFamily -> RunBundle evidence
```

Core rules:

1. **Roadmap is planning state.** It captures rough ideas, refined specs, acceptance criteria, tradeoffs, and product grouping.
2. **Backlog is execution intake.** A backlog item remains one dispatchable objective and should already read like a deployable Jira ticket. Large roadmap items fan out into multiple backlog items instead of becoming one overloaded backlog item.
3. **WorkGraph is scheduling state.** It encodes dependency edges between backlog items; it is not the same as an epic.
4. **RunFamily is execution lineage.** Refinement sessions do not become run families and do not enter dispatch queues.
5. **RunBundle is evidence transport.** Bundles may reference roadmap/backlog provenance but do not own roadmap state.
6. **Labels are shared.** Roadmap items, backlog items, work graphs, run families, and runs use one operator-facing label vocabulary.

## Entities

### RoadmapItem

A markdown-backed planning item that spans rough idea through refined spec. The item is the unit the user sees in roadmap. Its stage changes as it matures; it is not copied from an “idea” record into a separate “spec” record.

Required fields:

- `id`: stable `ri_<short>` identifier.
- `project`: Farmslot `project.json` `name` value, or `global` / `unassigned`.
- `title`.
- `stage`: `rough | refining | refined | promoted | parked | archived`.
- `labelKeys`: optional shared label keys.
- `epicId`: optional roadmap epic membership.
- `source`: `manual | import | agent | external` plus optional path/ref. `source` records capture origin only: `agent` means an agent proposed or captured the initial item. Later agent-led refinement is recorded only in `RefinementSession`.
- `acceptanceCriteria`: required before promotion; optional while rough.
- `promotion`: ledger entries for created backlog items/work graphs, each with timestamp, operator decision, roadmap revision, and snapshot hash.
- `createdAt`, `updatedAt`.
- `body`: human-authored markdown.

Stage semantics:

| Stage      | Meaning                                                                         | Allowed next step                                 |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `rough`    | Raw thought, unclear scope, may be only a paragraph.                            | refine, park, archive                             |
| `refining` | Interactive runner or human refinement in progress.                             | refined, rough, parked                            |
| `refined`  | Spec has problem, proposed solution, non-goals, risks, and acceptance criteria. | promote, edit, park                               |
| `promoted` | One or more backlog items/work graphs were created.                             | track, create additional backlog items explicitly |
| `parked`   | Worth keeping but not active.                                                   | rough/refining/refined                            |
| `archived` | No longer considered.                                                           | restore only by explicit operator action          |

A `RoadmapItem(stage=refined)` behaves like a Jira ticket draft: humans and agents can edit the markdown directly. Because the item stays mutable after promotion, every promotion entry stores an immutable snapshot path/hash of the markdown and acceptance-criteria slice used to create downstream backlog/work-graph records.

### RefinementSession

A record of an interactive refinement attempt for one roadmap item. It is an orchestration/session record, not an execution run.

Required fields:

- `id`: stable `rs_<short>` identifier.
- `roadmapItemId`.
- `runner`: runner kind/model/session/pane metadata.
- `template`: project-specific refinement prompt/template version.
- `status`: `active | completed | abandoned | failed`.
- `transcriptPath`: JSONL transcript or structured event log.
- `createdAt`, `completedAt`.

Refinement sessions may reuse tmux runner infrastructure, but they do not call `run.create`, do not allocate a slot, and do not affect run-family metrics. This is the explicit carve-out from the execution rule that dispatchable agent work creates Runs: refinement edits planning markdown, not deployable code. Only one `active` refinement session may own a roadmap item at a time; additional sessions must attach to it or wait until it completes/abandons.

### RoadmapEpic

A product/planning grouping of roadmap items.

Required fields:

- `id`: stable `re_<short>` identifier.
- `project`.
- `title`.
- `status`: `draft | active | done | parked | archived`.
- `labelKeys`: optional shared label keys.
- `items`: derived from `RoadmapItem.epicId`; the epic file may cache ordering metadata, but item frontmatter is the canonical membership source.
- `promotion`: optional ledger entries using the same snapshot/idempotency shape as `RoadmapItem.promotion` when the epic itself is promoted to a graph.

An epic is not a work graph. Epic membership answers “these belong together.” WorkGraph edges answer “this cannot execute until that condition is satisfied.”

### BacklogItem boundary

Direct PR #95 backlog intake remains supported for Jira/GitHub/manual items that are already dispatchable. Backlog is deliberately downstream of roadmap for rough/product-discovery work. A rough idea must never become a backlog item. A backlog item should be clear enough for an agent to dispatch without another product-discovery conversation. When one roadmap item requires several deployable changes, promotion creates several backlog items, each with its own objective, structured acceptance-criteria slice, dispatch notes, and snapshot hash back to the roadmap revision that generated it.

Promotion from roadmap to backlog requires:

- `stage=refined`.
- Acceptance criteria present.
- For each generated backlog item: a title, structured `acceptanceCriteria`, `dispatchNotes`, flow/project metadata, and an immutable `roadmapSnapshotHash`.
- Dispatch notes or enough context to generate a worker task.
- Operator confirmation of one objective vs decomposition into multiple backlog items.

### SharedLabel

A single operator label vocabulary shared across product planning and execution.

Required fields:

- `key`: globally unique key. Global labels use `global:<slug>`; project labels use `project:<project>:<slug>`.
- `slug`: normalized short slug, e.g. `mobile`, `demo`, `adr`, `high-risk`, `blocked-on-human`.
- `name`: display label.
- `color`: optional presentation token.
- `description`: optional operator hint.
- `scope`: `global | project`.
- `project`: required only when `scope=project`.
- `visibility`: `normal | hidden | system`. `hidden` suppresses default filter chips without deleting historical attachments; `system` is gateway-managed and not directly editable by users.
- `createdAt`, `updatedAt`.

Records attach labels by `labelKeys`. Some fields exist today and some are proposed by this ADR:

```ts
interface RoadmapItem {
  labelKeys?: string[];
} // proposed
interface RoadmapEpic {
  labelKeys?: string[];
} // proposed
interface BacklogItem {
  labelKeys?: string[];
} // proposed
interface WorkGraph {
  labelKeys?: string[];
} // proposed in ADR-040/041 reconciliation
interface WorkNode {
  labelKeys?: string[];
} // proposed in ADR-040/041 reconciliation
interface Run {
  tags?: string[];
} // existing compatibility alias; values normalize to label keys
```

Run-family label filters are derived projections over member runs/backlog/work graph labels, not a separately owned `RunFamilySummary` label store. Long term, UI should say **Labels**. Existing run `tags` APIs remain as compatibility aliases: an existing plain run tag such as `demo` maps to label key `global:demo` for filtering/display, and new unprefixed run tags are normalized the same way. Project-scoped labels use `project:<project>:<slug>` only on new `labelKeys` fields; they are not written into legacy `Run.tags` until a deliberate migration exists. External ticket labels from GitHub/Jira are provenance metadata; they do not become Farmslot labels unless explicitly imported or mapped. Promotion propagates selected roadmap labels to generated backlog items and draft/active work graph records.

## Storage

Operator-roadmap state is gateway-owned and markdown-first. Files must be sortable and obvious to humans or external agents. The durable home is under the connected gateway's `farmslotRoot`, not `~/.farmslot` machine CLI config.

```text
{farmslotRoot}/.roadmap/
  labels.json
  projects/<project>/
    items/YYYY-MM-DD-short-slug.md
    epics/YYYY-MM-DD-short-slug.md
    sessions/YYYY-MM-DD-short-slug.jsonl
    snapshots/<roadmapItemId>-YYYYMMDDTHHMMSSZ.md
  inbox/items/YYYY-MM-DD-unassigned-short-slug.md
  cross-project/epics/YYYY-MM-DD-short-slug.md
```

A roadmap item keeps the same file as it matures. The stage lives in frontmatter; the markdown body evolves from rough note to refined spec.

```markdown
---
id: ri_abc123
kind: roadmap-item
project: farmslot-farm
stage: refined
labelKeys: [global:roadmap, global:adr, project:farmslot-farm:command-center]
epicId: re_pm_core
acceptanceCriteria:
  - User can refine a raw roadmap item interactively.
  - Refined roadmap item can promote to one or more backlog items.
promotion:
  entries: []
---

# Title

## Problem

...
```

After promotion, snapshots use item id plus UTC timestamp so multiple promotions from the same item sort together, and the gateway appends ledger entries such as:

```yaml
promotion:
  entries:
    - id: pe_abc123
      at: 2026-06-28T12:00:00Z
      decision: create-backlog-items
      roadmapRevision: 3
      snapshotPath: snapshots/ri_abc123-20260628T120000Z.md
      snapshotHash: sha256:...
      backlogItemIds: [bl_1, bl_2]
      workGraphIds: [wg_1]
```

The gateway builds an in-memory index from the files, validates frontmatter on load, and writes atomically with a single-writer lock. Human/external-agent edits are picked up on explicit reload or file-watch invalidation. Gateway writes include the last loaded file hash; if the file changed in an editor, the gateway rejects the write and asks the operator to reload/merge before saving again. Unknown labels remain displayable as raw slugs so human edits do not break the UI.

`~/dev/roadmap` remains a personal/general notebook. Farmslot supports explicit import/export with provenance, but it is not live-synced and is not canonical for Farmslot project execution.

## Lifecycle

### Capture

A user or agent creates a `RoadmapItem(stage=rough)` from quick-add text, pasted markdown, imported `~/dev/roadmap` notes, or external references.

Captured items may be unassigned. They live under `inbox/items/` until assigned to a project.

### Refine

The user launches a `RefinementSession` from a roadmap item. The gateway starts or attaches to a tmux runner with a project-specific refinement template. The runner asks questions and edits the same markdown item until it is ready for `stage=refined`.

The gate to mark refined is explicit: the item must have a problem statement, proposed solution, non-goals, acceptance criteria, risks, and dispatch notes.

### Organize

The user attaches labels and optionally adds the roadmap item to a `RoadmapEpic`. Roadmap UI supports filtering by project, stage, label, and text search. Labels use the same `labelKeys` catalog as run/backlog filters.

### Promote

Promotion is the only write path from roadmap to execution.

A refined roadmap item can promote to:

1. One backlog item for a single deployable objective.
2. Multiple backlog items when the roadmap item spans several deployable objectives.
3. Multiple backlog items plus a draft work graph when those objectives have ordering/dependency constraints.

The decomposition boundary is execution clarity: each generated backlog item should be independently dispatchable, reviewable, and trackable, while preserving provenance back to the parent roadmap item.

Promotion writes provenance both ways:

- Roadmap item promotion ledger records created backlog/work-graph IDs.
- Backlog items record `roadmapItemId`, optional `roadmapEpicId`, inherited `labelKeys`, structured `acceptanceCriteria`, `dispatchNotes`, and `roadmapSnapshotHash`.
- Draft work graph plans inherit selected label keys from the roadmap item/epic. When activated, the canonical ADR-040 WorkGraph and WorkNodes record `roadmapEpicId` / `roadmapItemIds`, inherited `labelKeys`, and the originating promotion snapshot hash.

Promotion is idempotent. Re-promoting an already-promoted item shows the existing ledger and requires an explicit “create additional backlog items” action. The ledger is the durable mapping from one roadmap item revision to N backlog items and optional work graph nodes. Its idempotency key is the roadmap item id, roadmap revision/snapshot hash, operator decision id, and a typed decomposition target id (`backlog:<backlogItemId>` or `graph:<workGraphId>`), so retrying a failed promotion cannot silently duplicate backlog items.

### Track

Roadmap execution rollup is derived from linked backlog/work-graph/run state, but roadmap does not mutate execution records after promotion except through explicit operator actions. Rollup values such as `shipped`, `done`, or `attention-needed` are UI projections, not `stage` enum values.

Derived examples:

- All linked backlog items done -> roadmap item shows `shipped`/`done` projection.
- A linked run failed -> roadmap item shows attention needed via derived rollup.
- Labels changed on a run do not automatically rewrite the originating roadmap item unless the user chooses “sync labels back.”

## Integration boundaries

### Backlog and dispatch

Backlog remains the execution handoff. `backlog.enqueue` remains the path into the dispatch queue. Roadmap promotion creates backlog items; it never calls `run.create` directly.

Backlog item additions:

Roadmap promotion should create backlog items with `sourceKind='roadmap'` and `sourceRef=<promotionEntryId>`; legacy PR #95 sources (`manual`, `jira`, `github`) remain for directly dispatchable intake.

```ts
interface BacklogItem {
  sourceKind: BacklogSourceKind | 'roadmap'; // proposed source kind for promotions
  sourceRef: string; // promotionEntryId for roadmap-promoted items
  roadmapItemId?: string;
  roadmapEpicId?: string;
  roadmapSnapshotHash?: string;
  labelKeys?: string[];
  acceptanceCriteria?: string[];
  dispatchNotes?: string;
}
```

### Work graphs

A roadmap epic or refined roadmap item may draft a work graph plan, but the active graph remains executable scheduling state owned by ADR-040. Roadmap storage does not own canonical graph JSON. Draft graph notes in roadmap markdown/frontmatter are non-canonical scratch. The first canonical graph write is `workGraph.create(...)` into ADR-040 `.work-graphs/{id}.json` with `status=planning`; after that, roadmap stores only the graph id, promotion snapshot, and provenance links. Work nodes point to backlog items, not roadmap items. Roadmap links to the active graph for visualization and progress rollup.

### Runs and run families

Runs keep their existing semantics. The shared label model should converge run `tags` with roadmap/backlog labels, but `familyId` and `parentRunId` remain execution lineage only.

### Run bundles

Run bundles may include roadmap/backlog provenance IDs and labels for context. They do not embed canonical roadmap markdown. If a portable bundle references a roadmap item, it should record the ID/path as provenance and include rendered excerpts only as evidence metadata when needed.

## UI surface

Add a `#roadmap` / backlog-adjacent Command Center surface with four modes:

1. **Inbox:** rough roadmap items, unassigned notes, imported personal roadmap items.
2. **Refine:** selected roadmap item plus tmux runner panel and markdown editor.
3. **Plan:** epics, labels, stage, derived rollup status, sort order, and project filters.
4. **Promote:** decomposition UI that creates backlog items and optionally a work graph draft.

Backlog UI should show roadmap provenance and labels. Run views should reuse the same label filter chips already available for run tags, backed by the shared label catalog.

## Non-goals

- No live sync with Jira, GitHub Projects, or `~/dev/roadmap`.
- No sprint planning, burndown, assignees, estimates, or calendar system.
- No dispatch from rough roadmap items.
- No backlog entries that still need product-discovery refinement.
- No overloaded backlog item representing an entire multi-objective roadmap item.
- No work graph edge semantics beyond ADR-040.
- No hidden conversion of external ticket labels into Farmslot labels.

## Consequences

Positive:

- Rough ideas become durable, sortable roadmap items instead of polluting backlog.
- The same roadmap item can mature from raw thought to refined spec.
- Backlog remains a clean queue of deployable/dispatchable objectives.
- Backlog and runs gain provenance back to product intent.
- Labels become one filter vocabulary across planning and execution.
- ADR-039 bundles and ADR-040 graphs stay cleanly scoped.

Costs and risks:

- Markdown-as-state needs schema validation, atomic writes, and conflict handling.
- Promotion fan-out must be idempotent to avoid duplicate backlog items.
- Label migration must preserve existing run tag APIs while converging the UI language.
- The roadmap surface can easily grow into a full PM tool; the product boundary must stay capture/refine/promote/track.

## Rollout

1. Define protocol contracts and markdown schema for roadmap items and shared labels.
2. Add read-only gateway index over `{farmslotRoot}/.roadmap` files with atomic writes and a single-writer lock for gateway mutations; human edits are picked up by reload/validation rather than live two-way sync.
3. Add capture/edit APIs and label catalog APIs.
4. Add refinement-session launch using tmux runner infrastructure, explicitly outside dispatch.
5. Add promotion to backlog items with structured acceptance criteria, dispatch notes, provenance snapshots, and inherited labels.
6. Add optional work-graph draft integration after ADR-040 v1 contracts are implemented; activation writes canonical graphs to ADR-040 storage, not roadmap storage.
7. Migrate run tag UI/API wording toward shared labels while keeping compatibility aliases.
