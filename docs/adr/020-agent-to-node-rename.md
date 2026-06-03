# ADR-020: Terminology Rename — Agent → Node

**Status:** Accepted
**Date:** 2026-04-08
**Relates to:** [ADR-008](008-remote-communication.md) — Remote communication, [PRD](../PRD-command-center-canonical.md)

## Context

ADR-008 introduced the per-machine daemon as "Node Agent" — inspired by the OpenClaw NodeRegistry pattern where remote devices connect inbound via WebSocket. Over time the codebase settled on **`Agent`** as the primary noun:

- `@farmslot/agent` package
- `AgentInfo`, `AgentsListResult`, `AgentDeployParams/Result` types
- `Events.AGENT_CONNECTED`, `AGENT_DISCONNECTED`, `AGENT_VERSION_MISMATCH`
- `Methods.AGENTS_LIST`, `AGENTS_DEPLOY`
- `registerAgent()`, `markMachineOnline()`
- `scripts/deploy-agent.sh`, `~/farmslot-agent/`, `com.farmslot.agent.plist`, `farmslot-agent.service`
- `farmslot agent status|deploy` CLI

This conflicts with the rest of the ecosystem where "agent" now overwhelmingly refers to **LLM agents** (Claude, Codex, self-review) — the things running inside tmux sessions doing bug fixes. Two unrelated concepts sharing a name causes real confusion:

> "Is the agent online?" → does that mean the Claude session or the per-machine daemon?
>
> "Deploy the agent" → to which fleet layer?
>
> UI says "Agent connected" when an LLM session attaches and also when a machine daemon connects.

ADR-008 itself used "Node agent" as the proper noun. The codebase dropped "Node" and kept "Agent" — the wrong half.

## Decision

**Rename the per-machine daemon to `Node` across the entire code surface.** No compat shim. No deprecation alias. Atomic rename in a single PR.

The LLM session running inside a worker slot remains "agent" (Claude agent, Codex agent, self-review agent). The per-machine daemon that connects inbound via WebSocket is a "node" (fleet node, node daemon, `NodeInfo`).

### Why no backward compat

A dual-naming period — `agent.connect` alias accepted alongside `node.connect`, `farmslot agent status` aliased to `farmslot node status` — creates tech debt with no corresponding benefit:

- Fleet has 4 machines. Migration cost is one `deploy-node.sh` invocation per machine.
- No external consumers of the protocol. Wire format is single-tenant.
- Aliases rot quietly. A "remove after one release" TODO becomes a permanent fossil.
- The point of this rename is to eliminate ambiguity. An alias layer preserves the very ambiguity we're removing.

The gateway protocol version bumps 0.2.0 → 0.3.0. Old daemons hard-fail against the new gateway and are redeployed immediately via `deploy-node.sh`.

### Scope of the rename

| Layer                     | Old                                                                       | New                                                                   |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Package**               | `packages/agent/`, `@farmslot/agent`                                      | `services/node/`, `@farmslot/node`                                    |
| **Protocol types**        | `AgentInfo`, `AgentsListResult`, `AgentDeployParams`, `AgentDeployResult` | `NodeInfo`, `NodesListResult`, `NodeDeployParams`, `NodeDeployResult` |
| **Protocol methods**      | `agents.list`, `agents.deploy`                                            | `nodes.list`, `nodes.deploy`                                          |
| **Protocol events**       | `agent.connected`, `agent.disconnected`, `agent.version.mismatch`         | `node.connected`, `node.disconnected`, `node.version.mismatch`        |
| **Connect frame**         | `agent.connect`                                                           | `node.connect`                                                        |
| **Protocol version**      | `0.2.0`                                                                   | `0.3.0`                                                               |
| **Gateway internals**     | `agent-rpc.ts`, `registerAgent()`, `AgentRpcError`, internal agent maps   | `node-rpc.ts`, `registerNode()`, `NodeRpcError`, node maps            |
| **UI props/state**        | `agentInfo`, `onlineMachines` (unchanged — machine-level)                 | `nodeInfo`, `onlineMachines` (unchanged)                              |
| **UI strings**            | "AGENT OFFLINE", "AGENT v0.2.0 ≠ v0.3.0"                                  | "NODE OFFLINE", "NODE v0.2.0 ≠ v0.3.0"                                |
| **CLI**                   | `farmslot agent status`, `farmslot agent deploy`                          | `farmslot node status`, `farmslot node deploy`                        |
| **Install script**        | `scripts/deploy-agent.sh`                                                 | `scripts/deploy-node.sh`                                              |
| **Deploy dir on machine** | `~/farmslot-agent/`                                                       | `~/farmslot-node/`                                                    |
| **macOS plist**           | `com.farmslot.agent.plist`                                                | `com.farmslot.node.plist`                                             |
| **systemd unit**          | `farmslot-agent.service`                                                  | `farmslot-node.service`                                               |

