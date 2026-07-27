# ADR-041: Operator Roadmap Idea Refinement Layer

**Status:** Proposed
**Date:** 2026-06-28
**Updated:** 2026-07-03 (multi-project refinement/promotion draft attachment amendment)
**Relates to:** [ADR-005](005-state-persistence.md), [ADR-011](011-structured-task-tracking.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-027](027-unified-gateway-state.md), [ADR-039](039-run-portable-bundles.md), [ADR-040](040-work-graph-orchestration.md), PR #95 backlog intake

## Context

Farmslot now has two execution-side primitives:

1. **Runs and run families** — the vertical lifecycle for one objective, from dispatch through review, CI, gates, and publication.
2. **Backlog items** — dispatchable intake records that can be queued into the existing dispatch path.

What is missing is the planning layer **before** backlog intake. Operators often start with rough ideas: a product goal, an implementation hunch, a private note in `~/dev/roadmap`, or a raw prompt. That rough idea is not a backlog item yet. It must stay in roadmap space until it becomes a deployable, dispatchable spec with acceptance criteria.

The desired product direction is embedded project management:

```text
roadmap item (rough idea)
  -> interactive refinement
  -> roadmap item (refined spec)
  -> request promotion -> draft backlog spec attachment(s)
  -> promote -> backlog markdown spec(s)
             -> dispatch -> runs/bundles
```

This ADR defines the durable boundary for that planning layer. It intentionally does **not** implement a full project-management suite. The v1 scope is capture, refine, promote, and track through markdown.

## Decision

Add a gateway-owned **operator roadmap layer** with markdown-backed roadmap items and promotion into backlog markdown specs. This is distinct from canonical product docs (`docs/ROADMAP.md` / `docs/ROADMAP-next.md`) and from Arthur's personal `~/dev/roadmap` notebook.

The load-bearing distinction:

- **RoadmapItem** can be rough, refining, refined, or promoted. It owns discovery, product intent, acceptance criteria, and human-editable markdown.
- **BacklogItem** starts only after promotion. It represents one clear executable objective, like a Jira ticket ready to dispatch. A single refined roadmap item may decompose into many backlog items.

The roadmap layer sits before backlog and may reveal that a manual ADR is needed:

```text
RoadmapItem(stage=rough)
  -> interactive refinement
  -> RoadmapItem(stage=refined)
      ├─ manual developer path -> write/update ADR if needed
      └─ productized path -> backlog markdown spec(s)
                         -> DispatchQueue -> RunFamily -> RunBundle evidence
```

A refined roadmap item chooses the smallest correct next step: if a durable architectural/product decision is needed, the developer manually writes or updates an ADR; if the decision is clear, the item can be promoted to backlog specs.

Core rules:

1. **Roadmap is planning state.** It captures rough ideas, refined specs, acceptance criteria, tradeoffs, and product grouping.
2. **ADR is manual decision capture.** When refinement reveals an architectural/product boundary, the developer manually writes or updates an ADR before implementation specs are created. This is not a roadmap API promotion path in v1.
3. **Backlog is execution intake.** A backlog item remains one dispatchable objective and should already read like a deployable Jira ticket. Large roadmap items fan out into multiple backlog items instead of becoming one overloaded backlog item.
4. **RunFamily is execution lineage.** Refinement activity does not become a run family and does not enter dispatch queues.
5. **Tags are shared.** Roadmap, backlog, and runs use one operator-facing tag vocabulary, reusing the existing `Run.tags` / `normalizeRunTags` protocol contract. No tag catalog is required for v1.
6. **Target projects are explicit.** A roadmap item has one owning/coordinating `project`, but may refine and promote against multiple `targetProjects`. Promotion fan-out must create each backlog item in its target project, not blindly in the owner project.

## Entities

### RoadmapItem

A markdown-backed planning item that spans rough idea through refined spec. The item is the unit the user sees in roadmap. Its stage changes as it matures; it is not copied from an “idea” record into a separate “spec” record.

Required fields:

- `id`: stable `ri_<short>` identifier.
- `project`: owning/coordinating Farmslot `project.json` `name` value, or `global` / `unassigned`. This controls where the roadmap markdown lives and which project refinement defaults apply.
- `targetProjects`: optional list of concrete Farmslot project names that the idea should refine/promote into. This is the implementation fan-out set; it must not include `global` or `unassigned`.
- `title`.
- `stage`: `rough | refining | refined | promoted | parked | archived`.
- `tags`: optional shared normalized tags.
- `source`: `manual | import | agent | external` plus optional path/ref. `source` records capture origin only: `agent` means an agent proposed or captured the initial item. Later agent-led refinement is captured in markdown history/provenance, not a required session schema in v1.
- `body`: markdown content. A refined item should include acceptance criteria when it will promote directly to backlog.
- `promotion`: optional notes/links for created backlog specs.
- `createdAt`, `updatedAt`.

