# farmslot

[![GitHub stars](https://img.shields.io/github/stars/deeeed/farmslot?style=flat&color=yellow)](https://github.com/deeeed/farmslot/stargazers)

Project-agnostic orchestration for dispatching autonomous coding agents to a fleet of machines.

**Install with one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/deeeed/farmslot/main/install.sh | bash
```

Checks prerequisites, sets up `~/farmslot/`, and ends with a green `farmslot doctor`. On macOS, missing common tools are offered via Homebrew prompts; use `FARMSLOT_AUTO_INSTALL=1` for non-interactive Homebrew installs. Existing `asdf`/`nvm` Node setups are honored, and the standalone `capture-helper` CLI is checked/installed for live evidence capture. If you have [GitHub CLI](https://cli.github.com/) signed in, the installer may ask once to star the repo (`gh repo star deeeed/farmslot`). Multi-project packs can start with `farmslot project add <pack> --no-setup`, then build one farm later with `--project <name>`. [Getting started →](https://farmslot.io/docs/guides/getting-started)

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

After the [one-line install](#farmslot) above, the happy path is three commands
(experimental — `main` moves daily, run `farmslot update` often):

```bash
farmslot project add <pack-dir-or-git-url>   # register a project pack: repos, slots, validation
farmslot doctor                              # green checklist or specific failures with fix hints
farmslot update                              # later: pull latest, migrate pool, re-sync packs
```

Details: [Getting started](https://farmslot.io/docs/guides/getting-started)
/ [docs/operations/onboarding.md](docs/operations/onboarding.md); the pack contract is in
[docs/reference/project-packs.md](docs/reference/project-packs.md), with `packs/example-app/` as the reference pack.

### Try the Command Center from a checkout

```bash
bash scripts/dev.sh
```

Open [http://localhost:7777](http://localhost:7777) to use Command Center with the local scripted-runner demo path. For CLI and agent access, see [Local demo and CLI access](https://farmslot.io/docs/guides/local-demo-and-cli).

### Hosted Command Center → local gateway (wss)

The hosted Command Center at [https://farmslot.io/cc](https://farmslot.io/cc) is served over HTTPS. Since Chrome 150, an HTTPS page cannot open a plaintext `ws://` websocket to a local gateway — it is blocked as mixed content, and the per-site "Insecure content" toggle does not override it. `wss://` is not blocked, so the gateway can serve a locally-trusted TLS websocket instead:

```bash
farmslot certs setup   # one-time: mkcert issues a trusted cert into ~/.farmslot/certs
farmslot up            # detects the cert, serves wss:// on :7778, and hands the hosted CC a wss:// URL
```

`certs setup` requires [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert` on macOS); it installs the local CA so the browser already trusts the cert. After it runs, the hosted Command Center connects to the local gateway again. Without a cert, the gateway stays `ws://`-only and nothing changes (the hosted CC then needs the printed `http://localhost:7777` local UI fallback).

## Learn more

- [Documentation website](https://farmslot.io)
- [What is Farmslot?](https://farmslot.io/docs/intro)
- [Adoption path](https://farmslot.io/docs/guides/adoption-path)
- [Local demo and CLI access](https://farmslot.io/docs/guides/local-demo-and-cli)
- [Gateway API capability surface](https://farmslot.io/docs/reference/gateway-api)
- [Reference integrations](https://farmslot.io/docs/intro#reference-integrations)

## Reference integrations

Farmslot is designed to be project-agnostic: each repository keeps its own runner hooks, fixtures, recipes, and domain actions behind `project.json`. Two useful reference integrations are:

- **AudioLab** — [github.com/deeeed/audiolab](https://github.com/deeeed/audiolab) is a public Expo/React Native monorepo that uses Recipe Protocol v1 to expose app-specific audio and native-module probes through a project-owned recipe runner. It is the best public example for adapting an existing app without moving app semantics into Farmslot core.
- **Farmslot itself** — this repo includes `projects/farmslot-farm/project.json` and `pool/farmslot-demo.json`, so you can dispatch and validate work on this monorepo using the same pool/project model as any imported project. The demo pool is hidden by default so fresh installs only see their own slots; set `FARMSLOT_DEMO_POOL=1` to load it.

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

Resource watches are enabled by default so connected nodes keep the gateway
resource cache fresh. Set `FARMSLOT_RESOURCE_WATCHES=0` or
`FARMSLOT_RESOURCE_WATCHES=false` before starting the gateway to disable them.
At runtime, Command Center's fleet resource view can pause/resume watches and
preview or run idle-resource cleanup through configured project shutdown hooks.

**Setup:**

1. Install deps in the worktree checkout (`yarn install` at repo root). Each worktree has its own `node_modules` — do not symlink from another checkout.
2. Copy `.env.ports.example` to `.env.ports` at the repo root
3. Set unique ports per worktree. The main worktree also requires this explicit
   configuration; local launchers do not fall back to shared ports:
   ```bash
   GATEWAY_PORT=7778
   METRO_PORT=7848
   VITE_PORT=5175
   ```
4. Start: `bash scripts/dev.sh` (required — running `yarn dev` directly won't load port overrides)

**Port allocation:**

| Worktree | Gateway | Metro | Vite UI |
| -------- | ------- | ----- | ------- |
| main     | 7777    | 7677  | 5174    |
| farm     | 7778    | 7848  | 5175    |
| (next)   | 7779    | 7849  | 5176    |

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

Farmslot separates product surfaces, runtime services, and reusable toolkit packages. The high-level rule is: protocols define contracts, harnesses execute recipes, runtime packages operate task directories, skills teach agents, and apps/services render or orchestrate the product.

| Area                      | Owns                                                                                         | Does not own                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/command-center`     | Web control surface and repo-level quality scripts.                                          | Protocol contracts, machine-local execution, reusable package APIs.                        |
| `apps/companion`          | Mobile companion app.                                                                        | Gateway orchestration or project/domain runtime behavior.                                  |
| `apps/docs`               | Docusaurus reader-facing documentation site.                                                 | Source-of-truth contracts unless the referenced spec says so.                              |
| `services/gateway`        | Control-plane orchestration, run state, task rendering, policy, and publication gates.       | Machine-local primitive implementations when Node/capability packages can own them.        |
| `services/node`           | Machine-local capabilities, remote execution plumbing, tmux/screen/file/process integration. | Cross-machine scheduling policy or product UI.                                             |
| `packages/protocol`       | Stable data/RPC/recipe contracts and pure validators.                                        | Recipe execution, task-directory reads, project behavior, or UI rendering.                 |
| `packages/capabilities`   | Shared machine-local primitives used by Node and Gateway fallback paths.                     | Ownership of orchestration policy; Node remains the primary machine-local runtime owner.   |
| `packages/recipe-harness` | Reusable recipe graph execution mechanics and generic adapter helpers.                       | Task closeout, agent instructions, Gateway dispatch, or project-domain semantics.          |
| `packages/agent-runtime`  | Task-local runtime helpers: `mark`, `SIGNAL.json`, terminal contracts, artifact checks.      | Recipe graph execution, protocol schema ownership, or agent skill prose.                   |
| `packages/skills`         | Agent instructions, skill packaging, and installers.                                         | Reusable runtime scripts or protocol validators; delegate those to agent-runtime/protocol. |
| `packages/cli`            | The `farmslot` command-line surface and operator workflows over Gateway APIs.                | Long-running orchestration or machine-local execution.                                     |
| `packages/handoff`        | Portable handoff/report helpers for run context and evidence packaging.                      | App UI rendering or Gateway run-state mutation.                                            |
| `packages/run-bundle`     | Durable run bundle contracts and scrub/export helpers for moving run evidence.               | Live run orchestration, task execution, or UI presentation.                                |
| `packages/expo-recipe`    | Expo/React Native recipe adapter helpers.                                                    | App/domain semantics; those belong in project packs and project runners.                   |
| `packages/theme`          | Shared visual tokens/components for Farmslot-owned surfaces.                                 | Product state, protocol contracts, or runtime behavior.                                    |
| Other `packages/*`        | Narrow reusable libraries with an explicit owner and public surface.                         | One-off app/service code that is not reusable outside its owner.                           |

- Keep code with its owner. UI-only code belongs under the app that renders it; reusable protocol/toolkit code belongs under a package; service/runtime policy belongs in Gateway; machine-local execution belongs in Node.
- Keep package names stable when moving implementation roots. Workspace location communicates repository ownership; the `@farmslot/*` package name communicates import/runtime identity.

---

Created by [Arthur Breton](https://siteed.net)

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=deeeed/farmslot&type=date&legend=top-left)](https://www.star-history.com/#deeeed/farmslot&type=date&legend=top-left)

## License

MIT. See [LICENSE](LICENSE).
