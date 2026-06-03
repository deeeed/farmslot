# ADR-019: Recipe Graph Visualization

**Status**: Accepted
**Date**: 2026-04-02

## Context

Workers generate recipes in the `validate.workflow` graph format — `{ entry, nodes }` where nodes connect via `next` and `switch` actions. Workers already generate `workflow.mmd` (mermaid syntax) via `renderWorkflowMermaid()` in `workflow.js` as a debug artifact. However:

- The D8 ready-workspace "Recipe" tab shows only raw JSON — no visual graph
- `workflow.mmd` is generated but never surfaced to reviewers or in PR comments
- Workers, self-reviewers, and human reviewers all reason about recipe correctness from raw JSON

No ADR documents either recipe format or a visualization strategy.

## Decision

### 1. Two rendering surfaces: mermaid for PR artifacts, SVG for UI

**Mermaid** in PR completion comments — zero cost (GitHub renders natively), no UI bundle weight. The `workflow.mmd` artifact already exists; the completion step appends it as a collapsed `<details>` block in the PR comment.

**SVG `<recipe-graph>`** for the UI — reuses `FlowGraph` types from E10 (`FlowGraphNode`, `FlowGraphEdge`, `FlowGraph`). Interactive node click → detail panel. No runtime rendering dependency beyond the existing SVG approach.

### 2. `recipeToFlowGraph(recipe)` converter in `recipe-graph-data.ts`

Maps `validate.workflow` graph format to `FlowGraph` types:

| Recipe node type | FlowGraph kind | Annotation encoding                |
| ---------------- | -------------- | ---------------------------------- |
| `switch`         | `'decision'`   | none                               |
| `end` (pass)     | `'terminal'`   | `'PASS'`                           |
| `end` (fail)     | `'terminal'`   | `'FAIL'`                           |
| all others       | `'step'`       | `'action'` or `'action → save_as'` |

All nodes use `lane: 'worker'` (recipe is single-actor).

Edge style mapping:

- Back-edge detected via DFS → `style: 'loop'`
- Conditional next (`when`/`unless`) → `style: 'conditional'` with summarized assert label
- Switch cases → labeled `style: 'conditional'` edges
- Direct `next` → `style: 'normal'`

The `FlowGraphNode` type is unchanged. Annotation encoding `"action → save_as"` is a display convention; `recipe-graph.ts` parses it to render the save_as as a separate output badge.

### 3. `<recipe-graph>` Lit component

Recipe-specific rendering on top of the flow-graph layout engine:

- Terminal annotation `'PASS'` → green border/fill (`colors.statusOk`)
- Terminal annotation `'FAIL'` → red border/fill (`colors.statusFail`)
- Terminal annotation `'ENTRY'` → accent (indigo) border/fill
- Step annotation `"action → save_as"`: action as sub-label, save_as as small orange badge
- Click any node → detail panel (description: ref, target, selector, save_as, status)

### 4. Ready-workspace Phase B: replace raw JSON with visual graph

D8 `ready-workspace` recipe tab replaces the `<pre>` JSON view with `<recipe-graph>` + "JSON" toggle button.

### 5. PR completion comment: include mmd diagram

`run-completion.ts` reads `workflow.mmd` from the local artifacts directory (written by the recipe runner) and appends a collapsed `<details><summary>Recipe workflow diagram</summary>...mermaid...` block to the PR completion comment.

## Consequences

- Workers must write `workflow.mmd` to artifacts for the PR diagram to appear — this is already done by the recipe runner via `renderWorkflowMermaid()`
- `recipe-graph-data.ts` and `recipe-graph.ts` are UI-only — no gateway or protocol changes
- `FlowGraph` types remain unchanged — annotation encoding is a display-layer convention
- The `annotation` field dual-purpose (action type + PASS/FAIL status) is contained within the recipe-graph module; flow-graph.ts is unaffected
