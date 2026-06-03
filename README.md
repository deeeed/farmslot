# farmslot

Project-agnostic orchestration for dispatching autonomous coding agents to a fleet of machines.

> Why the name? I know. It stuck: agentic dev farming across many isolated slots. Naming is harder than scheduling the agents.

> [!WARNING]
> **Active development preview.** Farmslot is moving quickly while the product is finalized in
> this repo. Expect experimental features, rough edges, changing APIs, large/transient files, and
> docs that may lead the implementation in some areas. Use it as an early operator/developer tool,
> not as a stable production dependency yet.

## What it does

Manages a pool of machines (local or remote), each with one or more **slots** — isolated environments where an AI coding agent runs a task autonomously. Handles the full lifecycle: prepare, dispatch, monitor, recycle.

```
farmslot/
  packages/cli/      # `farmslot` CLI for gateway, fleet, slot, dispatch, and RPC control
  scripts/           # Lower-level lifecycle scripts used by the gateway and CLI
  pool/              # Machine registry — slots, ports, devices
  projects/          # Project configs (separate git repos, user-managed)
    <name>-farm/
      project.json   # Hooks, health checks, fixture mappings
      fixtures/      # Env templates, config files, test data
      templates/     # Task templates (worker + orchestrator)
  docs/              # Architecture, protocols, reference
```

## Try it

The repo includes a localhost pool config with a fake runner for testing:

```bash
# Start gateway + Command Center
bash scripts/dev.sh

# Open http://localhost:7777 — the fleet view shows demo-ff-1 in "ready" state
# In another terminal, use the CLI against the local gateway:
yarn workspace @farmslot/cli farmslot fleet status
```

## Quick start

`farmslot` is the public control entrypoint. It talks to a gateway over WebSocket, so it can be used from the repo, another checkout, or an agent shell as long as the gateway URL is reachable.

```bash
# See fleet status
farmslot fleet status

# Deep-check a specific slot
farmslot slot check demo-ff-1

# Prepare or recycle a slot
farmslot slot prepare demo-ff-1
farmslot slot release demo-ff-1 --keep-warm

# Preview dispatch routing
farmslot dispatch preview --project my-app-farm --flow-type fix-bug --ticket APP-123

# Call any gateway method directly
farmslot rpc fleet.status '{}'
```

Use `--url ws://host:7777` to target a different gateway and `--json` for machine-readable output.

## Slot lifecycle

```
ready ──> dispatching ──> working ──> recycling ──> ready
```

| CLI command                  | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `farmslot fleet status`      | Fleet-wide overview of machines, slots, health, and current runs.       |
| `farmslot slot check <id>`   | Read-only deep health check for one slot.                               |
| `farmslot slot prepare <id>` | Sync fixtures, checkout branch, run preflight.                          |
| `farmslot dispatch ...`      | Preview or execute task dispatch through gateway policy.                |
| `farmslot slot release <id>` | Collect artifacts, clean up, and optionally re-prepare with `--keep-warm`. |
| `farmslot rpc <method>`      | Raw gateway escape hatch for protocol methods and agent integrations.   |

The `scripts/*.sh` lifecycle commands still exist as lower-level building blocks for the gateway, CLI, and local debugging. Prefer the CLI for normal operation.

## Adding a project

Each project is a separate git repo inside `projects/`:

```bash
cd projects/
mkdir my-app-farm && cd my-app-farm
git init
```

Create `project.json`:

```json
{
  "name": "my-app-farm",
  "default_branch": "main",
  "hooks": {
    "preflight": "npm install && npm start &",
    "health_check": "curl -s http://localhost:{{METRO_PORT}}/health",
    "dev_server_check": "lsof -i :{{METRO_PORT}} >/dev/null 2>&1"
  },
  "health": {
    "ready_indicator": "ok",
    "parse_health": "python3 -c \"import json,sys; print(json.load(sys.stdin).get('status',''))\"",
    "dev_server_name": "DevServer"
  },
  "fixtures": {
    "templates": [{ "src": ".env.template", "dst": ".env", "vars": ["PORT"] }],
    "files": []
  },
  "platforms": {}
}
```

Then reference it in your pool JSON:

```json
{ "machine": "my-server", "project": "my-app-farm", ... }
```

No lifecycle script changes needed.

## Adding a machine

Create `pool/<machine>.json`:

```json
{
  "machine": "my-server",
  "project": "my-app-farm",
  "platform": "linux",
  "host": "my-server.local",
  "ssh_user": "deploy",
  "dispatch_cmd": "cd {repo} && {claude_path} --dangerously-skip-permissions",
  "slots": [
    {
      "id": "my-server-1",
      "repo": "~/dev/my-app",
      "metro_port": 3000,
      "session": "my-server-1",
      "slot_vars": { "PORT": "3000" }
    }
  ]
}
```

## Development (multi-worktree)

Multiple farmslot worktrees can run dev servers simultaneously using per-worktree port config.

**Setup:**

1. Copy `.env.ports.example` to `.env.ports` at the repo root
2. Set unique ports per worktree (main worktree uses defaults, no file needed):
   ```bash
   GATEWAY_PORT=7778
   VITE_PORT=5175
   ```
3. Start: `bash scripts/dev.sh` (required — running `yarn dev` directly won't load port overrides)

**Port allocation:**

| Worktree | Gateway | Vite UI |
| -------- | ------- | ------- |
| main     | 7777    | 5174    |
| farm     | 7778    | 5175    |
| (next)   | 7779    | 5176    |

**Limitations:** Remote node agents connect to one gateway only (the main one on 7777). The worktree gateway gets fleet data via SSH-based refresh on first boot, but won't have real-time node connections — so live exec and tmux streaming only work on the main gateway.

## Architecture

See [docs/README.md](docs/README.md) and [docs/adr/](docs/adr/) for the full design.

Key decisions:

- **Pool JSON owns machine config** — SSH, ports, devices
- **Project JSON owns app config** — how to boot, health-check, recycle
- **Scripts are project-agnostic** — all project-specific logic comes from `project.json`
- **Local slots run without SSH** — auto-detected via hostname
- **Project configs are separate git repos** — each `projects/<name>-farm/` is independently tracked

## Monorepo package boundaries

Farmslot separates product surfaces, runtime services, and reusable toolkit packages:

- `apps/*` contains user-facing product surfaces:
  - `apps/command-center` — web control surface plus repo-level quality scripts.
  - `apps/companion` — mobile companion app.
  - `apps/docs` — Docusaurus reader-facing documentation site.
- `services/gateway` and `services/node` are long-running runtime services: Gateway owns control-plane orchestration; Node owns machine-local capabilities.
- Other `packages/*` entries are shared libraries or CLIs: protocol contracts, recipe tooling, theming, Expo recipe support, and the Farmslot CLI.
- Keep code with its owner. UI-only code belongs under the app that renders it; reusable protocol/toolkit code belongs under a package; service/runtime policy belongs in Gateway; machine-local execution belongs in Node.
- Keep package names stable when moving implementation roots. Workspace location communicates repository ownership; the `@farmslot/*` package name communicates import/runtime identity.

---

Created by [Arthur Breton](https://siteed.net)
