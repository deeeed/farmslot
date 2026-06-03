# ADR-006: OpenClaw Reuse Strategy

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** All other ADRs, [PRD](../PRD-command-center-canonical.md)

## Context

OpenClaw is a mature project by the same author with a proven gateway + WebSocket + Lit.js architecture. The Farmslot Command Center should maximize reuse to avoid rebuilding solved problems.

This ADR maps OpenClaw components to Farmslot equivalents and defines the reuse strategy: what to copy, what to adapt, what to build new.

## Analysis

### Direct Reuse (copy + minimal adaptation)

| OpenClaw Component            | Files                           | Farmslot Usage                               | Adaptation Needed                             |
| ----------------------------- | ------------------------------- | -------------------------------------------- | --------------------------------------------- |
| **Frame protocol**            | `protocol/schema/frames.ts`     | Same req/res/event frames                    | Change event names + payload shapes           |
| **WS server bootstrap**       | `server-runtime-state.ts`       | Same HTTP + WS server creation               | Strip TLS/Tailscale, simplify config          |
| **Method dispatch**           | `server-methods.ts`             | Same handler map + dispatch loop             | Replace auth checks, new handler map          |
| **Health state + versioning** | `server/health-state.ts`        | Fleet state + version counter + broadcast    | Change snapshot shape to FleetStatus          |
| **Broadcast mechanism**       | `server-broadcast.ts`           | Same backpressure-aware broadcast to clients | Copy verbatim                                 |
| **Browser WS client**         | `ui/src/ui/gateway.ts`          | Same request/subscribe/reconnect             | Strip device auth, add fleet-specific methods |
| **Vite config**               | `ui/vite.config.ts`             | Same build setup                             | Change paths, remove OpenClaw-specific stubs  |
| **Lit patterns**              | Various `ui/src/ui/components/` | Same component structure, decorators, css    | Copy pattern, write new components            |

### Adapt (significant modification)

| OpenClaw Component     | Files                       | Farmslot Usage                                   | Adaptation                                                                               |
| ---------------------- | --------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **NodeRegistry**       | `node-registry.ts`          | MachineRegistry — track connected machine agents | Change identity model (machine name vs device fingerprint), add slot-level tracking      |
| **Node invoke**        | `server-methods/nodes.ts`   | Machine RPC — exec, tmux, fs, health commands    | Replace device commands with fleet ops commands. Strip APNS wake. Add streaming support. |
| **Device pairing**     | `infra/device-pairing.ts`   | Machine pairing — first-connect approval flow    | Simplify (no crypto keypairs for v1, just machine name + token)                          |
| **Presence tracking**  | `server/presence-events.ts` | Machine presence — online/offline/degraded       | Add slot-level health aggregation                                                        |
| **Connection handler** | `server/ws-connection.ts`   | Same lifecycle (nonce, register, cleanup)        | Strip flood guards, simplify auth to token check                                         |
| **Pending work queue** | `node-pending-work.ts`      | Task queue — commands for offline machines       | Simplify priority model, add task-specific fields                                        |

### Build New (no OpenClaw equivalent)

| Component                  | Description                                              | Why New                                                        |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| **Script-to-TS migration** | Fleet lifecycle logic (prepare, release, dispatch, etc.) | Domain-specific, no OpenClaw equivalent                        |
| **tmux integration**       | Terminal capture, streaming, send-keys                   | OpenClaw has no terminal concept                               |
| **Fleet Map UI**           | Spatial machine/slot canvas                              | OpenClaw UI is conversation-centric                            |
| **Agent Observatory**      | Multi-terminal split view, progress tracker              | Unique to agent fleet management                               |
| **Dispatch Wizard**        | Task creation + slot assignment UI                       | Domain-specific workflow                                       |
| **PR Dashboard**           | CI checks, bot comments, merge status                    | GitHub-specific integration                                    |
| **Monaco Diff Viewer**     | Code diff with review comments                           | OpenClaw has no code review features                           |
| **Decision Queue**         | Pending decisions with action buttons                    | Concept exists in OpenClaw (pairing approval) but much simpler |

## Decision

### Reuse Approach: Fork + Adapt, Not Dependency

OpenClaw code will be **copied and adapted into the farmslot codebase**, not imported as a dependency. Reasons:

