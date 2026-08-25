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

# Pane-only runners (pane output, no structured observability)
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

Wired into `scripts/e2e-tmux-runner-validate.sh` and `scripts/run-runner-observability-gate.sh`: `hook-smoke` (Claude + Codex, committed evidence) and **grok `interaction-smoke`** (local temp dir only). Add `--runner pane-only` to include Cursor when it becomes fleet-default.

## Runner groups

| `--runner`          | Runners                     | Observability                                          |
| ------------------- | --------------------------- | ------------------------------------------------------ |
| `hooks`, `both`     | claude, codex               | `event-driven` — Farmslot hooks + `hooks.jsonl`        |
| `pane-only`         | cursor                      | tmux activity capture without structured observability |
| `all`               | claude, codex, cursor, grok | mixed                                                  |
| `grok`, `cursor`, … | single runner               | per adapter                                            |

Registry source of truth: `services/gateway/src/runners/registry.ts` (`observabilityScope`, `needsPostLaunchPrompt`).

## Scenarios

| Scenario                            | Proves                                                                 | Claude/Codex | Cursor            | Grok                   |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------ | ----------------- | ---------------------- |
| `hook-smoke`                        | SessionStart + UserPromptSubmit + Stop + `tmuxPane`                    | live tmux    | skip              | skip                   |
| `pane-smoke`                        | Launch + response marker in pane                                       | skip         | `--print --trust` | skip                   |
| `interaction-smoke`                 | Post-launch TUI flow (blockers + compose)                              | skip         | skip              | **interactive** launch |
| `dispatch-prompt-smoke`             | Gateway `sendRunnerPostLaunchPrompt` (dispatch parity)                 | skip         | **interactive**   | **interactive** launch |
| `dispatch-prompt-dropped-enter`     | Buffered prompt recovery after a deterministically omitted submit key  | Codex live   | skip              | skip                   |
| `dispatch-prompt-mcp-race`          | MCP init race: fixture repro + live force-fail + fix pass              | skip         | skip              | **interactive** launch |
| `dispatch-prompt-trust`             | Directory-trust / project-directory + classifier send_yes              | skip         | skip              | **fixture**            |
| `prompt-accepted`                   | Sentinel digest ↔ UserPromptSubmit                                     | live         | skip              | skip                   |
| `review-recovery-terminal-contract` | Runner-agnostic recovery, wait, replay, and slot cleanup (once)        | gateway E2E  | not repeated      | not repeated           |
| `retained-handoff-smoke`            | Retained review delivery: native resume or argv relaunch + task signal | live         | **live argv**     | skip                   |
| `retained-safe-send-smoke`          | Exact retained-session follow-up after activity expiry                 | live         | skip              | live                   |
| `turn-boundary`                     | Stop after UserPromptSubmit                                            | live         | skip              | skip                   |
| `self-review-fix-turn-lease`        | Long tool call renews the self-review fix idle lease                   | live         | skip              | skip                   |
| `busy-composer`                     | Busy pane regex fixtures                                               | fixtures     | skip              | skip                   |
| `mode-switch`                       | Bypass / permission mode                                               | live         | skip              | skip                   |
| `session-attribution-smoke`         | Stale session rejected; hook path + model match                        | live tmux    | skip              | live tmux              |
| `token-usage-smoke`                 | Live `session-usage.sh` on resolved path + model match                 | live tmux    | skip              | live tmux              |
| `monitor-stuck-smoke`               | Live cursor-agent TUI does not stuck-nudge while the process is alive  | skip         | **interactive**   | skip                   |

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

## Self-review result contract

Every self-review context launched through `runReviewAgent`—ordinary self-review and
publication-gate reviewers alike—receives `reviewResultFile` and writes two scoped artifacts before
its terminal signal:

- `artifacts/review-feedback.<context>.md` — human-readable analysis.
- `artifacts/review-result.<context>.json` — authoritative verdict and issue list.

