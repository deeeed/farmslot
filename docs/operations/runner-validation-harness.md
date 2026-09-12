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

# Dispatch model flag (needs a real slot; skipped by the full matrix without these args)
node scripts/runner-validation/run.mjs --runner cursor --scenario dispatch-model-flag --slot macpro-ff-1 --model gpt-5.6-sol-max
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

### Durable native sessions

ADR-057 phase 2 uses `native-session-durability` against isolated gateway18777.
This staged scenario leaves the gateway lifecycle to its operator. It never uses
Copilot or restarts a gateway. Run it separately for Codex and Claude, and repeat
the failure/recovery stages with both `FARMSLOT_NATIVE_KILL=runner` and `host`.
A passed stage is partial evidence; the full sequence is the acceptance proof.

Configure the gateway with a dedicated absolute `FARMSLOT_NATIVE_STATE_DIR` and
its pinned `FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID`. Keep the same state directory,
native HOME/configuration, and owner across restarts. Export the owner gateway
token through the environment. Never put tokens in scenario arguments or reports.

```sh
export FARMSLOT_GATEWAY=ws://127.0.0.1:18777
export FARMSLOT_RPC_TIMEOUT_MS=120000
export FARMSLOT_NATIVE_DURABILITY_STATE=/absolute/private/path/codex-durability.json
export FARMSLOT_NATIVE_DURABILITY_STAGE=start
node scripts/runner-validation/run.mjs --runner codex --scenario native-session-durability --out-dir temp/native-validation/evidence
```

Repeat that command with these stages in order:

1. `start` waits for structured tool start and the fixture's process marker.
2. Stop the isolated gateway through its existing launcher. Run `offline` while
   it is stopped. The scenario releases the bounded tool and checks its side
   effect before any gateway restart.
3. Restart the gateway with the same configuration. Run `reconnect` to check the
   same host, native identity and generation, contiguous missing events, cursor
   exhaustion, and duplicate-command receipts without repeated side effects.
4. Run `approval`, stop the gateway, run `approval-offline`, then restart it.
   Run `approval-reconnect` with `FARMSLOT_NATIVE_OTHER_TOKEN` set to a second
   authenticated admin. It rejects cross-owner, native-ID and stale replies,
   then proves that the retained denial prevented the write.
5. Run `failure` to kill only the recorded test runner, or the test host with
   `FARMSLOT_NATIVE_KILL=host`. Host killing refuses to proceed if another active
   session is still active. Run `recover` to resume the exact
   saved conversation, recall its token without tools, reject the old approval,
   and check that earlier commands were not replayed.
   Repeat host failure with `FARMSLOT_NATIVE_TORN_JOURNAL=1` and the same private
   `FARMSLOT_NATIVE_STATE_DIR` to prove cleanup repairs an incomplete journal write.
6. Run `close`. With all validation sessions stopped, run `uncertain-cleanup`
   with `FARMSLOT_NATIVE_STATE_DIR` pointing beneath the checkout's
   `temp/native-validation/`. It temporarily marks the stopped session's journal
   cleanup as unconfirmed and proves the real gateway rejects resume and close
   success. The stage stops the native host, restores the original record, and
   never changes the gateway or provider credentials. Then remove the private
   scenario state file and fixture directory.

For Claude, run `startup-failure` after `close`, then `close` again. It installs
a temporary resume hook in the fixture, waits for native initialization timeout,
checks confirmed process cleanup, removes the hook, and proves explicit retry
keeps the same conversation. No inference is needed for this stage.

`native-session-cleanup-isolation` proves that a denied cleanup signal cannot
stop another session on the same host. Use an empty validation host and launch
its gateway with `NODE_OPTIONS=--import=<checkout>/scripts/runner-validation/fixtures/native-signal-fault.mjs`
and `FARMSLOT_NATIVE_SIGNAL_FAULT=<checkout>/temp/native-validation/<unique>.json`.
Set the same fault path and `FARMSLOT_NATIVE_STATE_DIR` on the scenario command.
The preload only injects one failure for the fixture's explicit host and process
IDs. The scenario requires the close RPC to reject, recovery to remain blocked,
and a second real native session to finish a turn on the same host. It then stops
the exclusive test host. Restart the validation gateway without the preload
afterward. Never use this injector in an operator gateway.

Incidental approvals fail the stage with session/request IDs for explicit review
through `native.session.read/respond`. Rerun the same stage after responding; its
private state retains submitted commands. The scenario only automatically approves
an exact fixture command, so shell-wrapped commands may require manual review.

