# `@farmslot/cli`

`@farmslot/cli` is the operator command-line client for a running Farmslot Gateway. It owns terminal-friendly commands, table formatting, Gateway WebSocket RPC calls, and local recipe artifact validation helpers.

It does **not** own Gateway behavior, protocol definitions, recipe execution semantics, or project-specific workflows.

## Source layout

| Path                    | Owns                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `bin/`                  | Published `farmslot` executable shim.                                 |
| `src/entry.ts`          | Commander root command and subcommand registration.                   |
| `src/commands/`         | CLI subcommands for fleet, slots, dispatch, PRs, nodes, recipes, RPC. |
| `src/formatters/`       | Human-readable table/detail rendering for CLI output.                 |
| `src/gateway-client.ts` | Auth-aware Gateway WebSocket request/event client.                    |
| `src/output.ts`         | JSON/text output mode helpers.                                        |

## Command groups

- `farmslot fleet ...` — fleet status and refresh.
- `farmslot slot ...` — slot checks, prepare, recycle, release.
- `farmslot dispatch ...` — dispatch preview and task handoff helpers.
- `farmslot pr ...` — PR status/list views.
- `farmslot node ...` — connected Node daemon visibility and deployment helpers.
- `farmslot recipe ...` — recipe validation, local dry-runs, project-hook runs, artifact validation.
- `farmslot rpc ...` — explicit low-level Gateway RPC escape hatch for operators.

## Maintenance rules

1. **Stay client-side.** Add Gateway behavior to `services/gateway`, then call it from the CLI.
2. **Use protocol names.** Prefer `@farmslot/protocol` method/type exports over stringly typed copies.
3. **Keep output modes paired.** New commands should support `--json` for automation and a concise human format for terminal use.
4. **Keep command files scoped.** Add a focused file under `src/commands/` for new command families; do not grow `entry.ts`.
5. **Tests live beside command helpers.** Parser/validation helpers should have colocated `*.test.ts` coverage.

## Local quality

```bash
yarn workspace @farmslot/cli quality
yarn workspace @farmslot/cli test
```
