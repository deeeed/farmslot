# `@farmslot/gateway`

Gateway is the local control-plane service for Farmslot. It owns the WebSocket/HTTP API, fleet state projection, run lifecycle orchestration, worker terminal streams, CI/review automation, and the persistence stores needed by Command Center.

The package is intentionally organized by ownership domains. Keep `src/` itself limited to runtime entrypoints:

- `src/index.ts` — daemon startup and service wiring.
- `src/server.ts` — WebSocket server lifecycle and event broadcasting.
- `src/webhook.ts` — webhook entrypoint.

## Source layout

| Directory               | Owns                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `agents/`               | Agent context records, role/context target resolution.               |
| `automation/`           | Background automation such as branch watching and auto-recycle.      |
| `backlog/`              | Manual backlog store and dispatch queue.                             |
| `chat/`                 | Command Center copilot sessions, tools, screen evidence, memory.     |
| `copilot-runtime/`      | Singleton tmux Co-Pilot lifecycle, transcript, safety, and audit.    |
| `ci-monitor/`           | CI watch state, inline-fix flow, CI monitor service.                 |
| `core/`                 | Low-level config, hooks, shell/tmux helpers, artifact primitives.    |
| `evals/`                | Eval package and suite-cap persistence.                              |
| `family-observability/` | Family snapshots, reports, lineage, change ledgers.                  |
| `fleet/`                | Fleet/pool state, machine registry, node RPC, resources, pairing.    |
| `integrations/`         | External service adapters and bindings caches.                       |
| `intelligence/`         | Improvement/intelligence engines.                                    |
| `live-recipe/`          | Live recipe artifact discovery and context selection.                |
| `llm/`                  | LLM auth/config/tool-trace provider glue.                            |
| `methods/`              | RPC method handlers; should stay thin and delegate to owner modules. |
| `observability/`        | Gateway log, thumbnail, and fleet monitor utilities.                 |
| `projects/`             | Repo/project root resolution and start-ref policy.                   |
| `quality/`              | Review, recipe-quality, and PR evidence quality checks.              |
| `run-completion/`       | Completion/publish/retrospective artifact pipeline.                  |
| `run-engine/`           | Run orchestration steps and monitor lifecycle.                       |
| `runners/`              | Runner registry, launch commands, session detection.                 |
| `runs/`                 | Run store and run record persistence.                                |
| `runtime/`              | PTY, tmux, screen, script-runner, session usage plumbing.            |
| `security/`             | Gateway auth and bind-policy checks.                                 |
| `self-review/`          | Self-review loops and review-worker lifecycle.                       |
| `server/`               | Frame routing helpers and connection-local server state.             |
| `tasks/`                | Task file writing, worker signals, template options, watchers.       |

## Maintenance rules

1. **Top-level files are entrypoints only.** New code belongs in an ownership directory.
2. **Import owners directly.** Avoid convenience barrels for first-party internals; importing from the file that owns the symbol keeps dependencies obvious.
3. **Keep RPC methods thin.** A method handler should parse/check params and call domain code, not become a second owner of business logic.
4. **Keep files under 1,000 LOC by default.** If a file must exceed that, document why in `apps/command-center/CODE_QUALITY.md` first.
5. **Tests live beside owners.** When moving behavior, move or add the matching `*.test.ts` in the same directory.
6. **Run Gateway validation before committing Gateway changes.**

## Local quality

The Co-Pilot runtime defaults to this Farmslot checkout and Codex `gpt-5.6-sol`. Save a different
runner/model and Gateway-autostart policy through `copilot.configure`; the Gateway persists that
choice. `FARMSLOT_OPERATOR_CHECKOUT`, `FARMSLOT_COPILOT_RUNNER`, and `FARMSLOT_COPILOT_MODEL`
remain bootstrap overrides. Dangerous execution still requires the per-start typed confirmation
returned by `copilot.status`.

```bash
yarn workspace @farmslot/gateway quality
```
