# ADR-008: Remote Machine Communication — SSH vs Node Agent

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [ADR-001](001-gateway-architecture.md), [ADR-002](002-tmux-streaming.md), [PRD](../PRD-command-center-canonical.md) — Features A2, B2, C1, F3

## Context

Farmslot manages slots across 3 machines (runner-local local, runner-a remote, runner-b remote). Today all remote operations go through SSH:

```
CLI Orchestrator ──(ssh)──> runner-a ──> tmux / adb / Metro / git / etc.
                 ──(ssh)──> runner-b  ──> same
                 ──(local)──> runner-local
```

Every script runs `ssh runner-a.local "bash -c 'command'"` for remote slots. This works but has pain points:

- SSH connection setup latency (~200ms per command)
- ControlMaster reduces but doesn't eliminate overhead
- Polling-based health checks (no push)
- stdout/stderr parsing for structured data
- SSH key and config management
- Session-bound — if the orchestrator dies, all SSH connections die too

**OpenClaw discovery:** OpenClaw's node system uses the **inverse pattern** — remote devices connect inbound to the gateway via WebSocket. The gateway sends commands as RPC invocations over the already-open socket. This gives real-time presence, bidirectional streaming, and no SSH dependency.

## Options Considered

### A. Keep SSH (via `ssh2` library)

Migrate from shell `ssh` commands to programmatic `ssh2` in TypeScript (per ADR-001).

```
Gateway ──(ssh2)──> runner-a ──> run commands
        ──(ssh2)──> runner-b  ──> run commands
```

**Pros:**

- No new software on remote machines
- SSH is universal, battle-tested, well-understood
- `ssh2` library is mature (15M weekly npm downloads)
- Works immediately with existing machine setup
- File transfer via SFTP (built into ssh2)

**Cons:**

- Outbound connection model — gateway must reach machines
- NAT/firewall issues if machines move
- Polling-based presence (is machine up?)
- No native streaming — must poll or keep SSH channels open
- Connection lifecycle management (pool, reconnect, timeout)

### B. Node Agent (OpenClaw Pattern)

Each machine runs a lightweight TypeScript agent that connects to the gateway via WebSocket. The gateway sends commands as RPC invocations.

```
runner-a-agent ──(ws)──> Gateway <──(ws)── runner-b-agent
                         │
                    runner-local-agent (local WS or in-process)
```

**Architecture:**

- **Node agent**: ~500 lines of TS. Connects to gateway, handles RPC commands:
  - `exec` — run shell command, stream stdout/stderr
  - `tmux.capture` — read tmux pane
  - `tmux.send` — send keys to tmux pane
  - `tmux.attach` — start streaming pane output
  - `fs.read` / `fs.write` — file operations (fixtures, artifacts, TASK.md)
  - `health.check` — run health hook, return structured result
  - `process.list` / `process.kill` — agent process management
- **Gateway**: NodeRegistry tracks connected agents, routes commands
- **Pairing**: First connect requires approval (like OpenClaw device pairing), then remembered

**Pros:**

- Real-time bidirectional streaming — terminal data pushed instantly
- Native presence — WebSocket open = machine online
- Gateway is the single point of truth — no polling
- Clean RPC model — typed request/response, no stdout parsing
- Resilient — agent auto-reconnects if gateway restarts; gateway tracks reconnects
- Firewall-friendly — all connections are outbound from machines
- File transfer via WebSocket messages (no SFTP setup)
- Eliminates SSH key management for new machines
- Aligns with OpenClaw architecture — reuse NodeRegistry, invoke pattern, presence tracking
- Server-side monitoring (F3) becomes trivial — agents push status

**Cons:**

- New daemon to install and manage on each machine (launchd on macOS, systemd on Linux)
- Another service to keep running — one more failure mode
- Must handle agent crashes, upgrades, versioning
- Large file transfer over WebSocket is less efficient than SFTP
- Security: the agent can execute arbitrary commands — must trust the network or add auth
- Adds ~2 weeks to initial development

### C. Hybrid — SSH for Now, Agent Later

Use ssh2 for v1 (works immediately). Design the gateway API to be transport-agnostic. Add node agent in v1.1.

```
v1:   Gateway ──(ssh2)──> machines
v1.1: Gateway <──(ws)── machine-agents (SSH as fallback)
```

**Pros:**

- Fastest path to working system
- Transport-agnostic API means no rewrite when adding agents
- SSH provides a proven fallback for edge cases

**Cons:**

- Two transport implementations to maintain
- SSH limitations persist in v1 (polling, latency)
- "We'll add it later" often becomes "we'll add it never"

## Decision

**Option B — Node Agent**, with a pragmatic v1 scope.

### Rationale

The Agent Observatory is the v1 killer feature — it must replace opening multiple Cursor windows to watch agents. This demands:

- **Real-time terminal streaming** — not 200ms polling
- **Reliable presence** — know instantly when a machine drops
- **Bidirectional interaction** — send nudges, receive output, same channel
- **Server-side monitoring** — agents push violations, gateway persists decisions

SSH can technically do all of this, but it fights the architecture at every step — persistent SSH channels for streaming, polling for presence, stdout parsing for structured data, separate SFTP for files. The node agent pattern solves all of these natively.

OpenClaw proves the pattern at scale with mobile devices (more unreliable than Linux servers). For farmslot's 3 machines, it's even simpler.

### Node Agent Design

**Installation:** Single TypeScript file, runs via `tsx` or compiled to standalone binary via `pkg`/`bun build --compile`. Managed by launchd (macOS) or systemd (Linux).

**Config:** Minimal — just gateway URL and machine name:

