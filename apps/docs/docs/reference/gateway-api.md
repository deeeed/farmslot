---
title: Gateway API capability surface
---

# Gateway API capability surface

The gateway API is the shared contract for Command Center, Mobile Companion, CLI tools, node agents, and LLM-driven clients.

The public surface should be understood through capabilities, not by reading every internal method name.

## High-value capabilities

| Capability           | Example methods                                                                | Safety shape                                                  |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Protocol discovery   | `protocol.capabilities`                                                        | Read-only metadata for clients and docs.                      |
| Fleet state          | `fleet.status`, `node.health.all`                                              | Read-only observation of machines, slots, and health.         |
| Dispatch and backlog | `backlog.create`, `backlog.enqueue`, `dispatch.preview`, `dispatch.queue.list` | Bounded-write/lifecycle actions with operator policy.         |
| Worker observation   | `tmux.worker.list`, `terminal.worker.snapshot`, `stream.snapshot`              | Read-only state for terminals and workers.                    |
| Worker steering      | `terminal.worker.input`, `terminal.send`                                       | Bounded-write actions that should be visible and auditable.   |
| Slot lifecycle       | `slot.prepare`, `slot.release`, `slot.recycle`                                 | Lifecycle operations that change runtime state.               |
| Run lifecycle        | `run.create`, `run.pause`, `run.resume`, `run.cancel`                          | Lifecycle operations over supervised work.                    |
| Recipe control       | `recipe.command`, `recipe.projectHookCommand`, `recipe.projectHookRun`         | Project validation and evidence production.                   |
| Decisions            | `decision.list`, `decision.resolve`                                            | Read/resolve explicit human gates.                            |
| Files and git        | `fs.read`, `git.status`, `git.diff`, `git.discard`                             | Read-only by default; destructive operations are high-impact. |

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
