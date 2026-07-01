# ADR-046: Mandatory Co-located Local Node — Unify Execution Under the Node Layer

**Status:** Proposed
**Date:** 2026-07-01
**Relates to:** [ADR-008](008-remote-communication.md) (extends), [ADR-009](009-slot-workspace.md) (**supersedes §A local-bypass**), [ADR-001](001-gateway-architecture.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-020](020-agent-to-node-rename.md), [ADR-035](035-node-support-bundles.md)

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
2. **All slots route through their machine's node.** Local slots use the loopback node's `exec` / `fs` / `screen` / watch handlers — the same RPC path as remote slots — instead of the gateway's `execLocal` and local reimplementations.
3. **Supersede [ADR-009 §A](009-slot-workspace.md):** local slots no longer use gateway `fs` + `child_process` directly. File access, execution, and watching for local slots go through the local node, uniform with remote.
4. **The fleet shows the local node online** because it is a real registered node.

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

- One uniform execution + capability path for all machines; the `isLocalSlot()` execution split goes away.
- Local slots gain the full node layer (fs-watch, resource-watch, screen, metrics) with no gateway reimplementation.
- Honest fleet: the gateway host appears as an online node.
- Clean, documented separation of concerns between the two services.

**Negative / cost**

- New lifecycle: `farmslot up` must supervise the local node (spawn, health-check, restart on crash) — one more managed process.
- Migration must remove/deprecate the gateway's local reimplementations (`execLocal` streaming path, local device feed) once the local node handles them, without regressing terminals or evidence capture.
- Loopback WS needs auth (reuse the gateway token) and must not incur meaningful latency for local exec.

## Migration / rollout

1. **This ADR** — record the decision, supersede ADR-009 §A, publish the responsibility map.
2. `farmslot up` co-launches + supervises a loopback local node (reuse `services/node` + the token auth).
3. Route local slots through the local node (replace the `isLocalSlot() → execLocal` branches with node RPC over loopback), starting with `exec`, then `fs`/watch, then `screen`.
4. Dedup: retire the gateway's local reimplementations as each capability moves to the node.
5. Fleet UI: render the local/gateway-host node as online (remove the misleading `NODE OFFLINE`).

Until step 2 ships, the current behavior stands and the "local host shows NODE OFFLINE" badge should be treated as cosmetic (local slots still work via `execLocal`).
