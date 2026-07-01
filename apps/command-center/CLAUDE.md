# Command Center — Development Guide

## Project Overview

Farmslot Command Center: real-time fleet management UI + gateway daemon for autonomous coding agents.

- **PRD**: [docs/PRD-command-center-canonical.md](../../docs/PRD-command-center-canonical.md)
- **ADRs**: [docs/adr/](../../docs/adr/) — all 9 accepted
- **Roadmaps**: [docs/ROADMAP.md](../../docs/ROADMAP.md) and [docs/ROADMAP-next.md](../../docs/ROADMAP-next.md) are canonical.

## Architecture (from ADRs)

| Decision         | Choice                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Gateway          | Full TypeScript (ADR-001)                                         |
| Remote comms     | Node agent on each machine, inbound WebSocket (ADR-008)           |
| tmux streaming   | Agent PTY attach + WS push (ADR-002)                              |
| Diff & source    | diff2html (diff review) + Monaco (code viewer) — ADR-003          |
| Fleet map        | CSS Grid (ADR-004)                                                |
| State            | In-memory + JSON snapshots, gateway owns state (ADR-005)          |
| OpenClaw reuse   | Copy ~500-800 lines, adapt — not a dependency (ADR-006)           |
| Structure        | Yarn workspaces monorepo (ADR-007)                                |
| Slot Workspace   | Read-only IDE view, lazy file tree, git CLI, file tail (ADR-009)  |
| Slot View Layout | Unified view, activity bar, accordion panels, light DOM (ADR-010) |

## Package Structure

```
farmslot/
  packages/
    protocol/       # @farmslot/protocol — shared types, methods, and recipe contracts
    recipe-harness/ # @farmslot/recipe-harness — shared recipe runner runtime
    theme/          # @farmslot/theme — shared UI tokens
    cli/            # @farmslot/cli — operator CLI for gateway/control-plane actions
  services/
    gateway/        # @farmslot/gateway — WebSocket server, fleet state, method handlers
    node/           # @farmslot/node — lightweight daemon deployed to each machine (ADR-020)
  apps/
    command-center/
      ui/           # Lit.js SPA — Vite build, connects to gateway via WebSocket
    companion/      # mobile companion app
```

Yarn workspaces. Root `packages/*` are consumed by app surfaces under `apps/*`.

## Development Rules

### Scope Control — HARD RULE

**STOP and ask before building anything that is not already in canonical roadmap scope ([ROADMAP.md](../../docs/ROADMAP.md), [ROADMAP-next.md](../../docs/ROADMAP-next.md)) or an accepted PRD.**

If a task, bug fix, or feature request doesn't map to an existing roadmap milestone:

1. **Do NOT start coding.** Ask Arthur first.
2. **Capture it** — propose whether it should be: (a) a new PRD section, (b) a sub-item of an existing milestone, or (c) deferred.
3. **Get explicit approval** to add it to the roadmap before writing any code.

This applies to "while we're at it" improvements, scope expansions during implementation, and any work that wasn't in the original task description. Bug fixes for code you just wrote are fine. Adding a new component, protocol type, or gateway feature is not — unless it's already on the roadmap.

The roadmap is the single source of truth for what gets built. No exceptions.

### Validate Via CDP — HARD RULE

**Every UI change MUST be validated through Chrome DevTools Protocol (CDP) before considering it done.** Do not rely on TypeScript compilation alone — render the component in the browser and verify it works.

Two committed helpers do the work — do NOT write throwaway `cdp-*.mjs` files:

- `scripts/debug-chrome.sh` — idempotent launcher. Reuses an existing CDP session on `$FARMSLOT_CDP_PORT` if one is already listening; otherwise spawns Chrome with a dedicated profile.
- `scripts/cdp.mjs` — reusable runner. Wraps `Runtime.evaluate` against a tab by route hash, plus a `gateway <method>` mode for direct WS RPC against the gateway.

**Default port is 9323** (non-default, avoids 9222/4355 conflicts). Override via env:

