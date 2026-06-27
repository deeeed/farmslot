# Runner Validation Harness

Farmslot-owned tmux validation for **runner capability and interaction** differences. Use this when upgrading Claude/Codex/Grok/Cursor, debugging send-keys regressions, or proving ADR-032 hook contracts on fleet machines.

Implementation: `scripts/runner-validation/`

## Validation (live tmux E2E)

```bash
# Primary proof — live tmux only
bash scripts/e2e-tmux-runner-validate.sh
```

## Quick start

```bash
# Event-driven runners (hooks.jsonl + tmuxPane)
node scripts/runner-validation/run.mjs --runner hooks --scenario hook-smoke

# Pane-only runners (pane output, no hooks)
node scripts/runner-validation/run.mjs --runner pane-only --scenario pane-smoke

# Grok production-parity (interactive TUI + project-directory + compose submit)
node scripts/runner-validation/run.mjs --runner grok --scenario interaction-smoke

# Full matrix (skips apply per runner/scenario)
node scripts/runner-validation/run.mjs --runner all --scenario all
```

Evidence JSON: `docs/operations/evidence/runner-validate-<host>-<runner>-<scenario>.json`

Wired into `scripts/e2e-tmux-runner-validate.sh` and `scripts/run-runner-observability-gate.sh`: `hook-smoke` (Claude + Codex, committed evidence), **grok `pane-smoke`**, and **grok `interaction-smoke`** (local temp dir only). Add `--runner pane-only` to include Cursor when it becomes fleet-default.

## Runner groups

| `--runner` | Runners | Observability |
|------------|---------|---------------|
| `hooks`, `both` | claude, codex | `event-driven` — Farmslot hooks + `hooks.jsonl` |
| `pane-only` | cursor, grok | `pane-only` — tmux capture, no hook installer |
| `all` | claude, codex, cursor, grok | mixed |
| `grok`, `cursor`, … | single runner | per adapter |

Registry source of truth: `services/gateway/src/runners/registry.ts` (`observabilityScope`, `needsPostLaunchPrompt`).

## Scenarios

| Scenario | Proves | Claude/Codex | Cursor | Grok |
|----------|--------|--------------|--------|------|
| `hook-smoke` | SessionStart + UserPromptSubmit + Stop + `tmuxPane` | live tmux | skip | skip |
| `pane-smoke` | Launch + response marker in pane | skip | `--print --trust` | `-p` single-turn |
| `interaction-smoke` | Post-launch TUI flow (blockers + compose) | skip | skip | **interactive** launch |
| `prompt-accepted` | Sentinel digest ↔ UserPromptSubmit | live | skip | skip |
| `turn-boundary` | Stop after UserPromptSubmit | live | skip | skip |
| `busy-composer` | Busy pane regex fixtures | fixtures | skip | skip |
| `mode-switch` | Bypass / permission mode | live | skip | skip |

Skipped scenarios record `skipReason` and count as pass so matrices stay honest.

## Per-runner launch adapters

Encoded in `scripts/runner-validation/runners/<id>.mjs` — **not** shared assumptions.

### Claude (`event-driven`)

- Interactive `❯` compose often **does not submit** on single Enter in tmux.
- Reliable smoke: shell pane + `claude --dangerously-skip-permissions -p '<prompt>'`.

### Codex (`event-driven`)

- Bare tmux lacks shell `codex` function — use full `node …/codex.js`.
- Requires `git init`; isolated `CODEX_HOME={{runtime_dir}}/codex-home` with canonical `trusted_hash` (realpath-safe paths on macOS).
- Smoke: `codex exec --disable plugin_hooks --sandbox workspace-write '<prompt>'`.

### Grok (`pane-only`) — priority runner

Grok is interactive-first in production (`needsPostLaunchPrompt: true`). The harness exposes **two** validated paths:

1. **`pane-smoke` (fast):** `grok -p '<prompt>' --model grok-build` — single-turn, tmux shell, proves binary + network + marker response.
2. **`interaction-smoke` (production-parity):** launch `grok --model grok-build`, auto-resolve project-directory prompt (`Enter` on current repo), submit prompt via tmux compose, wait for marker. Matches gateway `detectRunnerLaunchBlocker` / `grok-select-current-project` behavior.

Improvement backlog for Grok:

- Pane fixtures for busy/interjection states (like Claude `busy-composer`).
- Optional transcript/session file assertions under `~/.grok/sessions`.
- Wire `interaction-smoke` into CI gate once flake rate is measured.

### Cursor (`pane-only`)

- Gateway launches with argv prompt (`needsPostLaunchPrompt: false`).
- **`pane-smoke`:** `cursor-agent --print --trust --sandbox enabled` for scriptable tmux validation.
- Workspace-trust blocker patterns live in `pane-state.sh` (scoped by runner id); harness `lib/pane-blockers.mjs` delegates there.

## Architecture

```
scripts/runner-validation/
  runners/          # launch adapters + skipReason + observabilityScope
  scenarios/        # executable contracts (one file per scenario)
  lib/              # tmux driver, hooks, digest, pane blockers, evidence
  fixtures/panes/   # static pane snippets (busy-composer)
  run.mjs           # orchestrator
  run.test.mjs      # static/unit tests
```

Tmux driver delegates to [.agents/skills/tmux-model-driver](../../.agents/skills/tmux-model-driver/SKILL.md) scripts — no duplicated blocker or launch-script logic in harness `lib/`. Harness-specific launch adapters live in `runners/`; when empirical findings change, update the skill first, then runner adapters. Long launch lines go through skill `send-shell-script.sh` (writes `.tmux-driver-launch.sh` in the temp repo) to avoid `send-keys` line-wrap bugs.

## Related docs

- [ADR-032 runner validation addendum](../adr/032-runner-observability-via-hooks.md#runner-validation-harness-2026-06-27-addendum)
- [Runner observability empirical gate](./runner-observability-empirical-gate.md)
- [Phase 1 plan](../plans/runner-observability-hooks-phase1.md)