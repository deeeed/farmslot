# ADR-001: Gateway Architecture — TypeScript vs Script Wrapping

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [PRD](../PRD-command-center-canonical.md) — Open Question #1

## Context

Farmslot currently has 28 bash scripts (`scripts/*.sh`) that implement fleet management: slot lifecycle, dispatch, health checks, PR monitoring, fixture syncing, etc. These scripts handle SSH, tmux, jq parsing, file watching, and process management.

The Command Center needs a persistent gateway daemon that exposes this functionality over WebSocket. The architectural question: how does the gateway relate to these scripts?

OpenClaw — the reference architecture by the same author — uses a **TypeScript gateway** for its control plane. Verified: the gateway core is 100% TS — the only `child_process` usage is peripheral (opening config files in an editor, DNS/Tailscale discovery). No shell scripts participate in message routing, state management, or RPC handling. This makes the gateway:

- Fully typed and testable
- Directly importable by both CLI and UI clients
- Easy to extend with new methods
- Native WebSocket integration (no stdout parsing)

**Key difference:** OpenClaw doesn't manage remote machines. Farmslot does. So we extend the pattern with SSH (`ssh2`) and tmux control — capabilities OpenClaw doesn't need but the architecture cleanly accommodates.

## Options Considered

### A. Spawn Scripts (child_process)

Gateway calls `bash scripts/farm-status.sh --json` via `child_process.spawn`, parses stdout.

**Pros:**

- Zero rewrite — scripts stay source of truth
- Fastest path to a working gateway

**Cons:**

- Fragile: parsing stdout, error codes, stderr heuristics
- No type safety at the boundary
- Two languages to maintain (bash + TS)
- Can't share logic between gateway and scripts
- Scripts do SSH + tmux internally — gateway can't intercept or stream granularly
- Testing requires full shell environment

### B. Full TypeScript Rewrite

Port all script logic to TypeScript modules. Gateway calls TS functions directly.

**Pros:**

- Aligned with OpenClaw architecture — clean integration
- Fully typed, testable, debuggable
- Single language for the entire control plane
- Native streaming (no stdout parsing)
- SSH via `ssh2` library — programmatic, no shell escaping
- tmux via direct commands — no `bash -c` wrapping
- Shared types between gateway, CLI, and UI
- Can reuse OpenClaw's server bootstrap, method dispatch, and broadcast patterns directly

**Cons:**

- Significant upfront effort to port 28 scripts
- Risk of re-introducing bugs during port
- SSH edge cases (ControlMaster, key forwarding) need careful handling

### C. Hybrid — TS Gateway Spawning Scripts

Thin TypeScript wrappers that call scripts, parse JSON output. Gradually replace scripts with native TS.

**Pros:**

- Incremental migration path
- Works today, improves over time

**Cons:**

- Two systems to maintain during transition
- Never fully clean — always some bash/TS boundary
- OpenClaw patterns don't compose well with spawn-based handlers
- The "gradual migration" often stalls at 60%

## Decision

**Option B — Full TypeScript gateway**, aligned with OpenClaw.

The bash scripts were the right tool for bootstrapping: fast to write, easy to iterate, no build step. But the Command Center is a different kind of system — persistent, real-time, multi-client, WebSocket-native. TypeScript is the right tool for this.

### Migration Strategy

The rewrite is **not** a line-by-line port. It's a re-implementation against the same contracts (pool JSON, project JSON, .farm-status.json) using OpenClaw patterns:

1. **Phase 1 — Core state** (Week 1)
   - Read pool/_.json, projects/_/project.json, .farm-status.json
   - Transform to typed FleetStatus
   - Watch for changes (chokidar), broadcast updates
   - This replaces: `farm-status.sh`, `lib/slot-common.sh` (resolve_slot, load_project_config, load_slot_vars)

2. **Phase 2 — Remote execution** (Week 2)
   - SSH client via `ssh2` library (replaces `remote()` / `run_on()` helpers)
   - tmux commands (capture-pane, send-keys, kill-pane)
   - Process management (agent detection, kill)
   - This replaces: the SSH/tmux portions of all scripts

3. **Phase 3 — Lifecycle operations** (Week 3)
   - Slot prepare, release, recycle, check
   - Fixture syncing (template rendering + scp)
   - Hook expansion ({{VAR}} substitution + remote execution)
   - This replaces: `prepare-slot.sh`, `release-slot.sh`, `check-slot.sh`, `sync-fixtures.sh`

4. **Phase 4 — Dispatch & monitoring** (Week 4)
   - Slot selection (scoring logic from find-slot.sh)
   - Task file creation and delivery
   - Agent launch (claude/codex dispatch)
   - Server-side monitoring loop
   - This replaces: `find-slot.sh`, `dispatch.sh`, `monitor-slot.sh`

5. **Phase 5 — PR & external** (Week 5)
   - GitHub API via Octokit (replaces `gh` CLI calls)
   - CI check status, bot comment detection
   - PR monitoring rules
   - Jira image download
   - This replaces: `pr-status.sh`, `pr-monitor.sh`, `download-jira-images.sh`

### Coexistence During Migration

During the transition, both systems work side by side:

- **Bash scripts** remain functional and unchanged — they still read/write the same JSON files
- **Gateway** reads the same JSON files, progressively adds native operations
- **CLI orchestrator** (Claude Code) continues using bash scripts until gateway methods are proven
- Each phase is independently deployable — gateway can serve what it has, fall back to "not implemented" for the rest

### What We Keep From Scripts

The scripts encode domain knowledge that must transfer:

- `.farm-status.json` schema and field semantics
- Pool/project JSON schemas and override rules (pool > project)
- Hook expansion logic (`{{VAR}}` substitution)
- Slot selection scoring (CDP > ready > device > fixtures)
- Lifecycle state machine transitions
- PR monitoring recommendation rules

These become TypeScript modules with the same logic, better tests, and type safety.

## Consequences

**Positive:**

- Clean alignment with OpenClaw — gateway patterns, frame protocol, method dispatch all compose naturally
- Single TypeScript codebase for gateway + protocol + UI
- Native WebSocket streaming for all operations
- Testable without shell environment
- SSH operations become programmatic (retry, timeout, connection pooling)

**Negative:**

- Larger upfront investment before feature parity
- Must handle SSH edge cases that bash handles implicitly (ControlMaster, agent forwarding, known_hosts)
- `ssh2` library may have gaps vs OpenSSH CLI for exotic configs

**Risks:**

- SSH edge cases — mitigated by keeping bash scripts as fallback during migration
- Scope creep in rewrite — mitigated by phased approach with clear boundaries
- `ssh2` limitations — mitigated by option to shell out to `ssh` CLI for specific operations if needed

## References

- OpenClaw gateway: `/Users/deeeed/dev/openclaw/src/gateway/server.impl.ts`
- OpenClaw method dispatch: `/Users/deeeed/dev/openclaw/src/gateway/server-methods.ts`
- OpenClaw frame protocol: `/Users/deeeed/dev/openclaw/src/gateway/protocol/schema/frames.ts`
- Farmslot shared helpers: `/Users/deeeed/dev/farmslot/scripts/lib/slot-common.sh`
- Farmslot fleet status: `/Users/deeeed/dev/farmslot/scripts/farm-status.sh`
