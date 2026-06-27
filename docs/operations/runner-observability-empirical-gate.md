# Runner Observability Empirical Gate (ADR-032 Phase 1)

Run this gate on **runner-local**, **mini**, and **runner-a** before enabling hook telemetry fleet-wide.

## Primary proof: live tmux E2E

Phase 1 closeout is **tmux-first**, not unit tests or synthetic agreement counts.

```bash
# Canonical live proof (Claude/Codex hook-smoke, Grok pane + interaction, skill scripts)
bash scripts/e2e-tmux-runner-validate.sh

# Full gate bundle (E2E + install probes)
bash scripts/run-adr032-phase1-gate.sh
```

| E2E check | Proves |
|-----------|--------|
| `send-shell-script` | Long runner launches execute via `.tmux-driver-launch.sh` |
| `resolve-launch-blockers` | Idle shell clears; Grok/Cursor blockers use skill script when shown |
| `claude hook-smoke` | `SessionStart` + `UserPromptSubmit` + `Stop`, `tmuxPane` in hooks |
| `codex hook-smoke` | Same for Codex + isolated `CODEX_HOME` |
| `grok pane-smoke` | `grok -p` single-turn in tmux shell |
| `grok interaction-smoke` | Interactive TUI + compose submit + response marker |
| `cursor pane-smoke` | `cursor-agent --print --trust` (when binary present) |

Evidence JSON: `docs/operations/evidence/runner-validate-<host>-<runner>-<scenario>.json`

**Committed snapshots:** only macwork hook-smoke JSONs for Claude and Codex are versioned (plus install probes — see below). Grok/Cursor pane smokes and optional harness scenarios write local JSON under the same directory but must not be committed; `scripts/verify-adr032-no-invalid-paths.sh` fails if they appear on disk during closeout verification.

Operator guide: [runner-validation-harness.md](./runner-validation-harness.md)

## Install probes

```bash
node scripts/probe-runner-observability.mjs \
  --runner claude \
  --slot-id <slot-id> \
  --repo <slot-repo-path> \
  --runtime-dir .agent \
  --out docs/operations/evidence/adr032-phase1-probe-<host>-claude.json
```

Repeat for `codex`.

## Pass criteria

| Check | Pass |
|-------|------|
| `bash scripts/e2e-tmux-runner-validate.sh` | exit 0 on representative machine |
| `tmuxPane` in probe output (`tmuxPaneSeenInHooks`) | true |
| Hook writer median latency (probe) | < 150 ms |

## Optional fleet telemetry (not a closeout blocker)

When hooks are enabled on live slots, gateway may write hook-vs-pane agreement rows to:

`{{farmslot-root}}/.runs/observability-agreement/agreement-YYYY-MM-DD.ndjson`

Inspect manually:

```bash
node scripts/validate-observability-agreement-window.mjs \
  --dir .runs/observability-agreement \
  --out /tmp/agreement-snapshot.json
```

No fixed “200 events @ 98%” bar — that was never a real Phase 1 gate.

## Revalidation

| Scope | Command |
|-------|---------|
| Phase 1 empirical gate (E2E + probes) | `bash scripts/run-adr032-phase1-gate.sh` |
| Full ADR-032 closeout | `bash scripts/assert-adr032-goal-evidence.sh` |
| Phase 2 exit only | `bash scripts/verify-adr032-phase2-exit.sh` (refreshes `docs/operations/evidence/adr032/phase2-exit-window.json`) |

## Abort rule

If `$TMUX_PANE` is empty on a representative Claude slot, **stop Phase 1 rollout** and switch de-multiplexing to `{cwd, session_id}` per ADR-032 before installing fixtures broadly.