The bounded tool expires after three minutes. Complete the stop/offline stages
within that window. A timeout is failed proof, not completion. A failure leaves
state available for diagnosis; use `close` to clean up its owned session.
Also run `native-session-smoke`, `native-session-startup-close`,
`native-session-authorization-smoke`, and the existing tmux acceptance and
retained-handoff scenarios. Unit fixtures cannot substitute for these live checks.

### Native Copilot workspace stages

`native-copilot-workspace` drives the actual Agent workspace controls through CDP,
then checks durable events and file effects through gateway reads. Use a disposable
Git fixture containing `src/greeting.ts` with an initial `Hello` greeting, registered
as a local slot in the isolated gateway pool. The source must be committed before
the edit so the workspace diff has a baseline.

The scenario requires gateway `ws://127.0.0.1:18777`, UI
`http://127.0.0.1:18778/#fleet`, and CDP `19323`. Supply existing owner credentials
through the normal gateway environment and log into the isolated browser first.
Keep the fixture and private state file under checkout `temp/native-validation`.
It never drives the regular Copilot tmux singleton.

```bash
export FARMSLOT_GATEWAY=ws://127.0.0.1:18777
export FARMSLOT_UI_URL=http://127.0.0.1:18778/#fleet
export FARMSLOT_CDP_PORT=19323
export FARMSLOT_NATIVE_UI_FIXTURE="$PWD/temp/native-validation/ui-fixture"
export FARMSLOT_NATIVE_UI_STATE="$PWD/temp/native-validation/ui-state.json"
export FARMSLOT_NATIVE_UI_STAGE=create
node scripts/runner-validation/run.mjs --runner claude --model sonnet \
  --scenario native-copilot-workspace --out-dir temp/native-validation/evidence
```

Run one stage per invocation with the same state file:

- `create` selects the runner, model and configured fixture through UI controls.
  `FARMSLOT_NATIVE_UI_MODE=plan` selects plan mode when the catalog offers it.
- `edit` submits one bounded greeting edit. `finish-edit` waits without resending.
- `inspect-edit` checks that a pending permission with normalized tool details
  displays the proposed file and diff after refresh, before the file changes.
- `workspace` checks rendered diff/source, visible Send control, and the same
  transcript after a page refresh. It saves a screenshot.
- `layout` resizes the browser to 500px and 1440px, checks drawer and expanded
  views, and verifies the conversation controls remain reachable and the
  workspace fits. It restores the original browser size afterward.
- `request-approval` submits a shell write to `approval-proof.txt`. Set
  `FARMSLOT_NATIVE_UI_APPROVAL_CASE=deny`, then run `deny` to refresh the pending
  request, deny it and prove the file is absent. Repeat with case `approve`, then
  stage `approve`, to prove the permitted write. The proof file must be absent
  before starting each new approval case; run denial first.
- `interrupt` submits a bounded sleep and stops it after a tool-start event. If
  permission is pending, inspect and answer it explicitly in the UI, then run
  `stop` without submitting another task.
- `context-question` asks for a recovery label through the native question tool.
  `context-answer` refreshes the page and enters a random custom answer without
  putting it in a user prompt. These stages require question and resume support.
- `context-fail` runs a three-minute fixture tool and kills the owned native
  process while it waits. Inspect any approval in the UI, then rerun the stage.
  It requires confirmed process cleanup and no completion effect.
- `context-resume` clicks Resume, verifies a new process generation with the same
  native session, and checks recall of the question answer without prompt replay
  or restarting the interrupted tool.
- `close` clicks Close session and waits for confirmed process cleanup.

The client-only replay previews at `#dev/native-session?replay=matching`,
`foreign-command`, and `foreign-generation` seed an old browser receipt before
mount and return 100 newer receipts through a fixture API. Fill Message with
`cdp.mjs fill`, then run `probes/native-replay-lock.js` with `cdp.mjs eval`.
Only the matching terminal event enables Send. These previews prove client
replay handling, not native inference or gateway receipt retention.

An edit or sleep awaiting approval produces `pending: true` and `pass: false`, with
the next action in the report. The explicit `request-approval` stage passes only
its pending-control check. It requires the normalized request detail to match
the exact bounded command; a reason-only or different action stays partial and
requires inspection. The decision stages also check that exact command before
clicking Approve or Deny. This is partial evidence, not a completed edit or interruption.
State is saved before every submission and decision. A retry never repeats an
uncertain action; resolve its outcome or use a separate fresh fixture/state for a
new attempt. The scenario leaves sessions open between stages so pending-request
refresh and recovery remain observable. Finish with `close`.

These stages cover the workspace UI flow. Run the separate session authorization,
workspace boundary, explicit recovery, responsive layout, and isolated regular
Copilot checks before claiming the full integration is validated.