Stage semantics:

| Stage      | Meaning                                                                         | Allowed next step                                 |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `rough`    | Raw thought, unclear scope, may be only a paragraph.                            | refine, park, archive                             |
| `refining` | Interactive runner or human refinement in progress.                             | refined, rough, parked                            |
| `refined`  | Spec has problem, proposed solution, non-goals, risks, and acceptance criteria. | promote, edit, park                               |
| `promoted` | One or more backlog specs were created.                                         | track, create additional backlog specs explicitly |
| `parked`   | Worth keeping but not active.                                                   | rough/refining/refined                            |
| `archived` | No longer considered.                                                           | restore only by explicit operator action          |

A `RoadmapItem(stage=refined)` behaves like a Jira ticket draft: humans and agents can edit the markdown directly. Because the item stays mutable after promotion, downstream backlog specs should copy the relevant implementation text/acceptance criteria into their own markdown instead of depending on live roadmap text.

### Refinement assistance

Refinement is a planning activity over the roadmap markdown file. V1 does not need a separate session database. The gateway may launch or attach a tmux runner with the roadmap file path and a project-specific prompt, but the output remains human-reviewable markdown edits. Refinement does not call `run.create`, allocate a slot, or affect run-family metrics.

### BacklogItem boundary

Direct PR #95 backlog intake remains supported for Jira/GitHub/manual items that are already dispatchable. Backlog is deliberately downstream of roadmap for rough/product-discovery work. A rough idea must never become a backlog item. A backlog item should be clear enough for an agent to dispatch without another product-discovery conversation. When one roadmap item requires several deployable changes, promotion creates several backlog specs, each with its own objective, acceptance criteria section, and dispatch notes.

Promotion from roadmap to backlog requires:

- `stage=refined`.
- Each generated backlog markdown spec has a target project, title, and an `## Acceptance Criteria` section.
- Dispatch notes or enough context to generate a worker task.
- Operator confirmation of one objective vs decomposition into multiple backlog specs.

For single-project items, the target project may default to `RoadmapItem.project` when it is concrete. For cross-client or cross-repo ideas, the operator must select `targetProjects` before refinement or promotion so the prompt can ask for project-specific backlog specs.

### Shared tags

Use the existing run tag contract everywhere: `tags?: string[]`, normalized with `normalizeRunTags`. Roadmap and backlog records may carry tags; dispatch propagates backlog tags onto created runs. Do not introduce `labelKeys`, tag catalogs, scoped tag keys, or a second label vocabulary in v1. External ticket labels from GitHub/Jira remain provenance metadata unless explicitly copied into Farmslot tags by the operator.

## Storage

Operator-roadmap state is gateway-owned and markdown-first. Files must be sortable and obvious to humans or external agents. The durable home is under the connected gateway's `farmslotRoot`, not `~/.farmslot` machine CLI config.

In a multi-gateway/worktree setup, the operator must choose one canonical roadmap plane per project. For Farmslot dogfooding, that is the main operator gateway/root that owns canonical backlog/run history; throwaway worktree gateways may import/export roadmap snapshots for local refinement, but they must not silently promote into their own fragmented backlog unless the operator explicitly chooses that gateway as canonical for the project.

```text
{farmslotRoot}/.roadmap/
  projects/<project>/
    items/YYYY-MM-DD-short-slug.md
  inbox/items/YYYY-MM-DD-unassigned-short-slug.md
  promotion-drafts/<roadmap-item-id>/
    NN-<project>-<short-slug>.md
```

A roadmap item keeps the same file as it matures. The stage lives in frontmatter; the markdown body evolves from rough note to refined spec.

```markdown
---
id: ri_abc123
kind: roadmap-item
project: farmslot-farm
targetProjects: ['metamask-mobile-farm', 'metamask-extension-farm']
stage: refined
tags: [roadmap, command-center]
promotion: []
---

# Title

## Problem

...
```

Before promotion, a human promotion request may materialize draft backlog spec attachments under `promotion-drafts/<roadmap-item-id>/`. These are review artifacts: each file is a complete `kind: backlog-spec` markdown draft with target project, inherited tags, title, body, acceptance criteria, and provenance back to the parent roadmap item. They are not backlog items yet and do not enter dispatch queues.

After promotion, the roadmap item can record lightweight links to created backlog specs. Do not use snapshot hashes in v1; the backlog spec copies the implementation-ready text it needs.

The gateway builds an in-memory index from the files, validates frontmatter on load, and writes atomically with a single-writer lock. Human/external-agent edits are picked up on explicit reload or file-watch invalidation. Gateway writes include the last loaded file hash; if the file changed in an editor, the gateway rejects the write and asks the operator to reload/merge before saving again. Unknown tags remain displayable as raw normalized slugs so human edits do not break the UI.