1. **OpenClaw evolves independently** — we don't want breaking changes upstream to affect farmslot
2. **Heavy adaptation needed** — stripping auth, replacing domain types, adding fleet concepts
3. **Single codebase simplicity** — no cross-repo dependency management
4. **License allows it** — same author, same private codebase

### What This Looks Like In Practice

**Phase 1 — Gateway scaffold:**

- Copy frame protocol types, adapt for fleet domain
- Copy WS server bootstrap (HTTP + upgrade handler)
- Copy method dispatch pattern (handler map + dispatch loop)
- Copy health state pattern (version counter + broadcast)
- Copy broadcast mechanism verbatim
- **Result:** Working WebSocket server that accepts connections and dispatches RPC methods

**Phase 2 — Node agent:**

- Adapt NodeRegistry → MachineRegistry
- Adapt node.invoke → machine.exec / machine.tmux._ / machine.fs._
- Simplify device pairing → machine pairing (name + token)
- Adapt presence tracking → machine presence with slot health
- **Result:** Machine agents connect to gateway, accept commands

**Phase 3 — UI scaffold:**

- Copy GatewayBrowserClient, adapt for fleet methods
- Copy Vite config
- Copy Lit component patterns (app shell, routing, state)
- **Result:** Working UI that connects to gateway and renders fleet data

**Phase 4 — Fleet-specific UI:**

- Build new: Fleet Map, Agent Observatory, Dispatch Wizard, PR Dashboard, Decision Inbox, Monaco Diff Viewer
- No OpenClaw equivalent for these — pure new development

### Estimated Reuse Savings

| Component                 | Without OpenClaw | With OpenClaw | Savings |
| ------------------------- | ---------------- | ------------- | ------- |
| Gateway infrastructure    | 2 weeks          | 3 days        | ~70%    |
| Node agent / remote comms | 2 weeks          | 1 week        | ~50%    |
| UI infrastructure         | 1 week           | 2 days        | ~70%    |
| Fleet-specific features   | 4 weeks          | 4 weeks       | 0%      |
| **Total**                 | ~9 weeks         | ~6 weeks      | ~33%    |

The savings come from not having to design and debug the WebSocket protocol, connection lifecycle, reconnection logic, broadcast mechanism, and method dispatch pattern from scratch.

## Alternative Considered: OpenClaw as Runtime (Plugin Path)

We evaluated making Farmslot an OpenClaw plugin rather than a standalone product. OpenClaw has an extensive plugin SDK: `registerGatewayMethod`, `registerService`, `registerHttpRoute`, `registerCli`, `registerHook`. The fleet backend could theoretically plug into OpenClaw's gateway, and the fleet UI could be served at `/fleet/` via an HTTP route.

**Rejected because:**

1. **Disproportionate weight** — Running all of OpenClaw (chat, agents, channels, sessions, 50+ extensions) just to get a WebSocket server is like running Kubernetes to host a static site
2. **Plugin SDK constraints** — No dynamic UI component registry, so the fleet UI would be a separate SPA anyway — not integrated into OpenClaw's navigation
3. **Coupling risk** — OpenClaw's plugin API evolves for OpenClaw's needs, not ours. Breaking changes require updating farmslot even when nothing about the fleet changed
4. **Debugging complexity** — Issues span two codebases with different mental models
5. **What we actually need is small** — The reusable infrastructure is ~500-800 lines of code (frame protocol, WS server, method dispatch, broadcast, browser client, node registry pattern). That's a morning of copy+adapt vs. permanent dependency management

The copy+adapt approach gives us the same proven patterns without the coupling. OpenClaw remains a reference, not a runtime.

## Consequences

**Positive:**

- ~3 weeks saved on infrastructure
- Proven patterns — fewer bugs in the plumbing
- Consistent architecture across OpenClaw and Farmslot (same author's mental model)
- Can backport improvements in either direction

**Negative:**

- Fork means manual sync if OpenClaw improves a shared pattern
- Copied code may diverge over time
- Initial copy+adapt takes careful work to strip OpenClaw-specific logic

## References

- OpenClaw source: `/Users/deeeed/dev/openclaw/`
- Reuse analysis: See agent exploration report from ADR preparation session
