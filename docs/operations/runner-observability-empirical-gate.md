# Runner Observability Empirical Gate (ADR-032 Phase 1)

Run this gate on **runner-local**, **mini**, and **runner-a** before enabling hook telemetry fleet-wide.

## Probe

```bash
node scripts/probe-runner-observability.mjs \
  --slot-id <slot-id> \
  --repo <slot-repo-path> \
  --runtime-dir .agent \
  --out /tmp/observability-gate-<host>.json
```

## Pass criteria

| Check | Pass |
|-------|------|
| `tmuxPane` field present in recent `hooks.jsonl` lines (probe `tmuxPaneSeenInHooks`) | true |
| Hook writer median latency | < 150 ms |
| Plan-mode hooks still fire | manual: dispatch with plan permission, confirm `hooks.jsonl` advances |
| `PostToolUse` delivery | manual: one tool call, confirm at-least-once events (dedupe by `tool_use_id` in gateway) |

## Artifacts

- Per-host JSON reports: attach to the Phase 1 closeout PR or store under `docs/operations/evidence/` when executing the gate on fleet machines.
- Agreement telemetry: `{{farmslot-root}}/.runs/observability-agreement/agreement-YYYY-MM-DD.ndjson`

## Abort rule

If `$TMUX_PANE` is empty on a representative Claude slot, **stop Phase 1 rollout** and switch de-multiplexing to `{cwd, session_id}` per ADR-032 before installing fixtures broadly.