`~/dev/roadmap` remains a personal/general notebook. Farmslot supports explicit import/export with provenance, but it is not live-synced and is not canonical for Farmslot project execution.

## Lifecycle

### Capture

A user or agent creates a `RoadmapItem(stage=rough)` from quick-add text, pasted markdown, imported `~/dev/roadmap` notes, or external references.

Captured items may be unassigned. They live under `inbox/items/` until assigned to a project.

Captured items may also declare multiple target projects. The owner project answers "where is this idea coordinated?", while target projects answer "which repos/clients should receive dispatchable backlog items?" For example, a MetaMask core/controller follow-up may be owned by `global` or `metamask-core-farm` while targeting both `metamask-mobile-farm` and `metamask-extension-farm`.

### Refine

The user can launch or attach a tmux runner from a roadmap item with a project-specific refinement prompt. The prompt is a per-project markdown template (`projects/<project>/templates/prompts/roadmap-refinement.md`, with explicit `project.json` path override when needed), rendered as the agent context before the tmux session opens. The runner helps turn the markdown into a refined item. V1 does not require a separate refinement-session database.

If `targetProjects` contains more than one project, the rendered refinement prompt must include the target project list. The runner must treat that list as the **allowed** implementation set, not a mandatory 1:1 ticket fan-out.

**Draft count = deployable objectives**, not `len(targetProjects)`:

- Multiple backlog drafts for the **same** project are valid when objectives are independent (e.g. two PRs that should not share a worker).
- Multiple drafts across projects are appropriate when each project needs distinct code or dispatch (e.g. mobile vs extension).
- Framework-only Farmslot monorepo work should **consolidate** into one `farmslot-farm` draft and narrow over-broad `targetProjects` in frontmatter.
- **Per-project policy is the prompt.** The default farmslot-farm refinement template prefers consolidation for framework work. Other packs that want smaller PR-shaped slices override via `project.json` `roadmap.refinement_prompt_path` or inline `roadmap.refinement_prompt` — not by hardcoding fan-out in the gateway.

The refined markdown should make it clear which backlog spec belongs to which target project when fan-out is genuine. The UI should support selecting several target projects before launching refinement, not require duplicating the rough idea manually — and must **not** silently pre-fill every global-filter project as `targetProjects` on capture (multi-target selection is operator-explicit).

The gate to mark refined is explicit: the item must have a problem statement, proposed solution, non-goals, acceptance criteria, risks, and dispatch notes.

### Organize

The user attaches tags and filters roadmap items by project, stage, tag, and text search. Epics/grouping can be added later after the basic roadmap→backlog flow is useful.

### Promote

Promotion is the only write path from roadmap to backlog markdown specs.

Promotion to backlog is blocked until every backlog spec has a concrete target project matching a `project.json` `name`. A single-project item may default the target to `RoadmapItem.project` when that value is concrete. A `global` or `unassigned` roadmap owner may still promote when explicit concrete `targetProjects` are present.

A refined roadmap item can promote to backlog as:

1. One backlog markdown spec for a single deployable objective when no new manual ADR decision is needed.
2. Multiple backlog markdown specs when the roadmap item spans several deployable objectives or several target projects.

If refinement shows that an ADR is needed, the user/developer handles that manually before creating backlog specs. The roadmap system can mention the need in markdown, but v1 does not create or update ADR files programmatically.

The decomposition boundary is execution clarity: each generated backlog spec should be independently dispatchable, reviewable, and trackable, while preserving lightweight provenance back to the parent roadmap item. Generated backlog specs default to not auto-dispatching.

Promotion review happens over draft backlog spec attachments, not over an implicit section hidden inside the roadmap item. The refinement runner may write a `## Backlog Drafts` section in the roadmap markdown as an intermediate authoring format, but `farmslot roadmap request-promotion` materializes those drafts into `.roadmap/promotion-drafts/<roadmap-item-id>/*.md` before asking the human to approve promotion. The Command Center promotion panel reviews those attachment files and only creates real backlog items/spec files after the operator presses Promote.

Promotion writes lightweight provenance:

- Roadmap item promotion notes record created backlog spec paths/IDs.
- Backlog markdown records the originating roadmap item, target project, and inherited tags. Acceptance criteria live in the backlog markdown under `## Acceptance Criteria`, just like Jira/GitHub text is parsed today.
- Promotion decision payloads may include draft spec attachment paths so clients can open the exact artifacts under review.
- Any ADR reference is ordinary markdown text/tags added by the developer, not a typed field or generated artifact.

Promotion should be explicit about whether it creates a new artifact or updates an existing draft. Avoid automatic duplicate backlog specs by showing existing promotion entries before creating more.