```json
{
  "gateway": "ws://runner.local:7777",
  "machine": "runner-a",
  "token": "auto-generated-on-first-pair"
}
```

**Startup flow:**

1. Connect to gateway WebSocket
2. Send `connect` with `role: "node"`, machine name, capabilities
3. If first connect: gateway queues pairing request, Arthur approves in UI
4. If returning: gateway validates token, registers in NodeRegistry
5. Gateway sends `hello` with pending commands (if any)
6. Agent starts heartbeat + enters command loop

**Command surface:**

| Command             | Description                               | Replaces                     |
| ------------------- | ----------------------------------------- | ---------------------------- |
| `exec`              | Run shell command, stream output          | `ssh host "cmd"`             |
| `exec.background`   | Run long command, push completion event   | Background SSH               |
| `tmux.capture`      | Capture pane text                         | `ssh host tmux capture-pane` |
| `tmux.send`         | Send keys to pane                         | `ssh host tmux send-keys`    |
| `tmux.stream.start` | Begin streaming pane output               | Polling capture-pane         |
| `tmux.stream.stop`  | Stop streaming                            | —                            |
| `fs.read`           | Read file contents                        | `ssh host cat file`          |
| `fs.write`          | Write file contents                       | `scp file host:path`         |
| `fs.sync`           | Sync directory (fixtures)                 | `sync-fixtures.sh`           |
| `health.check`      | Run health hook, return structured result | Health poll                  |
| `health.subscribe`  | Push health changes                       | Polling farm-status          |
| `process.list`      | List relevant processes                   | `ssh host ps`                |
| `process.kill`      | Kill process by PID                       | `ssh host kill`              |

**Streaming model for terminals:**

```
UI ──(terminal.subscribe)──> Gateway ──(tmux.stream.start)──> Node Agent
                                     <──(tmux.data events)──
                             Gateway ──(terminal.data events)──> UI (xterm.js)
```

The node agent runs `tmux capture-pane` locally (zero latency), diffs, and pushes changes over WebSocket. Much faster than SSH-based polling.

**Local machine (runner-local):**
The agent runs locally too — same code, same WebSocket connection (localhost:7777). This eliminates the local-vs-remote code path split that currently exists in every script (`is_local()` checks).

### Impact on Other ADRs

**ADR-002 (tmux streaming):** Simplifies dramatically. The node agent handles tmux capture locally and streams over WS. No SSH PTY bridge needed. The agent can even do incremental diffs before sending.

**ADR-001 (gateway architecture):** Reinforced. Pure TS gateway + pure TS node agents = single language, shared types, shared protocol.

**ADR-005 (state persistence):** Node agents can push status changes in real-time. `.farm-status.json` becomes a cache of the live state, not the primary collection mechanism.

### Reuse from OpenClaw

| OpenClaw Component                   | Farmslot Usage                                 |
| ------------------------------------ | ---------------------------------------------- |
| `NodeRegistry`                       | Track connected machine agents, route commands |
| `node.invoke` / `node.invoke.result` | RPC pattern for remote commands                |
| Device pairing flow                  | Machine pairing (first connect approval)       |
| Presence tracking                    | Machine online/offline detection               |
| Pending work queue                   | Queue commands for offline machines            |
| Command allowlisting                 | Restrict what gateway can invoke on agents     |

## Consequences

**Positive:**

- Real-time everything — terminal, presence, health, monitoring
- Single transport (WebSocket) instead of SSH + SFTP + polling
- Unified local/remote code path
- OpenClaw patterns reused directly
- Server-side monitoring persists across gateway restarts
- New machines: install agent → connect → approve in UI → done

**Negative:**

- Must install and manage agent daemon on every machine
- Agent crashes = machine goes dark (mitigated by systemd/launchd auto-restart)
- Agent upgrades must be coordinated (mitigated by version negotiation at connect time)
- Security: agent trusts gateway to send valid commands (acceptable for single-user, same-network setup)

**Risks:**

- Agent installation friction — mitigated by single-file install script
- WebSocket drops on unstable networks — mitigated by auto-reconnect + command retry
- Large artifact transfer (videos, screenshots) over WS — mitigated by chunked transfer or fallback to HTTP upload

## Amendment: Unified Exec (2026-04-01)

The original design left exec timeout hardcoded at 30s in the gateway and ignored the agent's `agent.exec.output` streaming events. This caused long-running commands (e.g., `yarn setup` during prepare) to time out on remote slots, and led to a workaround SSH exec path (`slotExecStreaming`) that bypassed the agent entirely.

**Changes:**

- Agent `exec` timeout is now optional (no default = runs until done)
- Gateway routes `agent.exec.output` events to per-request callbacks via an `outputListeners` map in `agent-rpc.ts`
- `execOnSlot` is the single entry point for all slot command execution (local + remote), with optional `timeout` and `onOutput` callback
- SSH exec path (`slotExecStreaming`) deleted — agent handles all remote execution
- `execLocalStreaming`, `execViaAgent`, `SlotStreamingOpts`, `StreamingExecOptions` deleted

## References

- OpenClaw NodeRegistry: `/Users/deeeed/dev/openclaw/src/gateway/node-registry.ts`
- OpenClaw node methods: `/Users/deeeed/dev/openclaw/src/gateway/server-methods/nodes.ts`
- OpenClaw node pairing: `/Users/deeeed/dev/openclaw/src/infra/node-pairing.ts`
- OpenClaw device identity: `/Users/deeeed/dev/openclaw/src/infra/device-pairing.ts`
- OpenClaw pending work: `/Users/deeeed/dev/openclaw/src/gateway/node-pending-work.ts`
