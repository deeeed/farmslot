# Roadmap refinement + WorkGraph composer v1 implementation spec

Status: approved implementation plan for the ADR-041 roadmap refinement and ADR-040 WorkGraph UI integration slice.
Scope: Command Center roadmap/backlog planning UX, gateway/protocol support, and local markdown-first storage.
Supports: [ROADMAP-next.md](../ROADMAP-next.md), [ADR-040](../adr/040-work-graph-orchestration.md), and [ADR-041](../adr/041-roadmap-refinement-backlog.md).
Lifecycle: keep until the v1 implementation ships, then promote durable details into canonical docs or delete the plan.

## Goal

Implement the first usable planning-to-execution flow:

```text
rough roadmap idea
  -> editable markdown refinement
  -> refined roadmap item
  -> one or more backlog markdown specs
  -> optional planning WorkGraph composer
  -> activate graph or dispatch backlog
```

This completes the practical ADR-041 v1 surface and adds the smallest ADR-040 graph creation UX needed to make WorkGraphs usable without hand-calling gateway methods.

## Product boundaries

- Roadmap owns rough/refined product intent and mutable markdown.
- Backlog owns dispatch-ready implementation specs with acceptance criteria.
- WorkGraph owns execution ordering over backlog specs and reference blockers.
- Runs/families own execution history.
- ADRs remain manual developer artifacts; the UI can mention them in markdown but must not generate ADRs.

## Non-goals

- No Jira/GitHub live sync or auto-edge inference.
- No LLM-created graph activation without human review.
- No editing active graphs in-place.
- No automatic chained rebase execution.
- No tag catalog or second label vocabulary.

## Storage

Add markdown-first roadmap state under the canonical gateway root:

```text
.roadmap/
  inbox/items/YYYY-MM-DD-slug.md
  projects/<project>/items/YYYY-MM-DD-slug.md
```

Each item uses frontmatter:

```yaml
id: ri_<short>
kind: roadmap-item
project: farmslot-farm | global | unassigned
stage: rough | refining | refined | promoted | parked | archived
tags: []
promotion: []
createdAt: 2026-06-29T00:00:00.000Z
updatedAt: 2026-06-29T00:00:00.000Z
```

The markdown body is the source of truth for the human-facing spec. A refined item intended for promotion must include:

- `## Problem`
- `## Proposed Solution`
- `## Non-goals`
- `## Risks`
- `## Dispatch Notes`
- `## Acceptance Criteria`

Gateway writes must be atomic and reject stale writes when the file changed since load.

## Protocol / gateway API

Add roadmap contracts and RPC methods:

- `roadmap.create`
- `roadmap.list`
- `roadmap.get`
- `roadmap.update`
- `roadmap.reload`
- `roadmap.launchRefinement`
- `roadmap.promoteToBacklog`

Rules:

- `roadmap.create` creates a rough item by default.
- `roadmap.update` can edit frontmatter fields and markdown body, but validates stage transitions.
- `roadmap.promoteToBacklog` requires `stage=refined`, concrete project, and an `## Acceptance Criteria` section.
- Promotion can create one or many backlog markdown specs.
- Generated backlog specs copy the relevant markdown/AC text and record lightweight provenance back to the roadmap item.
- Tags use the existing run tag normalization and propagate roadmap -> backlog -> run.

## Refinement runner

`roadmap.launchRefinement` launches/attaches a tmux runner for planning only.

- It does not create a run, queue item, slot claim, or run family.
- It renders the project prompt template:
  - default: `projects/<project>/templates/prompts/roadmap-refinement.md`
  - future: explicit project.json override if needed.
- Template variables include roadmap id, project, stage, file path, tags, selected runner/model, and current markdown.
- The runner edits the markdown file in-place; gateway reload picks up the result.

## Command Center UI

Add a roadmap/backlog-adjacent surface with:

- Roadmap list with project/stage/tag/search filters.
- Quick-add rough idea.
- Markdown editor with frontmatter-derived metadata controls.
- Stage controls with validation feedback.
- Runner/model picker + “Refine in tmux”.
- Promotion preview modal:
  - choose one or multiple backlog specs,
  - edit title/project/tags/acceptance criteria/dispatch notes per spec,
  - create specs without auto-dispatch.
- Promotion links back to created backlog specs.

## Planning WorkGraph composer

After promotion, offer “Create WorkGraph from promoted specs”.

Composer is only for `planning` graphs:

- create graph with title, owner/scope project, tags/source note;
- add backlog nodes from promoted specs or existing backlog items;
- add reference blocker nodes for external Jira/GitHub/manual milestones;
- add/remove edges;
- configure edge:
  - `blocks`: `start | completion`,
  - condition: `family-done | merged | manual | reference-status`,
  - unlock: `enqueue | mark-ready | rebase-onto`;
- validate acyclic graph before activation;
- activate graph explicitly.

Active graphs remain read-only in this PR except existing safe actions such as pause/gate resolve. Editing active graph topology is deferred to a future PR via pause/clone-to-planning or explicit migration rules.

### Follow-up: scheduler/resource overlay

The same visualization should later explain dispatch feasibility without turning transient scheduler state into graph topology. WorkGraph edges stay reserved for durable work dependencies; slot occupancy, queue position, requested runner/model/slot constraints, and active run placement should render as read-only node badges or side-panel blockers such as `queued`, `waiting for slot`, `running on macwork-ff-2`, or `ready once requested slot is free`. Slot/resource blockers must not create persisted graph edges.

## Backlog UI integration

Backlog detail/list should show:

- markdown spec path,
- source roadmap item,
- tags,
- acceptance criteria section presence,
- WorkGraph membership when linked.

Dispatch remains backlog-only. Rough/refining roadmap items must never expose dispatch actions.

## Validation plan

Local checks:

- protocol contract tests for roadmap types/methods;
- gateway roadmap store tests for create/update/reload/stale-write/promote;
- backlog promotion tests for AC requirement and provenance;
- WorkGraph composer tests for planning graph creation, edge validation, activation guard;
- Command Center typecheck/lint/tests.

Browser/CDP flow:

1. Create a rough roadmap item from quick-add.
2. Edit markdown into the required refined sections.
3. Mark refined.
4. Launch refinement tmux prompt and verify rendered prompt context includes roadmap file path and template content.
5. Promote into two backlog specs.
6. Create a planning WorkGraph from those specs plus one reference blocker.
7. Add edges, validate DAG, activate graph.
8. Confirm active graph renders read-only with backlog/reference nodes and waiting reasons.

## Success criteria

- A human can go from rough idea to backlog specs without leaving Command Center.
- A human can compose and activate a WorkGraph for the promoted specs without manual gateway calls.
- Backlog/run dispatch contracts remain unchanged except additive provenance/tags/specPath.
- CI is green and UI has CDP evidence for the end-to-end flow.
