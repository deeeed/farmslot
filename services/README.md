# Farmslot services

`services/` contains long-running Farmslot runtime processes. Service package names stay in the `@farmslot/*` scope; the folder communicates runtime ownership, not import identity.

| Service    | Package name        | Owns                                                                                                |
| ---------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `gateway/` | `@farmslot/gateway` | Local control-plane API, run orchestration, fleet projection, worker streams, review/CI automation. |
| `node/`    | `@farmslot/node`    | Machine-local remote agent capabilities: exec, files, tmux/screen, resource watching, metrics.      |

## Maintenance rules

1. Keep service code under its service root; shared contracts and reusable toolkit code belong in `packages/*`.
2. Keep Gateway policy-oriented and Node capability-oriented.
3. Keep service package names stable across folder moves.
4. Every service has a README with `## Source layout`, `## Maintenance rules`, and `## Local quality` sections that explain ownership, source layout, quality commands, and what does not belong there.
5. Every service must expose `typecheck`, `test`, and `quality` scripts.
6. Run service validation before committing service changes:

```bash
yarn workspace @farmslot/gateway quality
yarn workspace @farmslot/node quality
```
