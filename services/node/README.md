# `@farmslot/node`

Node is the remote machine agent for Farmslot. It connects a worker machine back to the Gateway and exposes the small command surface Gateway needs for slot operation: command execution, file access, tmux/screen control, resource watching, and system metrics.

Keep Node focused on machine-local capabilities. It should not own run orchestration, review policy, project selection, or UI state; those belong in Gateway or Command Center.

## Source layout

| Directory   | Owns                                                                |
| ----------- | ------------------------------------------------------------------- |
| `commands/` | Gateway-callable machine operations such as exec, fs, tmux, screen. |
| `index.ts`  | Node process startup, Gateway connection, command dispatch wiring.  |

## Maintenance rules

1. **Commands stay capability-scoped.** Add a command module for a machine capability; do not mix unrelated operations into one file.
2. **Gateway owns policy.** Node may validate inputs and protect the host, but higher-level workflow decisions stay in Gateway.
3. **Prefer explicit command files over barrels.** Import the owner module directly so remote-agent dependencies stay visible.
4. **Tests live beside commands.** Every non-trivial command parser or command behavior needs a colocated `*.test.ts`.
5. **Run Node validation before committing Node changes.**

## Local quality

```bash
yarn workspace @farmslot/node quality
```