- `FARMSLOT_CDP_PORT=9400` — different CDP port
- `FARMSLOT_CDP_PROFILE=~/.chrome-farmslot-alt` — different profile dir
- `FARMSLOT_UI_URL=http://localhost:5174/#runs` — different starting URL

Validation flow:

1. **Start the dev server**: `cd apps/command-center && yarn farmdev > /tmp/farmslot-dev.log 2>&1 &` (gateway auto-restarts via `tsx watch`; see **Dev Stack — Local CLI** below)
2. **Launch Chrome**: `bash scripts/debug-chrome.sh` (reuses existing session if already up)
3. **Evaluate in the page** (shadow-DOM walks, state reads, click dispatches):
   ```bash
   node scripts/cdp.mjs eval fleet "return document.querySelectorAll('slot-card').length"
   node scripts/cdp.mjs eval slot/runner-browser-1 --file probes/cleanup-button.js
   ```
4. **Query the gateway directly** when you need to disambiguate UI-render bugs from empty-data cases:
   ```bash
   node scripts/cdp.mjs gateway fleet.status
   node scripts/cdp.mjs gateway run.list '{"limit":5}'
   ```
5. **Navigate by setting `location.hash`** via `cdp.mjs eval`, then re-query for the component under test.

`cdp.mjs` wraps the expression in `(async () => { ... })()` and awaits the promise, so `return value` / `await fetch(...)` work directly. Use `--file` for anything longer than a one-liner to avoid shell-escape pain.

If CDP is not available, at minimum use `node scripts/cdp.mjs gateway <method>` to verify data flows, and `curl http://localhost:5174/src/components/...` to verify compilation.

### Dev Stack — Local CLI and Gateway Autorestart — HARD RULE

**Never use a globally installed `farmslot` binary in dev.** It may point at a different install than the checkout under test (wrong `FARMSLOT_ROOT`, pool path, gateway port/token).

| Task               | Command                                              |
| ------------------ | ---------------------------------------------------- |
| Start gateway + UI | `cd apps/command-center && yarn farmdev`             |
| CLI (this repo)    | `cd apps/command-center && yarn farmslot …`          |
| Gateway RPC        | `node apps/command-center/scripts/cdp.mjs gateway …` |
| Gateway only       | `yarn workspace @farmslot/gateway dev`               |

**Worktree slot dispatch:** `run.create` for `macwork-ff-*` uses the **operator** gateway (`7777`, default CLI URL). Slot ports `8808+` are for recipe/CDP validation after prepare `sandbox` — do not pass `--url ws://localhost:8809` when dispatching. See [worktree-operator-model.md](../../docs/operations/worktree-operator-model.md).

`farmdev` → `scripts/dev.sh` → `yarn dev` → `concurrently` with `@farmslot/gateway dev` (`tsx watch src/index.ts`) and Vite. **Code changes reload the gateway automatically** — do not manually restart after editing gateway source if `farmdev` is up. Pool JSON changes are picked up via file watcher + `fleetRefresh` (no restart).

Bare `yarn dev` skips `.env.ports` unless ports are already exported — prefer `yarn farmdev` on the main operator tree.

The **`farmslot` CLI auto-loads `<checkout>/.env.ports` then `.env`** at startup (non-overriding — an explicit shell env var always wins). So per-checkout dev config (`FARMSLOT_HOME`, `GW_URL`, ports) applies to `yarn farmslot` without sourcing anything — the same file `scripts/dev.sh` reads for the stack. Installed clones have no such files, so it's a no-op there.

### Preferred Typecheck Command — HARD RULE

Use:

```bash
cd apps/command-center && yarn typecheck
```

