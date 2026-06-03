# ADR-010: Slot View Layout — Unified IDE-Like Interface

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [ADR-009](009-slot-workspace.md), [ADR-003](003-diff-viewer.md), [ADR-004](004-fleet-map.md), [PRD](../PRD-command-center-canonical.md) — Feature C7

## Context

ADR-009 defined a separate "Slot Workspace" view for browsing files and diffs. In practice, the slot-detail view (health, actions, task progress) and the workspace view (files, git, editor) serve the same user at the same time — Arthur inspecting a running agent. Having two separate views with tabs creates friction and wastes space (the detail view has sparse content that doesn't fill its panels).

VS Code provides the reference pattern: a unified view with an icon activity bar, collapsible sidebar panels, a main editor area, and a persistent terminal.

## Decisions

### A. How should slot-detail and workspace relate?

**Chosen: Merge into a single `slot-view` component.** One route (`#slot/{slotId}`), one component, one view. No tabs between "detail" and "workspace" — they coexist.

The sidebar contains all context (files, git changes, slot info, actions, task progress) as collapsible sections. The main area is always the editor. The terminal is always at the bottom.

**Not chosen:** Separate tabs (Detail / Workspace). The detail tab had too little content to justify its own view. Switching back and forth to check health while browsing code adds friction.

**Not chosen:** Separate routes (`#slot/` vs `#workspace/`). Forces full component teardown/rebuild on navigation. Loses terminal state, scroll positions, open tabs.

### B. How should the sidebar be organized?

**Chosen: VS Code-style activity bar + panel content.**

An icon strip on the far left edge of the sidebar (activity bar). Each icon activates a different panel in the sidebar content area:

| Icon           | Panel     | Content                                |
| -------------- | --------- | -------------------------------------- |
| Explorer       | Files     | File tree (lazy-load)                  |
| Search         | Search    | `git grep` results                     |
| Source Control | Changes   | Changed files list + branch info       |
| Info           | Slot Info | Machine, platform, health, agent, task |

Within each panel, collapsible accordion sections where appropriate (e.g., Source Control could show Staged / Unstaged / Untracked).

The Info panel consolidates what was previously in slot-detail: health dots, lifecycle actions (Prepare/Release/Recycle), task progress bar + checklist. Compact vertical layout fits naturally in a sidebar.

**Not chosen:** All sections in one scrollable list (initial implementation). Works but buries less-used sections and doesn't scale as we add more panels (Search, Git Log, etc.).

**Not chosen:** Text tabs at the top of the sidebar. Takes more space than icons and doesn't match the VS Code pattern users already know.

### C. How should search work?

**Chosen: `git grep` via gateway RPC.** No indexing required — `git grep` is fast on any repo size and respects `.gitignore` by default.

Protocol method: `search.query` — params `{ slotId, pattern, options? }`, returns `{ matches: SearchMatch[] }` where `SearchMatch = { file, line, text, before?, after? }`.

Gateway runs: `git grep -n --column -I <pattern>` with optional `-i` (case insensitive), `--glob` (file filter).

UI: search input in the Search panel, results grouped by file, click result opens file at line in the editor.

**Not chosen:** Full-text index (ripgrep server, trigram index). Overkill for single-user read-only browsing. `git grep` handles Example Mobile App's 100k+ files in <500ms.

### D. How should panels be resizable?

**Chosen: Drag handles with mouse event tracking.** Thin (4px) invisible dividers between panels. On mousedown: track mousemove, update width/height state. On mouseup: persist to localStorage.

Two resizable splits:

- Sidebar width (horizontal drag, 150-500px range)
- Terminal height (vertical drag, 100-600px range)

**Not chosen:** CSS `resize` property. Limited to one direction, no custom handle styling, poor UX.

**Not chosen:** Layout library (golden-layout, allotment). Heavyweight dependency for two drag handles.

### E. How should layout state persist?

**Chosen: `localStorage` with a single JSON key.** Stores sidebar width, terminal height, terminal open/closed, accordion section states. Restored on component mount. Saved on every layout change (resize end, section toggle, terminal toggle).

```typescript
interface LayoutPrefs {
  sidebarWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
  sections: Record<string, boolean>;
}
```

This is layout preference, not session state — it applies across all slots.

### F. How should the component handle Shadow DOM vs light DOM?

**Chosen: Light DOM (`createRenderRoot() { return this; }`).**

Monaco editor and diff2html inject CSS into `document.head`. If the slot-view uses Shadow DOM, that CSS can't reach the editor elements inside the shadow boundary. This was the root cause of Monaco rendering without line numbers, cursor, or input handling.

Light DOM means all CSS is global. Styles are scoped by convention: all selectors prefixed with `slot-view` element selector (e.g., `slot-view .sv-sidebar { ... }`).

The same pattern is used by `app-shell` and `dev-harness` — the three outermost components are all light DOM. Inner components (file-tree, git-changes, tab-bar, terminal-view) keep Shadow DOM since they don't contain Monaco/diff2html.

**Not chosen:** Shadow DOM with adopted stylesheets for Monaco CSS. More correct architecturally, but Monaco's CSS is 309KB and changes across versions — manually adopting it is fragile and hard to maintain.

## Component Layout

```
<slot-view>
  .sv-header            -- back btn, slot ID, lifecycle badge, quick access, editor selector
  .sv-body              -- flex row
    .sv-activity-bar    -- icon strip (Explorer, Search, Source Control, Info)
    .sv-sidebar         -- panel content for selected activity
    .sv-resize-h        -- drag handle (4px)
    .sv-editor          -- tab-bar + code-viewer/diff-review
  .sv-resize-v          -- drag handle (4px)
  .sv-terminal-panel    -- toggle header + terminal-view
```

## Consequences

**Positive:**

- Single view replaces two — less navigation, more context visible at once
- VS Code pattern is familiar to developers — zero learning curve
- `git grep` search is instant with no infrastructure
- Layout persistence means Arthur's preferred arrangement survives refreshes
- Light DOM solves Monaco/diff2html CSS issues permanently

**Negative:**

- Light DOM requires disciplined CSS scoping (all selectors prefixed)
- Single 1300+ line component — may need extraction as it grows
- `git grep` doesn't support regex across files as powerfully as ripgrep (acceptable for v1)

## References

- ADR-009: Slot Workspace Architecture (predecessor)
- ADR-003: Code Diff & Editor — Monaco + diff2html
- VS Code source: Activity Bar + Sidebar + Editor + Panel layout
