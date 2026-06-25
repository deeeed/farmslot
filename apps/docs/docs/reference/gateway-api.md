---
title: Gateway API capability surface
---

# Gateway API capability surface

The gateway API is the shared contract for Command Center, Mobile Companion, CLI tools, node agents, and LLM-driven clients.

The public surface should be understood through capabilities, not by reading every internal method name.

## High-value capabilities

| Capability           | Example methods                                                                                    | Safety shape                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Protocol discovery   | `protocol.capabilities`                                                                            | Read-only metadata for clients and docs.                      |
| Fleet state          | `fleet.status`, `node.health.all`                                                                  | Read-only observation of machines, slots, and health.         |
| Dispatch and backlog | `backlog.create`, `backlog.enqueue`, `dispatch.preview`, `dispatch.queue.list`                     | Bounded-write/lifecycle actions with operator policy.         |
| Worker observation   | `tmux.worker.list`, `tmux.worker.inventory.updated`, `terminal.worker.snapshot`, `stream.snapshot` | Read-only state for terminals and workers.                    |
| Worker steering      | `terminal.worker.input`, `terminal.send`                                                           | Bounded-write actions that should be visible and auditable.   |
| Slot lifecycle       | `slot.prepare`, `slot.release`, `slot.recycle`                                                     | Lifecycle operations that change runtime state.               |
| Run lifecycle        | `run.create`, `run.pause`, `run.resume`, `run.cancel`                                              | Lifecycle operations over supervised work.                    |
| Recipe control       | `recipe.command`, `recipe.projectHookCommand`, `recipe.projectHookRun`                             | Project validation and evidence production.                   |
| Decisions            | `decision.list`, `decision.resolve`                                                                | Read/resolve explicit human gates.                            |
| Files and git        | `fs.read`, `git.status`, `git.diff`, `git.discard`                                                 | Read-only by default; destructive operations are high-impact. |

## Worker status surfaces

Use `worker.signal` only for task-template semantics from [`SIGNAL.json`](worker-signal-protocol.md) (completion, blocked state, phase, and optional checklist timing). Runner process activity is exposed through tmux-worker inventory rows: `tmux.worker.list` returns attachable panes with a `status.source` such as `hook`, `statusline`, `task-file`, or `tmux`; `tmux.worker.inventory.updated` broadcasts the same list shape when a node observes a changed pane/status snapshot. This keeps run completion signals separate from terminal/runner liveness.

Worker rows may set `status.requiresAttention` with an `attentionReason` such as `waiting`, `idle`, or `stale-signal`. Clients can use that runner-neutral flag to highlight pinned slots or watchlist panes without parsing Claude/Codex/Cursor-specific output. Plain tmux-only idle panes do not set this flag because that would be a fragile inference.

## Returning to manual work

Manual terminal continuation is slot state, not a gateway run-lifecycle primitive. If a run completes and an operator keeps working in that slot, Command Center should help them keep the slot visible with client-local pinned slots and optional local display labels. Those pins are filtered by the active Command Center project/machine selection in the UI, but they are not gateway state. When the work needs Farmslot supervision again, use a durable ref as the handoff boundary: push/open the branch or draft PR manually, then start an interactive `pr-complete` run against that PR.

There is intentionally no `run.adopt` protocol method. A run should represent a supervised workflow with a clear task/ref and completion contract; a pinned slot represents operator focus on an ongoing workspace.

## Safety tiers

| Tier            | Meaning                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `read-only`     | Observes state or metadata.                                                                     |
| `bounded-write` | Sends a nudge, edits queue/config state, or writes scoped data.                                 |
| `lifecycle`     | Starts, prepares, releases, pauses, resumes, or otherwise changes supervised run state.         |
| `high-impact`   | Deletes, discards, applies, submits, or resolves actions that need stronger human confirmation. |

## Client pattern

1. Connect to the gateway WebSocket.
2. Authenticate with `auth.connect` when auth is enabled.
3. Call `protocol.capabilities` to discover available methods, categories, safety tiers, and examples.
4. Use read-only methods to observe state.
5. Require explicit operator confirmation before bounded-write, lifecycle, or high-impact actions.

## Generated reference

A full method table is generated from `@farmslot/protocol` during the docs build for advanced implementer review. It is intentionally not the public entry point until every method has first-class descriptions, examples, and public-safe grouping.

Use the curated capability surface above for onboarding and external clients.

<details>
<summary>Advanced: raw generated method table</summary>

If you are implementing protocol support itself, see the unlisted [Gateway API generated reference](./gateway-api.generated.md). Expect rough generated summaries while TSDoc coverage continues to mature.

</details>
