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

# Grok dispatch parity (gateway sendRunnerPostLaunchPrompt — same path as run dispatch)
node scripts/runner-validation/run.mjs --runner grok --scenario dispatch-prompt-smoke --keep-session

# Grok MCP race repro (fixture + live force-fail + gateway fix pass)
node scripts/runner-validation/run.mjs --runner grok --scenario dispatch-prompt-mcp-race --timeout-ms 180000

# Full matrix (skips apply per runner/scenario)
node scripts/runner-validation/run.mjs --runner all --scenario all
```

Evidence JSON: `docs/operations/evidence/runner-validate-<host>-<runner>-<scenario>.json`

Wired into `scripts/e2e-tmux-runner-validate.sh` and `scripts/run-runner-observability-gate.sh`: `hook-smoke` (Claude + Codex, committed evidence), **grok `pane-smoke`**, and **grok `interaction-smoke`** (local temp dir only). Add `--runner pane-only` to include Cursor when it becomes fleet-default.

## Runner groups

| `--runner`          | Runners                     | Observability                                                                                           |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `hooks`, `both`     | claude, codex               | `event-driven` — Farmslot hooks + `hooks.jsonl`                                                         |
| `pane-only`         | cursor, grok                | tmux activity capture; Grok additionally exposes native exact-prompt acceptance, with no hook installer |
| `all`               | claude, codex, cursor, grok | mixed                                                                                                   |
| `grok`, `cursor`, … | single runner               | per adapter                                                                                             |

Registry source of truth: `services/gateway/src/runners/registry.ts` (`observabilityScope`, `needsPostLaunchPrompt`).

## Scenarios

| Scenario                    | Proves                                                    | Claude/Codex | Cursor            | Grok                   |
| --------------------------- | --------------------------------------------------------- | ------------ | ----------------- | ---------------------- |
| `hook-smoke`                | SessionStart + UserPromptSubmit + Stop + `tmuxPane`       | live tmux    | skip              | skip                   |
| `pane-smoke`                | Launch + response marker in pane                          | skip         | `--print --trust` | `-p` single-turn       |
| `interaction-smoke`         | Post-launch TUI flow (blockers + compose)                 | skip         | skip              | **interactive** launch |
| `dispatch-prompt-smoke`     | Gateway `sendRunnerPostLaunchPrompt` (dispatch parity)    | skip         | skip              | **interactive** launch |
| `dispatch-prompt-mcp-race`  | MCP init race: fixture repro + live force-fail + fix pass | skip         | skip              | **interactive** launch |
| `dispatch-prompt-trust`     | Directory-trust / project-directory + classifier send_yes | skip         | skip              | **fixture**            |
| `prompt-accepted`           | Sentinel digest ↔ UserPromptSubmit                        | live         | skip              | skip                   |
| `turn-boundary`             | Stop after UserPromptSubmit                               | live         | skip              | skip                   |
| `busy-composer`             | Busy pane regex fixtures                                  | fixtures     | skip              | skip                   |
| `mode-switch`               | Bypass / permission mode                                  | live         | skip              | skip                   |
| `session-attribution-smoke` | Stale session rejected; hook path + model match           | live tmux    | skip              | live tmux              |
| `token-usage-smoke`         | Live `session-usage.sh` on resolved path + model match    | live tmux    | skip              | live tmux              |

Skipped scenarios record `skipReason` and count as pass so matrices stay honest.

## Validation ladder

| Level | What                                                           | Where                                                                                    |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L0    | Runner registry (`observabilityScope`, `persistsSessionFiles`) | `services/gateway/src/runners/registry.ts`                                               |
| L1    | Token extraction fixtures (per-runner invariants)              | `services/gateway/src/runtime/session-usage-script.test.ts` → `scripts/session-usage.sh` |
| L2    | Session path + binding unit tests                              | `services/gateway/src/runners/session-path-resolution.test.ts`, harness `run.test.mjs`   |
| L3    | Tmux scenarios (hooks, attribution, tokens)                    | `scripts/runner-validation/scenarios/`                                                   |
| L4    | Full matrix gate                                               | `scripts/e2e-tmux-runner-validate.sh`                                                    |
| L5    | Manual runner upgrade check                                    | [runner-token-usage.md](../reference/runner-token-usage.md) § Validation protocol        |

Do not duplicate token parsing in harness JS — scenarios call `scripts/session-usage.sh` via `lib/session-usage-harness.mjs` (same env contract as L1).

## Session binding + attribution

Gateway binding priority (`session-path-resolution.ts`, `session-process.ts`):

| #   | Signal                                                                                                         | Runners                    |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Hook `SessionStart` → `transcript_path` + `session_id`, filter `tmuxPane` + `slotId` + `observedAt ≥ dispatch` | claude, codex              |
| 2   | Set diff `afterPaths − beforePaths`                                                                            | claude, codex, grok        |
| 3   | mtime ≥ dispatch (`sinceMs`, 60s slack) — filter only, never newest-alone                                      | all persisting             |
| 4   | `unavailable`                                                                                                  | cursor, scripted, opencode |

| Runner | Persists session | Path source                             | `session-attribution-smoke` | `token-usage-smoke` |
| ------ | ---------------- | --------------------------------------- | --------------------------- | ------------------- |
| claude | yes              | hook `transcript_path`                  | required (E2E)              | required (E2E)      |
| codex  | yes              | hook or slot `CODEX_HOME/.../*.jsonl`   | required (E2E)              | required (E2E)      |
| grok   | yes              | `~/.grok/sessions/<realpath-repo>/` dir | required (E2E)              | required (E2E)      |
| cursor | no               | —                                       | skip                        | skip                |

### `session-attribution-smoke` pass criteria

1. Stale pre-seeded session exists before dispatch.
2. Resolved path ≠ stale path.
3. **Event-driven:** hook `SessionStart.transcript_path` === resolved path; `tmuxPane` === pane id.
4. **`modelsMatch(dispatchedModel, modelFromTranscript(...))`** — e.g. dispatch `opus`, transcript `claude-opus-*`.
5. Stale seed would mismatch dispatched model.

### `token-usage-smoke` pass criteria

1. Resolve session path (same binding as attribution).
2. Poll `bash scripts/session-usage.sh <slot> total` with `RUNNER_SESSION_PATH` / `RUNNER_SESSION_RUNNER` (see `lib/session-usage-harness.mjs`).
3. `turns >= 1`, `total_tokens > 0`, `input_tokens` / `output_tokens` present.
4. **`modelsMatch(dispatchedModel, usage.model)`** from script stdout.

Evidence: `docs/operations/evidence/runner-validate-<host>-<runner>-{session-attribution,token-usage}-smoke.json`

## Per-runner launch adapters

Encoded in `scripts/runner-validation/runners/<id>.mjs` — **not** shared assumptions.

### Claude (`event-driven`)

- Interactive `❯` compose often **does not submit** on single Enter in tmux.
- Reliable smoke: shell pane + `claude --dangerously-skip-permissions -p '<prompt>'`.

### Codex (`event-driven`)

- Bare tmux lacks shell `codex` function — use full `node …/codex.js`.
- Requires `git init`; isolated `CODEX_HOME={{runtime_dir}}/codex-home` with canonical `trusted_hash` (realpath-safe paths on macOS).
- Smoke: `codex exec --disable plugin_hooks --sandbox workspace-write '<prompt>'`.

### Grok (pane-backed activity + native prompt acceptance) — priority runner

Grok is interactive-first in production (`needsPostLaunchPrompt: true`). The harness exposes **two** validated paths:

1. **`pane-smoke` (fast):** `grok -p '<prompt>' --model grok-4.5` — single-turn, tmux shell, proves binary + network + marker response.
2. **`interaction-smoke` (production-parity):** launch `grok --model grok-4.5`, auto-resolve project-directory prompt (`Enter` on current repo), submit prompt via tmux compose, wait for marker. Matches gateway `detectRunnerLaunchBlocker` / `grok-select-current-project` behavior.

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

Tmux driver delegates to [.agents/skills/tmux-model-driver](../../.agents/skills/tmux-model-driver/SKILL.md) scripts — no duplicated blocker or launch-script logic in harness `lib/`. Harness-specific launch adapters live in `runners/`; when empirical findings change, update the skill first, then runner adapters. Long launch lines go through skill `send-shell-script.sh`, which stages a private self-cleaning script outside the checkout to avoid `send-keys` line-wrap bugs without dirtying the repo.

## Related docs

- [ADR-032 runner validation addendum](../adr/032-runner-observability-via-hooks.md#runner-validation-harness-2026-06-27-addendum)
- [Runner observability empirical gate](./runner-observability-empirical-gate.md)
- [Runner token usage extraction](../reference/runner-token-usage.md) — extraction contracts + manual `TOKEN_CHECK_OK` protocol
- [Phase 1 plan](../plans/runner-observability-hooks-phase1.md)
