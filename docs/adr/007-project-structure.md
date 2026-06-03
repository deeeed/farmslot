# ADR-007: Project Structure

**Status:** Accepted
**Date:** 2026-03-26
**Relates to:** [PRD](../PRD-command-center-canonical.md), [ADR-001](001-gateway-architecture.md), [ADR-008](008-remote-communication.md)

## Context

The Command Center introduces three new codebases:

1. **Gateway** — Node.js WebSocket server + fleet logic
2. **Node Agent** — Lightweight daemon deployed to each machine
3. **UI** — Lit.js SPA served by gateway

Plus a shared **protocol** package consumed by all three.

These live alongside the existing farmslot repo (scripts, pool configs, project configs, docs). The structure must support:

- Clean imports between packages (protocol shared by 3 consumers)
- Independent deployment of the agent (goes to remote machines with minimal deps)
- Simple dev experience (single install, one command to run)
- Extensibility without over-engineering

## Options Considered

### A. Single `apps/command-center/` Directory (Flat)

One directory, one `package.json`, no workspaces.

**Pros:** Simplest setup
**Cons:** Protocol imports via relative paths (`../../../protocol/`), agent can't be deployed independently without pulling all deps, no dep boundary enforcement

### B. Yarn Workspaces Monorepo

```
apps/command-center/
  package.json          # Root workspace config
  packages/
    protocol/           # @farmslot/protocol — shared types
    gateway/            # @farmslot/gateway — server
    agent/              # @farmslot/agent — node agent
  ui/                   # Vite SPA (own build, like OpenClaw)
```

**Pros:**

- Clean imports: `import { SlotStatus } from '@farmslot/protocol'`
- Agent has own package.json with minimal deps (ws + protocol only)
- Dep boundaries enforced — no Lit/Monaco leaking into agent
- Single `yarn install` at root
- Extensible — adding a new package (e.g., `@farmslot/cli`) is just a new dir

**Cons:**

- More config files (per-package package.json, tsconfig)
- Workspace resolution quirks (hoisting, peer deps)
- Slightly more complex than flat structure

### C. pnpm Workspaces (OpenClaw Pattern)

Same structure as B but with pnpm.

**Pros:** Strict dep isolation, aligned with OpenClaw
**Cons:** Less familiar, different lockfile format

## Decision

**Option B — Yarn Workspaces Monorepo.**

### Rationale

Three consumers of the protocol package (gateway, agent, UI) is the tipping point where workspace imports (`@farmslot/protocol`) become clearly better than relative paths. The agent's independent deployment requirement makes a package boundary essential — it must install with just `ws` and protocol, not the full gateway + Monaco + Lit dep tree.

Yarn over pnpm: familiarity and existing workflow preference. Both work well for this scale.

### Structure

```
farmslot/
  scripts/                  # Existing bash scripts (kept during migration)
  pool/                     # Pool configs
  projects/                 # Project configs
  docs/
    adr/                    # Architecture decision records
    PRD-command-center-canonical.md
    ROADMAP.md
  apps/command-center/
    package.json            # Yarn workspace root
    yarn.lock
    tsconfig.base.json      # Shared compiler options
    packages/
      protocol/
        package.json        # @farmslot/protocol
        tsconfig.json       # extends ../../tsconfig.base.json
        src/
          index.ts
          frames.ts         # req/res/event frame types
          types.ts          # SlotStatus, FleetStatus, PRStatus, etc.
          methods.ts        # RPC method names + param/result types
          events.ts         # Event names
      gateway/
        package.json        # @farmslot/gateway — deps: ws, chokidar, @farmslot/protocol
        tsconfig.json
        src/
          index.ts          # Entry point — starts HTTP + WS server
          server.ts         # WebSocket server + method dispatch
          state.ts          # Fleet state (in-memory + JSON snapshot)
          machine-registry.ts  # Connected agent tracking
          methods/          # RPC method handlers
            fleet.ts
            slot.ts
            dispatch.ts
            terminal.ts
            pr.ts
            config.ts
            decisions.ts
      agent/
        package.json        # @farmslot/agent — deps: ws, @farmslot/protocol (minimal)
        tsconfig.json
        src/
          index.ts          # Entry point — connects to gateway, handles commands
          commands/
            exec.ts         # Shell command execution
            tmux.ts         # tmux capture, send-keys, PTY stream
            fs.ts           # File read/write/sync
            health.ts       # Health check execution
        install.sh          # One-liner install for remote machines
    ui/
      package.json          # deps: lit, @xterm/xterm, monaco-editor, @farmslot/protocol
      tsconfig.json
      vite.config.ts
      index.html
      src/
        main.ts
        gateway-client.ts
        state.ts
        components/
          app-shell.ts
          fleet-map/
          terminal/
          dispatch/
          pr-dashboard/
          decisions/
          diff-viewer/
          shared/
```

### Workspace Configuration

**Root `package.json`:**

```json
{
  "private": true,
  "workspaces": ["packages/*", "ui"],
  "scripts": {
    "dev": "concurrently \"yarn workspace @farmslot/gateway dev\" \"yarn workspace @farmslot/command-center-ui dev\"",
    "dev:gateway": "yarn workspace @farmslot/gateway dev",
    "dev:ui": "yarn workspace @farmslot/command-center-ui dev",
    "build": "yarn workspaces foreach -t run build",
    "start": "yarn workspace @farmslot/gateway start"
  }
}
```

**Protocol `package.json`:**

```json
{
  "name": "@farmslot/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

No build step for protocol — consumers compile it directly via TypeScript project references or bundler resolution. Keeps it simple.

**Agent `package.json`:**

```json
{
  "name": "@farmslot/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "ws": "^8.18.0",
    "@farmslot/protocol": "workspace:*"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --dts"
  }
}
```

Minimal deps. Can be built into a standalone bundle via `tsup` or `bun build` for deployment to remote machines.

### Agent Deployment

The agent package deploys independently to remote machines:

```bash
# Option 1: Bundle and copy
cd apps/command-center
yarn workspace @farmslot/agent build   # → packages/agent/dist/index.js
scp packages/agent/dist/index.js runner-a:~/farmslot-agent/
ssh runner-a "node ~/farmslot-agent/index.js"

# Option 2: Gateway serves agent bundle at /agent/
# Machine downloads and runs it:
curl http://runner.local:7777/agent/bundle.js -o ~/farmslot-agent/index.js
node ~/farmslot-agent/index.js --gateway ws://runner.local:7777

# Option 3: Full copy (dev mode)
scp -r packages/agent/ runner-a:~/farmslot-agent/
ssh runner-a "cd ~/farmslot-agent && yarn install && yarn start"
```

### Shared TypeScript Config

**`tsconfig.base.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "lib": ["ES2022"]
  }
}
```

Each package extends this and adds its specifics (e.g., UI adds `"lib": ["DOM"]`, `"experimentalDecorators": true`).

## Consequences

**Positive:**

- Clean imports via `@farmslot/protocol` — no relative path counting
- Agent deploys independently with minimal deps
- Dep boundaries enforced — gateway deps don't leak to agent
- Standard yarn workspace pattern — familiar, well-documented
- Extensible — new packages (CLI, shared utils) are just a new directory

**Negative:**

- More config files than flat structure (4 package.json, 4 tsconfig.json)
- Workspace hoisting can occasionally cause resolution issues
- Protocol changes require awareness that 3 consumers are affected

## References

- OpenClaw structure: pnpm workspace with `src/`, `ui/`, `packages/` (similar pattern, different tool)
- Yarn workspaces: https://yarnpkg.com/features/workspaces