### Bundled fix — typed event payloads

Every `gateway.subscribe` call in the UI currently casts an `unknown` payload to an inline object type literal. 36 occurrences across 11 files:

```ts
// Before
gateway.subscribe(Events.AGENT_CONNECTED, (p: unknown) => {
  const { machine, pid, protocolVersion, versionMatch } = p as {
    machine: string; pid: number; protocolVersion?: string; versionMatch?: boolean;
  };
  ...
});
```

The rename touches all of these call sites. Rather than mechanical search-and-replace, the executor:

1. Adds a colocated payload interface for every `Events.*` constant in `packages/protocol/src/events.ts` (e.g., `NodeConnectedPayload`, `TaskProgressUpdatedPayload`, `RunCreatedPayload`, etc.).
2. Makes `GatewayClient.subscribe<T>(event, callback)` generic in `ui/src/gateway-client.ts`.
3. Rewrites each subscriber to use the typed form — zero `as { ... }` casts remain after the pass.

Why bundle these two changes: every event subscriber gets touched by the rename anyway. Doing the de-inlining in the same pass is cheaper than a second PR, and leaves the event surface properly typed for new features.

### Migration — self-cleaning `deploy-node.sh`

The new install script detects any prior `agent`-named installation on the target machine and removes it before installing the node equivalents. Zero manual steps.

**macOS path:**

```bash
if [[ -f ~/Library/LaunchAgents/com.farmslot.agent.plist ]]; then
  launchctl unload ~/Library/LaunchAgents/com.farmslot.agent.plist 2>/dev/null || true
  rm ~/Library/LaunchAgents/com.farmslot.agent.plist
  rm -rf ~/farmslot-agent
  echo "[migrate] removed com.farmslot.agent"
fi
```

**Linux path:**

```bash
if [[ -f ~/.config/systemd/user/farmslot-agent.service ]]; then
  systemctl --user stop farmslot-agent 2>/dev/null || true
  systemctl --user disable farmslot-agent 2>/dev/null || true
  rm ~/.config/systemd/user/farmslot-agent.service
  rm -rf ~/farmslot-agent
  echo "[migrate] removed farmslot-agent.service"
fi
```

After this PR lands, one command per machine completes the migration:

```bash
bash scripts/deploy-node.sh runner-local
bash scripts/deploy-node.sh mini
bash scripts/deploy-node.sh runner-a
bash scripts/deploy-node.sh runner-b
```

### Not renamed

- **`markMachineOnline` / `markMachineOffline`** in `node-health.ts` — these are _machine_-level helpers (a machine may have several nodes over its lifetime as daemons restart). Node connect/disconnect drives them but they operate on `MachineHealth`.
- **`onlineMachines: Set<string>`** in fleet-canvas state — tracks which machines have a live node connection, but keyed by machine name. The semantic is "which machines are reachable" — renaming to `onlineNodes` would be worse because a machine may have zero or one node daemons.
- **`.agent/` directories** inside worker repos (e.g., `.agent/browser.pid` in example-browser checkouts) — these belong to the worker LLM agent, not the node daemon. Unrelated.

## Consequences

**Positive:**

- One noun per concept. "Agent" now unambiguously means LLM worker. "Node" means per-machine daemon.
- Typed event payloads across the full UI surface — compile-time safety for every subscriber.
- `deploy-node.sh` is self-cleaning → fleet migration is idempotent, no per-machine cleanup docs needed.
- Future docs and ADRs inherit the clean terminology.

**Negative:**

- Breaking protocol change — running nodes must all be redeployed atomically with the gateway restart.
- Loses git blame continuity across renamed files (mitigated by `git log --follow`).
- One session of execution work.

**Risks:**

- A missed reference (string literal, comment, doc) could leave stale terminology. Mitigated by verifier pass after executor completes, plus grep sweep: `rg '\bagent\b' --type ts --type md` excluding comments about LLM agents.
- Workspace rename (`packages/agent/` → `services/node/`) requires `yarn install` to rebuild the workspace graph. Verified locally before pushing.
- Macwork node goes dark briefly while the gateway restarts and `deploy-node.sh` runs. Acceptable — no active worker during the migration window.

## References

- ADR-008 (original "Node Agent" proposal): [008-remote-communication.md](008-remote-communication.md)
- F2.6 (node status visibility, precursor UI work): [ROADMAP.md § F2.6](../ROADMAP.md)
- Roadmap entry: F2.7 — Agent → Node terminology rename
