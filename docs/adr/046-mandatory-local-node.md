# ADR-046: Mandatory Co-located Local Node — Unify Monitoring Under the Node Layer

**Status:** Proposed
**Date:** 2026-07-01
**Relates to:** [ADR-008](008-remote-communication.md) (extends), [ADR-009](009-slot-workspace.md) (scope note — its §A local reads/exec still stand), [ADR-001](001-gateway-architecture.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-020](020-agent-to-node-rename.md), [ADR-035](035-node-support-bundles.md)

## Context

Farmslot has two long-lived services with **different concerns**:

- **Gateway** — orchestration: runs/pipeline, state, fleet registry, routing, the Command Center API.
- **Node** (`services/node`) — machine-local capabilities: command `exec`, file read/write **and file-change watching** (`fs.ts`), resource watching (ports/devices/dev-server), **screen/device capture** (ScreenCaptureKit, browser PID), system metrics, and tmux capture/send + worker watching. It `authenticateThenRegister()`s to the gateway over WebSocket and advertises its capabilities.

Today these are **not** cleanly separated for local machines. Per [ADR-009 §A](009-slot-workspace.md) ("How to access files on local vs remote slots"), local slots deliberately **bypass the node**:

> Local slots: gateway uses Node.js `fs` + `child_process` directly. Remote slots: gateway routes through the node WS.

That decision (an `isLocalSlot()` split) was pragmatic for early milestones, but it has three costs:

1. **Missing capability layers on local slots.** Local execution goes through `execLocal`, so it does not get the node's `fs`-watch, `resource-watch`, `screen`, `system-metrics`, or `tmux-worker-watch` layers — unless the gateway **reimplements** them locally (it partially does: local device feed via capture-helper, tmux/PTY for terminals). That reimplementation is duplication and drift.
2. **Dishonest fleet.** The gateway-host machine (e.g. macwork, all slots `ssh: LOCAL`) has no connected node, so it renders as **`NODE OFFLINE`** in the fleet even though its slots are READY and execute fine. It looks broken.
3. **Blurred ownership.** The gateway ends up owning machine-local concerns for the local case, contradicting the gateway/node split.

## Decision

**Make a co-located local node mandatory.** Every machine that runs slots — including the gateway host — runs a node; the gateway owns orchestration only.

1. **`farmslot up` starts and supervises a local node.** The node connects to the gateway over a loopback WebSocket and registers with capabilities exactly like a remote node (auth via the existing gateway token). Its lifecycle is tied to `up` (start, health, restart).
2. **Machine-local MONITORING routes through the node** — branch/file-change watching (`fs.watch`), resource watching, and screen/device capture flow through the machine's node (local via loopback), uniform with remote. The gateway stops running its local reimplementations for these (the branch-watcher `chokidar`; local capture-helper). Without a node, monitoring is degraded (a periodic poll still refreshes the branch) and upgrades to live watches when the node connects (`node.connect` → `restartBranchWatchesForMachine` / `sendWatchInstructions`).
3. **EXECUTION stays gateway-side for local slots — deliberately NOT rerouted.** One-off commands (`execLocal`) and one-off file reads/writes (the [ADR-009 §A](009-slot-workspace.md) slot-workspace path) keep running directly in the gateway for local slots — cheap, unchanged, and it works even when the node is down. Rerouting execution through the node would add a hop for no functional gain; the node is about **monitoring + presence**, not execution. ADR-009 §A therefore still stands for one-off local reads; only continuous _watching_ (which ADR-009 did not cover) moves to the node.
4. **The fleet shows the local node online** because it is a real registered node; `farmslot doctor` reports its presence (degraded when absent).

### Gateway vs node responsibilities (canonical map)

| Concern                                                      | Owner       |
| ------------------------------------------------------------ | ----------- |
| Orchestration: runs, pipeline steps, state, run/family model | **Gateway** |
| Fleet registry, node presence, routing to nodes              | **Gateway** |
| Command Center API / auth / profiles                         | **Gateway** |
| Command execution (`exec`) on a machine                      | **Node**    |
| File read/write + **file-change watching** (`fs`)            | **Node**    |
| Resource watching (ports, devices, dev-server)               | **Node**    |
| Screen / device capture (ScreenCaptureKit, browser PID)      | **Node**    |
| System metrics                                               | **Node**    |
| tmux capture/send + worker watching                          | **Node**    |

Rule of thumb: **machine-local capability → node; cross-machine coordination → gateway.** There is no local special-case.

### Local means local — ownership, not transport

Routing local slots "through the node" does **not** mean network or SSH for same-machine work. A node always operates on **its own** machine's resources **directly**: the local node reads/writes files with Node `fs` and runs `child_process` on the same box, at native speed — it never SSHes to reach itself. SSH is only ever the gateway↔*remote* transport (and even that is the node WebSocket in the ADR-008 model, not SSH).

So the two axes are orthogonal:

- **Ownership** — who performs and owns a machine-local capability (fs, exec, watch, screen). Answer: that machine's node.
- **Transport** — how the gateway reaches that node. Loopback WebSocket for the local node; network WebSocket for a remote node.

The local node's gateway channel is a **loopback** WebSocket carrying RPC requests/results; the actual file and process operations happen locally. Making the local node mandatory changes _who owns_ local capabilities (node, not gateway) and gives the machine real fleet presence — it does **not** add SSH, a network hop, or remote file access for local slots.

## Consequences

**Positive**

- One uniform **monitoring** path for all machines; the local watch reimplementations (chokidar branch watch, local device feed) go away, so there is one place to maintain.
- Local slots gain the node's monitoring layers (fs-watch, resource-watch, screen, metrics) that were skipped without a node.
- Honest fleet: the gateway host appears as an online node; `farmslot doctor` reports it.
- Clean, documented separation of concerns; execution stays simple and gateway-local.

**Negative / cost**

- New lifecycle: `farmslot up` must supervise the local node (spawn, health-check, restart on crash) — one more managed process.
- Monitoring becomes node-dependent: no node ⇒ no live branch/file/screen watches (degraded); the 60s branch poll and `execLocal` execution still work.
- Loopback WS needs auth (reuse the gateway token).

## Migration / rollout

1. **This ADR + `farmslot up` co-launch** (reuse `services/node` + token auth); fleet + doctor reflect the node; degraded when absent. **[done]**
2. Unify **monitoring** through the node, dropping the gateway's local reimplementations:
   - branch / `.git/HEAD` watch → node `fs.watch` (drop the local `chokidar` branch in `branch-watcher.ts`). **[done]**
   - resource watch → already node-based (`resource-manager.ts`); activates for local once the node connects.
   - screen / device feed → node `screen` (drop the gateway's direct capture-helper for local). **[follow-up]**
3. Execution is **not** migrated — `execLocal` and one-off local file reads (ADR-009 §A) stay gateway-side by design.

Until the local node is co-launched, the "local host shows NODE OFFLINE" badge is cosmetic (local slots still work via `execLocal`); the fleet now renders it as **degraded** instead.