Promotion request specs should carry an optional `project`. When omitted, the gateway may use the single concrete target project. When several target projects exist, omitting `project` is invalid because it risks creating all backlog items in the owner/coordinator project.

### Track

Roadmap execution rollup can later be derived from linked backlog/run state, but roadmap does not mutate execution records after promotion except through explicit operator actions. Rollup values such as `shipped`, `done`, or `attention-needed` are UI projections, not `stage` enum values.

Derived examples:

- Linked backlog specs/runs can drive derived roadmap rollup later, but v1 can simply show the promotion links.
- Tags changed on a run do not automatically rewrite the originating roadmap item unless the user chooses “sync tags back.”

## Integration boundaries

### Backlog and dispatch

Backlog remains the execution handoff. `backlog.enqueue` remains the path into the dispatch queue. Roadmap promotion creates backlog markdown specs; it never calls `run.create` directly. ADR-011/TASK.md execution checklists remain per-run task tracking; roadmap acceptance criteria are product/planning gates and are copied into backlog items only at promotion.

Backlog item additions:

V1 backlog can stay markdown-first. A backlog spec must contain enough context for dispatch, including an `## Acceptance Criteria` section. The key rule is that dispatch reads the markdown text just like today's Jira/GitHub ticket text.

Minimal proposed metadata is additive to PR #95 backlog intake: existing source/title/text fields remain the dispatch contract, while `specPath` points to the local markdown file when the item is backed by one.

```ts
interface BacklogItem {
  roadmapItemId?: string;
  specPath?: string;
  tags?: string[];
}
```

### ADRs

Roadmap refinement may reveal that an ADR is needed, but ADR creation/update remains a manual developer workflow in v1. The roadmap/backlog system should not generate ADR files automatically.

### Runs and run families

Runs keep their existing semantics. The shared tag model extends existing run `tags` to roadmap/backlog/graph records; `familyId` and `parentRunId` remain execution lineage only.

### Run bundles

Run bundles may include roadmap/backlog provenance IDs and tags for context, but they do not own roadmap state.

## UI surface

Add a `#roadmap` / backlog-adjacent Command Center surface with a list, markdown editor, tag filters, and promote actions. Backlog UI should show markdown specs, acceptance criteria, roadmap provenance, and tags. Run views can reuse the existing run tag chips.

The roadmap capture/edit surface must distinguish:

- **Owner project:** one project or `global`/`unassigned`, used for file placement and refinement defaults.
- **Target projects:** zero or more concrete projects selected with the same chip-style selector as the global project filter.

The refinement action should show the target project set before launching. The promotion editor should display one project selector per backlog spec. Initializing “one draft per selected target” may be offered as a **convenience for genuine multi-client fan-out**, not as the only or default decomposition — draft count remains objective-based, and packs may prefer fewer or more drafts via their refinement prompt override.

## Non-goals

- No live sync with Jira, GitHub Projects, or `~/dev/roadmap`.
- No sprint planning, burndown, assignees, estimates, or calendar system.
- No dispatch from rough roadmap items.
- No backlog entries that still need product-discovery refinement.
- No overloaded backlog item representing an entire multi-objective roadmap item.
- No work graph edge semantics in v1.
- No tag catalog or hidden conversion of external ticket labels into Farmslot tags.

## Consequences

Positive:

- Rough ideas become durable, sortable roadmap items instead of polluting backlog.
- The same roadmap item can mature from raw thought to refined spec.
- Backlog remains a clean queue of deployable/dispatchable objectives.
- Backlog and runs gain provenance back to product intent.
- Tags remain one filter vocabulary across planning and execution.
- ADR-039 bundles and ADR-040 graphs stay cleanly scoped/deferred.

Costs and risks:

- Markdown-as-state needs basic validation, atomic writes, and conflict handling.
- Promotion must avoid duplicate backlog specs.
- The roadmap surface can easily grow into a full PM tool; the product boundary must stay capture/refine/promote/track.

## Rollout

1. Align ADR-040/041 language around existing `tags` and markdown-first backlog specs.
2. Add backlog markdown/spec support with required `## Acceptance Criteria` before dispatch.
3. Add minimal roadmap list/get/save/promote gateway API over `.roadmap` markdown.
4. Add Command Center roadmap list/editor/promote UI.
5. Add tmux refinement launch as a helper that renders the project prompt template and starts the selected runner/model with that prompt context, not a new session database.
6. Add `targetProjects` to roadmap protocol/storage/UI and include it in refinement prompts.
7. Make roadmap promotion specs project-aware so one refined roadmap item can create ready backlog items across multiple target projects.
8. Materialize promotion draft attachments under `.roadmap/promotion-drafts/<roadmap-item-id>/` before human promotion review.
