# Runner Observability Empirical Gate (ADR-032 Phase 1)

Run this gate on **runner-local**, **mini**, and **runner-a** before enabling hook telemetry fleet-wide.

## Runner validation harness (per-runner tmux scenarios)

Farmslot ships a runner-specific validation harness under `scripts/runner-validation/`. Each runner adapter owns launch quirks (Claude print mode, Codex `CODEX_HOME` + `exec`, etc.); scenarios assert hook/pane contracts:

| Scenario | What it proves |
|----------|----------------|
| `hook-smoke` | `SessionStart` + `UserPromptSubmit` + `Stop`, `tmuxPane` present |
| `prompt-accepted` | `UserPromptSubmit.runnerPromptDigest` matches gateway sentinel |
| `turn-boundary` | `Stop` timestamp ≥ `UserPromptSubmit` |
| `busy-composer` | Pane busy regex on fixtures (Claude); skipped for Codex |
| `mode-switch` | Bypass permission mode visible in hook or pane (Claude); skipped for Codex |

```bash
# Hook runners (ADR-032)
node scripts/runner-validation/run.mjs --runner hooks --scenario hook-smoke

# Pane-only runners (Cursor, Grok)
node scripts/runner-validation/run.mjs --runner pane-only --scenario pane-smoke

# Grok production-parity interaction path
node scripts/runner-validation/run.mjs --runner grok --scenario interaction-smoke

# Full matrix
node scripts/runner-validation/run.mjs --runner all --scenario all
```

See [runner-validation-harness.md](./runner-validation-harness.md) for scenario matrix and per-runner launch rules.

`scripts/run-adr032-phase1-gate.sh` runs hook-smoke (Claude + Codex), **grok pane-smoke**, and **grok interaction-smoke** live in tmux, plus static busy-composer fixtures.

Evidence JSON: `docs/operations/evidence/runner-validate-<host>-<runner>-<scenario>.json`

## Probe

```bash
# Claude (Phase 1)
node scripts/probe-runner-observability.mjs \
  --runner claude \
  --slot-id <slot-id> \
  --repo <slot-repo-path> \
  --runtime-dir .agent \
  --out /tmp/observability-gate-<host>-claude.json

# Codex (Phase 1.5)
node scripts/probe-runner-observability.mjs \
  --runner codex \
  --slot-id <slot-id> \
  --repo <slot-repo-path> \
  --runtime-dir .agent \
  --out /tmp/observability-gate-<host>-codex.json

# Full local gate bundle (probes + unit tests + agreement-window harness)
bash scripts/run-adr032-phase1-gate.sh
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