Do **not** use `tsc -b` for routine validation in this repo. Some workspace packages do not emit into a safe build directory, so emitting builds can leak `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files into source paths.

### Slot View Quality Commands

For the current slot-view quality/refactor surface, use the scoped automated checks instead of relying on prose conventions:

```bash
cd apps/command-center
yarn lint:slot-view
yarn format:extracted:check
yarn quality:slot-view
```

`format:extracted:check` is now a compatibility alias for the full command-center Prettier check. Prefer `yarn format:check` in new automation; keep the extracted alias only for older quality entrypoints.

See [`CODE_QUALITY.md`](CODE_QUALITY.md) for the current large-file breakup inventory and the shared URL-state convention. New hash/query parsing should use `ui/src/utils/url-state.ts` instead of adding another view-local parser.

### Type Reuse — No Inline Duplication

Before defining an inline type, check `@farmslot/protocol` for existing shared types:

- **`OkResult`** — `{ ok: true }` for void-success returns
- **`ExecResult`** — `{ stdout, stderr, exitCode }` for command execution
- **`CommandOutput`** — `{ stdout, stderr }` for output without exit code
- **`FLOW_STEPS`** — pipeline step sequences per flow type (single source of truth)
- **`RunMeta`** — lightweight run summary (id, flow, ticket, PR, branch, runner, model)

If a type is used by 2+ packages, add it to root `packages/protocol/src/types.ts`.
If gateway-internal, put it in `services/gateway/src/core/` and re-export from `core/index.ts`.
Never duplicate a type definition across files — import it.

### Abstract Runner-Specific Code Behind Interfaces — HARD RULE

**Any code that directly inspects a runner's identity (e.g., `runner === 'claude'`), parses runner-shaped output, or invokes a runner-specific binary MUST live behind a typed interface in `services/gateway/src/runners.ts`.** The consumer should not know which runner is supplying the answer. Helper functions exported from `runners.ts` (like `runnerSupportsTmuxNudges` or `getRunnerStatusProvider`) ARE the approved abstraction surface — calling them from outside `runners.ts` is fine and expected. The forbidden pattern is **inline string compares** on runner ids, **regex against runner-shaped tmux output**, or **shell-out to runner-specific CLIs** — all of which must move into `runners.ts` behind a registry entry. This applies even when only one runner implements the surface today.

- New per-runner declarative info (capability flags) goes on `RunnerDefinition`.
- New per-runner behavior (status surfaces, recovery commands, output parsers) goes through a sibling provider registry like `KNOWN_RUNNER_STATUS_PROVIDERS` with a typed interface (`RunnerStatusProvider`, etc.). Add registry entries per runner; absent entry = "this runner has no impl yet, callers null-check the result".
- The `runners.ts` file itself is allowed to know runner identities — that's its job. Anything outside it (`methods/dispatch.ts`, `run-engine/orchestrator.ts`, UI, …) must be runner-neutral. Grep for `runner === 'claude'` / `runner === 'codex'` outside `runners.ts` — that's a violation.
- When reviewing PRs, flag inline runner-specific parsing/dispatch as a hard issue, not a nit. Cost of fixing later (after a second runner ships) is much higher than getting the abstraction right at write time.

Acceptable shortcut: when a feature ships v1 with only one runner implementing it, define the interface anyway and register a single provider — the second runner becomes a pure addition, not a refactor.

### Isolation First

Every feature MUST work in isolation before integration. This means:

1. **UI components accept data via props/state** — never require a live gateway during development
2. **Gateway methods work with mock state** — can test via `wscat` without agents
3. **Agent works standalone** — can connect to gateway and test commands independently
4. **Mock data is first-class** — not an afterthought

### Dev Harness

The UI has a `#dev/*` route that renders each component with hardcoded mock data:

```
#dev/slot-card      → SlotStatus mock
#dev/fleet-map      → FleetStatus mock (3 machines, 8 slots, mixed states)
#dev/terminal       → mock terminal data stream
#dev/dispatch       → wizard with mock steps
#dev/pr-board       → PRStatus[] mock (mixed CI states)
#dev/diff           → diff-review (diff2html) + code-viewer (Monaco) with mock data
#dev/decisions      → PendingDecision[] mock
```

The dev harness is at `ui/src/dev/` — one file per component with mock data factories.

### Testing Gateway Methods

