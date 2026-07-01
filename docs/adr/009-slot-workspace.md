# ADR-009: Slot Workspace Architecture

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [ADR-001](001-gateway-architecture.md), [ADR-003](003-diff-viewer.md), [ADR-004](004-fleet-map.md), [ADR-008](008-remote-communication.md), [PRD](../PRD-command-center-canonical.md) — Feature C7

## Context

M0-M4 are done. The command center has fleet map, interactive terminals (PTY), PR dashboard, dispatch wizard, and slot detail. Arthur's remaining bottleneck: to inspect what an agent is doing in a slot, he still opens Cursor to browse files, check git changes, view diffs, read TASK.md, and monitor Metro. The "Slot Workspace" brings all of that into the command center as a read-only IDE-like view.

Key constraints:

- Worker repos (e.g., Example Mobile App) have 100k+ files — full tree loads are impractical
- A worker agent is running in the slot — writes would conflict
- Slots can be local (runner-local) or remote (runner-a, runner-b)
- Existing components (code-viewer, diff-review) should be reused

## Decisions

### A. How to access files on local vs remote slots?

**Chosen: Route through existing `isLocalSlot()` pattern** (same as `terminal.ts`).

> **Superseded in part by [ADR-046](046-mandatory-local-node.md) (Proposed):** the local-bypass
> below (local slots use gateway `fs` + `child_process` directly) is being replaced by a mandatory
> co-located local node so local and remote slots route uniformly through a node. The rest of this
> ADR (lazy tree, gitignore filtering, read-only view) still stands.

- Local slots: gateway uses Node.js `fs` + `child_process` directly
- Remote slots: gateway routes through agent WS (agent already has `exec`, `fs.read`)

This is how VS Code Remote works — a server component on each machine handles FS/git locally and streams results back. Our node agent is that server component.

**Not chosen:** Separate HTTP file server per machine — unnecessary when the agent WS channel already handles RPC.

### B. How to load the file tree?

**Chosen: Lazy-load one directory level per expand** — each click triggers `fs.list { slotId, path, depth: 1 }`. Server filters `.gitignore`-matched entries before responding (via `git check-ignore`).

Same as VS Code: `fs.readdir` one level at a time, filtered by `files.exclude` + `.gitignore`. Never loads the full tree.

**Not chosen:** Full tree load — Example Mobile App has 100k+ files. Would take seconds and transfer megabytes.

**Not chosen:** Client-side `.gitignore` filtering — would send `node_modules` over the wire then discard it.

### C. How to get git status, diffs, and history?

**Chosen: Shell out to the `git` CLI.** This is exactly what VS Code does — its git extension wraps CLI calls.

- `git status --porcelain=v1` for changed files (stable, parseable)
- `git diff [file]` for unified diffs — feeds directly to existing `diff-review` component
- `git log --oneline -20` for recent history
- `git show <ref>:<path>` for file content at specific commits

Always available (repo clone requires git), handles large repos efficiently, no library overhead.

**Not chosen:** `isomorphic-git` — 500KB+ bundle, struggles with large repos, adds a heavy dependency for operations the CLI handles trivially.

### D. How to stream Metro logs?

**Chosen: File tail via agent `fs.tail` command** — read last N lines + watch for appends, stream new lines over WS. Metro log path resolved from `project.json` hooks + slot_vars expansion.

**Not chosen:** Second PTY stream per slot — node-pty + xterm.js is heavyweight. Metro logs are simple append-only text; file tailing is simpler and more reliable.

### E. Should the workspace allow edits?

**Chosen: Read-only.** The worker agent is running in the slot — file writes would conflict. An "Open in Cursor" button provides an escape hatch when editing is needed. No file editing, no git operations (stage/commit/push) from the workspace.

### F. How to lay out the workspace panels?

**Chosen: CSS Grid with resizable panels** (matches ADR-004 pattern). Three regions:

```
┌──────────┬─────────────────────────┐
│ Sidebar  │ Main Editor             │
│          │ (code-viewer/diff-review)│
│ Files /  │                         │
│ Source   ├─────────────────────────┤
│ Control  │ Bottom Panel            │
│          │ (metro log)             │
└──────────┴─────────────────────────┘
```

- Sidebar tabs: Files / Source Control
- Bottom panel: collapsible
- Quick-access bar in header: TASK.md, recipe.json, artifacts

**Not chosen:** Heavy layout libraries (golden-layout, react-mosaic) — overkill for a fixed three-panel layout with one resizable split.

## Component Tree

```
<slot-workspace slotId>
  <workspace-header>                    -- slot info, quick-access, buttons
  <workspace-sidebar>                   -- tabs: Files / Source Control
    <file-tree>                         -- lazy-load directory browser
    <git-changes>                       -- changed files list
  <workspace-main>
    <tab-bar>                           -- open file tabs
    <code-viewer> | <diff-review>       -- existing components, reused
  <workspace-bottom-panel>              -- collapsible
    <metro-log-viewer>                  -- streaming log tail
```

New components: 8 (slot-workspace, workspace-header, workspace-sidebar, file-tree, git-changes, tab-bar, metro-log-viewer, artifact-browser).

Reused as-is: code-viewer, diff-review, progress-tracker.

## Protocol Methods

New RPC methods:

| Method               | Params                | Returns                                              |
| -------------------- | --------------------- | ---------------------------------------------------- |
| `fs.list`            | `slotId, path, depth` | `FileEntry[]` (name, type, path, size)               |
| `fs.read`            | `slotId, path`        | `{ content: string, language: string }`              |
| `git.status`         | `slotId`              | `{ branch, ahead, behind, changes: GitChange[] }`    |
| `git.diff`           | `slotId, path?`       | `{ diff: string }` (unified diff)                    |
| `git.log`            | `slotId, limit?`      | `GitLogEntry[]` (hash, message, author, date)        |
| `git.show`           | `slotId, ref, path`   | `{ content: string }`                                |
| `workspace.metroLog` | `slotId`              | subscription — streams `workspace.metro.data` events |

## Consequences

**Positive:**

- Arthur can inspect any slot's repo, diffs, and TASK.md without leaving the browser
- Reuses existing code-viewer and diff-review components — no new rendering libraries
- Lazy file tree scales to 100k+ file repos
- Same local/remote routing pattern as terminals — no new transport
- Read-only eliminates conflict risk with running agents

**Negative:**

- Git CLI calls add shell-out overhead (~50-100ms per operation)
- File content transfer over WebSocket for large files (mitigated by read-on-demand)
- Metro log streaming adds another subscription channel per workspace view

**Risks:**

- `.gitignore` parsing edge cases — mitigated by using `git check-ignore` for filtering
- Large diffs (1000+ changed files) could be slow — mitigated by pagination in git.status

## References

- ADR-003: diff-review + code-viewer component design
- ADR-004: CSS Grid layout pattern
- ADR-008: Node agent RPC and local/remote routing
- Roadmap M6: [ROADMAP.md](../ROADMAP.md)
