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

> **Still current, with a scope note — see [ADR-046](046-mandatory-local-node.md):** the local
> one-off reads/execution below (gateway `fs` + `child_process` directly) **stand** — ADR-046
> deliberately does NOT reroute execution or one-off file reads through the node. ADR-046 only
> moves continuous _monitoring_ (branch/file-change watching, resource, screen) to the machine's
> node, which this ADR did not cover.

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

_Replaced by [Amendment 1](#amendment-1-2026-10-20-conditional-file-edits)._

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

| Method               | Params                                                                                                                                                          | Returns                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `fs.list`            | `slotId, path, depth`                                                                                                                                           | `FileEntry[]` (name, type, path, size)                                |
| `fs.read`            | `slotId, path`                                                                                                                                                  | `{ content, language, hash }`. `hash` is the SHA-256 of the raw bytes |
| `fs.write`           | `slotId, path, content, expectedHash?, runId?`                                                                                                                  | `{ ok, hash? }`. `expectedHash: null` means the file must not exist   |
| `fs.rename`          | `slotId, oldPath, newPath, expectedHash?, runId?`                                                                                                               | `{ ok, hash? }`. With `expectedHash`, `newPath` must not exist        |
| `fs.delete`          | `slotId, path, expectedHash?, runId?`                                                                                                                           | `{ ok }`. A directory delete carries no hash                          |
| `fs.mkdir`           | `slotId, path, runId?`                                                                                                                                          | `{ ok }`                                                              |
| `git.status`         | `slotId`                                                                                                                                                        | `{ branch, ahead, behind, changes: GitChange[] }`                     |
| `git.diff`           | `slotId, path?`                                                                                                                                                 | `{ diff: string }` (unified diff)                                     |
| `git.log`            | `slotId, limit?`                                                                                                                                                | `GitLogEntry[]` (hash, message, author, date)                         |
| `git.show`           | `slotId \| runId, ref, path`, or the batched form in [the gateway change notifications spec](../reference/gateway-change-notifications.md#offline-client-store) | `{ content, id }`. Text only; binary files use the batched form       |
| `workspace.metroLog` | `slotId`                                                                                                                                                        | subscription — streams `workspace.metro.data` events                  |

Conditional writes, per [Amendment 1](#amendment-1-2026-10-20-conditional-file-edits):

1. The gateway checks `runId` itself, against the slot's current run, so run
   binding needs no node support. `null` requires a slot with no run. A write
   with neither `runId` nor `expectedHash` behaves as today.
2. The file host compares `expectedHash` with the SHA-256 of the current bytes
   and writes only on a match. It is the gateway for local slots and the node
   for remote slots.
3. A refusal fails with `FS_CONFLICT` and typed details
   `{ reason: 'hash' | 'run' | 'destination-exists', currentHash?, currentRunId? }`.
4. The gateway forwards a write with `expectedHash` only to a node whose
   `NodeInfo` reports `conditionalWrites`. Otherwise it fails with
   `FS_PRECONDITION_UNSUPPORTED`, and the editor keeps that slot read-only.
5. Without `capabilities.conditionalFileWrites`, the editor stays read-only.

## Consequences

**Positive:**

- Arthur can inspect any slot's repo, diffs, and TASK.md without leaving the browser
- Reuses existing code-viewer and diff-review components — no new rendering libraries
- Lazy file tree scales to 100k+ file repos
- Same local/remote routing pattern as terminals — no new transport
- Read-only eliminates conflict risk with running agents. Superseded by
  [Amendment 1](#amendment-1-2026-10-20-conditional-file-edits), which uses
  write preconditions instead.

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

## Amendment 1 (2026-10-20): Conditional file edits

**Status:** Accepted (owner, 2026-10-20). Design only; implementation follows in separate PRs.

### Decision

This amendment replaces decision E. Command Center's slot workspace may edit
files in a slot when the gateway advertises conditional writes and the slot's
node supports them. Otherwise the workspace stays read-only for that slot.
Editing while a worker runs in the slot is allowed and expected to be rare.
ADR-010's "read-only browsing" rationale is superseded the same way.

**Preconditions.** A file write carries `expectedHash`, the SHA-256 of the bytes
it replaces, as the node's `fs.hash` computes it. `fs.read` returns that hash.
Creating a file expects it to be absent. Renaming a file carries the source hash
and expects the destination to be absent. Deleting a file carries its hash.
Directory creation, rename and delete carry no hash and ask the user to confirm.
The file host checks the hash: the gateway for local slots, the node for remote
slots. It writes only on a match and returns the new hash. Otherwise it refuses
and returns the current hash. The gateway sends a conditional write only to a
node that advertises support, and refuses it otherwise.

**Run binding.** Every workspace write, directory operations included, may name
the run it was made for. When it does, the gateway refuses the write if the slot
now serves a different run. A `null` run means the slot must have no run. A write
that names neither a run nor a hash behaves as today.

**Drafts.** Unsaved edits are kept on the device with their base content and
hash, per gateway connection profile, principal generation, slot, run and path.
They live outside the rebuildable store, in IndexedDB, which all tabs share,
with their own versioned schema. A schema reset or a store cap does not touch
them. Sign-out and principal change delete them, after the editor shows how many
are unsaved. When the user can no longer read a slot, its drafts are hidden and
the 30-day rule below applies. A draft whose run is no longer the slot's
current run is listed read-only, with copy and discard, and is deleted after
30 days. Drafts
are never sent automatically after a reconnect. The user saves them.

**Saving.** The editor saves after a short pause in typing only when the slot
record, ready on the current connection, shows a lifecycle other than `busy`.
`busy` covers a working agent, a pending gate, prepare and release. Otherwise
saving is explicit. At a pending gate the editor warns that saving changes the
reviewed package and requires a new review.

**Conflicts.** When a save is refused, the editor keeps the draft and shows both
versions. The user chooses which to keep.

**Worker writes.** Workers write without preconditions. When a file the user
saved changes to content the user did not write, the editor says so and keeps
the user's version as a draft.

Stage, unstage and discard stay as they are today: explicit actions with no
precondition.

### Rationale and consequences

Decision E chose read-only because worker writes would conflict. The workspace
already writes files, and a plain save can replace a worker's change without
warning. Preconditions stop the editor from overwriting content it has not seen.
They cannot stop a worker from overwriting a user's save, so the editor reports
that case instead.

Autosave pauses while the slot is busy. A half-typed file must not land during a
worker's tests or commits, or during prepare and release. At a pending gate, any
save changes the reviewed diff, and the gate then requires another review. Saves
name their run because slots are reused, and a save made for one run must not
land in another run's work. Drafts are not sent automatically after a reconnect
for the same reason. Automatic merging is left out. Conflicts are expected to be
rare, and the user keeps either version.

Companion does not edit files.

### Public surface

- `@farmslot/protocol/rpc/fs`: `FsReadResult` gains `hash`. `FsWriteParams`,
  `FsRenameParams` and `FsDeleteParams` gain optional `expectedHash`.
  `FsWriteParams`, `FsRenameParams`, `FsDeleteParams` and `FsMkdirParams` gain
  optional `runId`. On a write, `expectedHash: null` means the file must not
  exist. On a rename with a precondition, the destination must not exist.
  `FsWriteResult` and the rename result gain the new `hash`. A refused write
  fails with `FS_CONFLICT`, whose typed details carry the current hash or the
  slot's current run. Consumers: the editor in Command Center and its desktop
  app.
- `@farmslot/protocol/rpc/fs`: `NodeFsWriteParams` and `NodeFsRenameParams`
  gain `expectedHash`, and a new `NodeFsDeleteParams` carries it for deletes, so
  the shared `NodeFsPathParams` does not change. `@farmslot/protocol/rpc/nodes`:
  `NodeInfo` gains `conditionalWrites`, like the existing `execCancellation`
  flag. Consumers: the gateway's file methods, which check the flag before
  forwarding, the node's file commands, and the editor, which stays read-only on
  a slot whose node lacks the flag.
- `@farmslot/protocol/rpc/auth`: `capabilities.conditionalFileWrites`. Consumer:
  the Command Center editor, which stays read-only without it.
- `@farmslot/local-store` gains the drafts store for browsers. Consumer: the
  Command Center editor.
- There are no new CLI commands or flags. `@farmslot/cli`, mm-harness and recipe
  workers are not consumers. These additions start experimental.