The JSON schema is deliberately small: `schemaVersion: 1`, `verdict: "pass" | "issues"`, and
`issues: Array<{ file, line?, description }>`. A pass has no issues; an issues verdict has at least
one. For those contexts, the terminal contract requires both files and the JSON is authoritative;
Markdown formatting is not positive evidence for the verdict. Legacy in-flight contexts without
`reviewResultFile` may still use the legacy Markdown parser during migration.

Restart recovery distinguishes waiting from terminal-invalid state. Active partial writes remain
recoverable. Once completion is established by a successful `complete`/`done` signal or reviewer
process/window completion, a missing or invalid structured result is stable: recovery marks the
reviewer blocked, records `reviewRecovery.status = "operator-required"`, preserves valid sibling
results, replays the human gate, and stops polling. Fresh failed and blocked terminal signals persist
a visible failed-review outcome without retry; stale prior-attempt signals are ignored. An idle or
shell-looking pane is not completion evidence, so partial artifacts remain recoverable while its
runner is alive. The live wait still ends at `review_timeout_min`; a newly launched reviewer window
is killed by its resolved tmux window ID before the caller raises the timeout, while an operator can
end the wait earlier with a shared failed or blocked terminal signal. The registered scenario uses
only its generated session, window, and child-process IDs for cleanup; it never scans or kills by a
shared name pattern. Reproduce the production gateway regression against the broken baseline and
current gateway paths with:

```bash
node scripts/runner-validation/run.mjs --scenario review-recovery-terminal-contract --out-dir docs/operations/evidence
```

Evidence: `evidence/runner-validate-<host>-gateway-review-recovery-terminal-contract.json`.

## Session binding + attribution

Gateway binding priority (`session-path-resolution.ts`, `session-process.ts`):

| #   | Signal                                                                                     | Runners                    |
| --- | ------------------------------------------------------------------------------------------ | -------------------------- |
| 1   | Pane-owned native session binding, filtered by pane process generation + dispatch boundary | grok                       |
| 2   | Pane-owned hook `SessionStart`, filtered by pane process generation + dispatch boundary    | claude, codex              |
| 3   | Filesystem set diff / mtime fallback only when no pane target is supplied                  | persisting, unscoped calls |
| 4   | `unavailable`                                                                              | cursor, scripted, opencode |

| Runner | Persists session | Path source                                     | `session-attribution-smoke` | `token-usage-smoke` |
| ------ | ---------------- | ----------------------------------------------- | --------------------------- | ------------------- |
| claude | yes              | hook `transcript_path`                          | required (E2E)              | required (E2E)      |
| codex  | yes              | pane hook; unscoped slot `CODEX_HOME` fallback  | required (E2E)              | required (E2E)      |
| grok   | yes              | pane-native `~/.grok/sessions/<realpath-repo>/` | required (E2E)              | required (E2E)      |
| cursor | no               | —                                               | skip                        | skip                |

### `session-attribution-smoke` pass criteria

1. Stale pre-seeded session exists before dispatch.
2. Resolved path ≠ stale path.
3. **Hook-driven:** hook `SessionStart.transcript_path` === resolved path; `tmuxPane` === pane id.
4. **`modelsMatch(dispatchedModel, modelFromTranscript(...))`** — e.g. dispatch `opus`, transcript `claude-opus-*`.
5. Stale seed would mismatch dispatched model.
6. A stale identity written into the live pane snapshot is rejected by production binding.
7. After the runner exits, a fresh-looking stale identity is rejected when the pane no longer owns
   a runner process and the caller has no pre-launch session inventory.

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
- Smoke: `codex exec --sandbox workspace-write '<prompt>'` from the isolated validation `CODEX_HOME` so repository hooks remain active.

### Grok (native event observability) — priority runner

Grok is interactive-first in production (`needsPostLaunchPrompt: true`). Its production-parity
`interaction-smoke` launches `grok --model grok-4.6`, resolves the project-directory prompt,
submits through the shared capability, and verifies native exact-prompt acceptance plus completion.

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