```bash
# Start gateway + UI (preferred — loads .env.ports, gateway auto-restarts on edit)
cd apps/command-center && yarn farmdev

# Gateway only (also tsx watch)
yarn workspace @farmslot/gateway dev

# Test via wscat or cdp.mjs (avoid global `farmslot` CLI in dev)
wscat -c ws://localhost:7777
> {"type":"req","id":"1","method":"fleet.status"}
node scripts/cdp.mjs gateway fleet.status
```

### Testing Node Daemon

```bash
# Start node daemon (connects to gateway)
yarn workspace @farmslot/node dev

# Test via gateway
wscat -c ws://localhost:7777
> {"type":"req","id":"1","method":"machine.exec","params":{"machine":"runner-local","cmd":"uptime"}}
```

## Coexistence With Bash Scripts

The gateway coexists with existing bash scripts during migration:

1. **Phase 1**: Gateway reads `.farm-status.json` (scripts write it). Zero script changes.
2. **Phase 2**: Node agents push real-time data. Scripts still work via SSH.
3. **Phase 3**: Gateway starts writing to `.farm-status.json` in same format. Dual-write.
4. **Phase 4**: Scripts retired one-by-one after gateway parity.

**NEVER break existing scripts.** The gateway is additive until we explicitly retire a script.

## OpenClaw Reference

Copy patterns from `/Users/example/dev/openclaw/`, don't import as dependency:

| What to copy             | OpenClaw file                           | Adapt                  |
| ------------------------ | --------------------------------------- | ---------------------- |
| Frame protocol           | `src/gateway/protocol/schema/frames.ts` | Event/method names     |
| WS server bootstrap      | `src/gateway/server-runtime-state.ts`   | Strip TLS/auth         |
| Method dispatch          | `src/gateway/server-methods.ts`         | New handler map        |
| Health state + broadcast | `src/gateway/server/health-state.ts`    | FleetStatus shape      |
| Browser WS client        | `ui/src/ui/gateway.ts`                  | Strip device auth      |
| Node registry            | `src/gateway/node-registry.ts`          | Machine identity model |
| Lit component patterns   | `ui/src/ui/app.ts`                      | Domain-specific views  |

## UI Conventions

- **Framework**: Lit v3 — `@customElement`, `@property`, `@state`, `css`, `html`
- **Styling**: Dark theme, monospace, dense information layout
- **Theme tokens**: JS constants importable into `css` tagged templates via `unsafeCSS()`
- **Colors**: bg `#0a0a0f`, surface `#12121a`, card `#1a1a2e`, accent `#6366f1`
- **Status**: ok `#00ff88`, warn `#ffcc00`, fail `#ff4444`, unknown `#666`
- **Font**: `'SF Mono', 'Cascadia Code', 'Fira Code', monospace`
- **Components**: Shadow DOM (Lit default), custom elements prefixed with `farm-` or descriptive names
- **No emojis** in UI unless user explicitly requests

## Gateway Conventions

- **WebSocket port**: 7777 (default, override via `GATEWAY_PORT` env var)
- **Frame protocol**: `{ type: 'req'|'res'|'event', ... }` — see `@farmslot/protocol`
- **Method handlers**: flat map `{ 'method.name': handlerFn }` (OpenClaw pattern)
- **State**: in-memory `FleetState` class, JSON snapshot to `.farm-status.json`
- **Streaming**: long-running operations (prepare, release, dispatch) push `script.output` events
- **File watching**: chokidar on `.farm-status.json` for external writes (bash script coexistence)
- **Auto-bootstrap**: if `.farm-status.json` doesn't exist on startup, gateway runs `fleetRefresh()` to scan pool configs via SSH

## Agent Conventions

- **Minimal deps**: `ws` + `@farmslot/protocol` only
- **Commands**: `exec`, `tmux.capture`, `tmux.send`, `tmux.stream.start/stop`, `fs.read`, `fs.write`, `health.check`
- **Reconnect**: auto-reconnect to gateway with exponential backoff
- **Identity**: machine name + token (simple, no crypto for v1)
- **Deployment**: must be buildable into standalone bundle for remote machines
