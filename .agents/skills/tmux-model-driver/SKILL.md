---
name: tmux-model-driver
description: Drive another model through a tmux pane with guardrails. Use when Codex should orchestrate Claude, Codex, Grok, Cursor, or another agent inside an existing tmux session, verify pane state before sending input, and keep a feedback loop around observed pane output.
---

# Tmux Model Driver

Drive a second model through tmux without guessing.

Use this skill when:

- a worker already lives in a tmux pane
- Codex must nudge that worker iteratively
- the worker may be in different modes: shell prompt, interactive Claude, Codex, Grok, Cursor, or a long-running command
- bad `send-keys` can waste tokens or corrupt state

Primary helpers:

- [scripts/pane-state.sh](scripts/pane-state.sh) — detect pane mode and return structured JSON
- [scripts/send-and-verify.sh](scripts/send-and-verify.sh) — send one payload and verify it actually landed
- [scripts/resolve-launch-blockers.sh](scripts/resolve-launch-blockers.sh) — auto-resolve Grok project-directory and Cursor workspace-trust prompts
- [scripts/send-shell-script.sh](scripts/send-shell-script.sh) — run long launch lines via a private, checkout-external script (avoids `send-keys` wrap and checkout pollution)
- [scripts/launch-file-task.sh](scripts/launch-file-task.sh) — launch a fresh file-first model run from verified shell state
- [scripts/watch-file-task.sh](scripts/watch-file-task.sh) — classify file-backed progress vs false progress
- [scripts/write-trace.py](scripts/write-trace.py) — append structured trace events for later replay or gateway ingestion

Empirical runner contracts live in [scripts/runner-validation/](../../../scripts/runner-validation/) and [docs/operations/runner-validation-harness.md](../../../docs/operations/runner-validation-harness.md). When harness findings change, update this skill's adapters first.

## Core Rule

Do not treat tmux like a blind transport.
Always:

1. detect pane state
2. choose the correct adapter for that state
3. send input
4. verify that the pane state changed the way you expected

If verification fails, stop and reassess instead of spamming more keys.

## Production Path vs Smoke Path

Cross-review, orchestration, and multi-step PR work use the **interactive tmux compose path** in the existing model pane. That is the safe default.

| Goal                                        | Path                                       | Notes                                                                                         |
| ------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Cross-review / worker nudges / review loops | Interactive model pane                     | `send-keys -l` then named `Enter`                                                             |
| One-shot smoke from an agent terminal       | `claude -p` / `codex exec` in a real shell | OK outside tmux; not a tmux-pane substitute                                                   |
| `claude -p` inside a tmux shell pane        | Avoid                                      | Launch script can exit with no visible output; orchestrator thinks review ran when it did not |
| Extra shell pane + `claude -p` for review   | Avoid                                      | Corrupts cross-review routing; keep reviewer in its dedicated model pane                      |

`claude -p` can work from a direct terminal, but it is a poor fit for tmux orchestration: no compose progress (`Cooking…`), weak pane verification, and easy false success when the process exits silently.

## Canonical Submit Sequence

Match gateway `tmuxSendTextCommand` in `services/gateway/src/core/tmux.ts`:

```bash
tmux send-keys -t <pane-id> -l '<payload>'
tmux send-keys -t <pane-id> Enter    # named Enter — not C-m for Claude/Codex
```

Runner-specific submit keys (same contract as `runnerBufferedInstructionSubmitKey` in `services/gateway/src/runners/registry.ts`):

- **Claude / Codex / Grok:** named `Enter`
- **Cursor:** `C-m`
- **Codex while busy:** `Tab` when pane shows `tab to queue message`

The helper makes one literal send and one runner-specific submit attempt. Afterward, re-capture the pane and confirm the runner-specific progress marker. `unverified` means it saw neither a consumed prompt nor new runner progress; do not append or resend the payload.

## Context Reset Guard

When starting a **new run** in an existing model pane, do not assume the old conversation is safe to reuse.

Default rule:

- **fresh process > `/clear` > blind reuse**

Preferred pattern for a new task:

1. return to shell
2. launch a fresh Claude/Codex/Grok/Cursor process
3. pass the new prompt into that fresh process

Use `/clear` only when you intentionally want to keep the same interactive process and you verify the reset actually happened.

Reusing an already-open model prompt for a new benchmark run is unsafe by default because hidden prior context can bleed into the next result.

## State Machine

Use [scripts/pane-state.sh](scripts/pane-state.sh) first.

Design:

- bash collects pane/process evidence only
- one classifier step produces:
  - `state`
  - `phase`
  - `confidence`
  - `reasons`
  - `launch_blocker` / `auto_action` when a post-launch gate is visible

Operational rule:

- trust the classifier result when confidence is high
- when confidence is low and the next action is risky, prefer `unknown` handling over guessing
- when `phase` is `launch-blocker`, resolve the blocker before sending the task prompt

Expected states:

- `shell` — safe for shell commands
- `claude` — send natural-language Claude instructions, not shell commands
- `codex` — send natural-language Codex instructions, not shell commands
- `grok` — send natural-language Grok instructions; may need project-directory resolution first
- `cursor` — send natural-language Cursor instructions; may need workspace-trust first
- `busy` — long-running command still active; usually wait or interrupt intentionally
- `unknown` — do not send anything until clarified

Expected phases:

- `idle` — ready for the next driver action
- `busy` — runner is working; wait or interrupt intentionally
- `launch-blocker` — runner TUI is waiting on trust/project selection before compose is available

## Runner Adapters

### Claude Pane (`event-driven`)

Signals:

- pane current command is `claude`
- prompt looks like `❯`
- `/model`, recaps, or Claude-style status line visible

Important:

- exact `pane_current_command=claude` is a strong signal
- text-only prompt/status hints are weak fallback evidence, not the source of truth
- multiline compose can sit in the bordered input box without submitting; `C-m` is unreliable — use named `Enter`
- `send-and-verify.sh` returns `input_buffered`, `pending_input`, or `unverified` unless it sees progress added after the payload; never append the payload on those results

Rules:

- send natural-language instructions, not shell commands
- clean-room Claude: pass the selected `SKILL.md` last; the helper isolates it and disables subagents
- if you need shell work, exit or interrupt back to shell first
- submit with `send-keys -l` + named `Enter`; capture again before sending more keys
- if the raw text you sent is still sitting in the compose box at `❯`, it did not execute — send `Enter` again or `C-u` + resend
- reset with `/clear` + `Enter`, verify empty `❯`, then send the new task

Success signals (any of these):

- `Cooking…` / `Pollinating…` / `Effecting…` / `Baked for` / tool lines (`⏺ Bash`, `Reading N files`)
- prompt echoed above an empty `❯`, not trapped inside the compose border
- session status shows `thinking` / `session:Nm`

Scriptable validation path (agent terminal only — not tmux reviewer panes):

- `claude --dangerously-skip-permissions -p '<prompt>'` from a real shell outside tmux

### Codex Pane (`event-driven`)

Signals:

- pane current command is `codex`
- Codex prompt / statusline visible

Rules:

- send natural-language instructions to Codex mode
- do not assume Claude prompt semantics
- submit with `send-keys -l` + named `Enter`; if prompt echoes with `›` but no `Working`, send `Enter` again
- when pane shows `tab to queue message`, submit with `Tab` instead of `Enter`
- verify `Working (` appeared or hooks started before treating the send as successful

Scriptable validation path:

- bare tmux has no shell `codex` function — use full `node …/codex.js`
- requires `git init` in the target repo
- isolated `CODEX_HOME={{runtime_dir}}/codex-home` with canonical `trusted_hash` (realpath-safe on macOS)
- smoke: `codex exec --disable plugin_hooks --sandbox workspace-write '<prompt>' </dev/null`
- **always close stdin (`</dev/null`) on headless/background invocations** — when stdin is a
  pipe instead of a TTY, `codex exec` blocks forever on `Reading additional input from stdin...`
  with zero output (observed: a 3-hour silent hang that looked like a long-running review)
- wait for **Stop hook** or a pane marker — marker alone is not enough for hook-driven runs

### Grok Pane (native session observability) — priority runner

Grok is interactive-first in production (`needsPostLaunchPrompt: true`). Treat it differently from Claude/Codex.

Signals:

- pane current command is `grok`
- `events.jsonl` records structured turn/tool activity; indexed user messages in
  `chat_history.jsonl` correlate exact accepted prompts to their turn
- project-directory prompt: `Run Grok Build in a project directory`, `(current)`, `Enter:submit`
- compose ready after blocker clears

Two validated paths:

1. **Fast smoke (shell):** `grok -p '<prompt>' --model grok-4.5` — single-turn, proves binary + response marker.
2. **Production-parity (interactive):**
   - launch `grok --model grok-4.5` from shell
   - run [scripts/resolve-launch-blockers.sh](scripts/resolve-launch-blockers.sh) `<pane> grok` — sends `Enter` on the `(current)` project row
   - submit prompt with `send-keys -l` + Enter
   - wait for response marker in pane output

Rules:

- do not assume Claude `❯` semantics
- native observations are authoritative only when one active Grok session binds to the pane;
  ambiguous or unavailable session metadata fails closed, with the generic worker signal as the
  runner-agnostic delivery fallback
- after interactive launch, **always** check `launch_blocker` before composing
- `git init` in the launch repo so Grok sees a project directory
- binary default: `~/.grok/bin/grok`

### Cursor Pane (`pane-only`)

Signals:

- pane current command is `cursor-agent` or `agent`
- workspace-trust prompt: `[a] trust this workspace`, `[q] quit`, `use arrow keys to navigate`

Rules:

- gateway often launches with argv prompt (`needsPostLaunchPrompt: false`)
- for tmux smoke, prefer shell + `cursor-agent --print --trust --sandbox enabled`
- for interactive launch without `--trust`, run [scripts/resolve-launch-blockers.sh](scripts/resolve-launch-blockers.sh) `<pane> cursor` — sends `a`

### Shell Pane

Signals:

- pane current command is `zsh`, `bash`, `fish`, etc.
- standard shell prompt visible

Important:

- shell process metadata is stronger than prompt-text pattern matching

Rules:

- shell commands are allowed
- after sending, verify either:
  - command output appeared, or
  - prompt disappeared because the command is running

## Shell-Launch Guard

Launching a fresh model process is a **shell action**.

That means:

- if the pane is currently inside Claude, Codex, Grok, or Cursor, do **not** send the shell launch line yet
- first interrupt or exit back to shell
- verify the pane state is `shell`
- only then send the new process launch command

If you send `claude ...`, `codex ...`, `grok ...`, or `cursor-agent ...` while still inside an interactive model prompt, the line may be treated as chat input instead of a shell command. That is a driver bug, not a model bug.

Prefer a **dedicated shell pane** for visible runner validation.

Pattern:

1. keep the existing model pane intact for ongoing interactive work
2. create or reuse a separate shell pane in the same tmux session
3. launch direct runner commands there
4. report which pane id is shell vs model

This prevents cross-contamination and makes runner validation observable without corrupting the active model session.

## Launch-Script Guard

Long runner launch lines **wrap and break** when sent with `tmux send-keys -l` in narrow panes.

When the launch command is longer than ~120 characters or includes multiple env prefixes:

1. verify shell state
2. stage a mode-`600` script outside the target checkout via [scripts/send-shell-script.sh](scripts/send-shell-script.sh)
3. execute its short, digest-bearing path through the shell adapter; it removes itself after the launched process exits

The runner-validation harness uses the same pattern as `.runner-validate-launch.sh`. Prefer the skill helper so orchestrators do not reimplement it.

## Headless Exec Guard

Running a model headlessly (`codex exec`, `claude -p`) from an orchestrator is a **wrapper contract**, and the wrapper fails silently in two specific ways:

1. **stdin hang** — `codex exec` with a non-TTY stdin blocks forever reading it. Always
   redirect `</dev/null`.
2. **Pipe-laundered kills** — `timeout N codex exec … | tail` reports **exit 0 when timeout
   kills the process**: the pipeline's status is tail's, the output holds whatever partial
   text flushed, and the run looks "completed" with no result. Observed twice on one review
   before diagnosis.

Rules:

- capture headless output to a **file**, never through a pipe you also take the exit status from
- capture the model process's **own** exit code (`rc=$?`) and gate on it — `124` means the
  timeout fired; do not print-and-discard it
- require a **terminal marker** before treating the run as complete (a `VERDICT:` line, Stop
  hook, or equivalent end-of-run sentinel) — and check it in a **final-message artifact**
  (`codex exec --output-last-message <file>`), anchored (`^VERDICT:`), not in the raw log:
  the log echoes the prompt, which itself contains the marker text
- budget timeouts to the task — a large-diff review can legitimately need well over 10 minutes;
  a mid-analysis kill produces silent no-verdict output

**Use `scripts/headless-exec.sh` rather than re-deriving this.** The rules above were
prose an orchestrator had to remember, and both failures kept being rediscovered live.
The script closes stdin, keeps output in files, gates on the process's own exit code,
truncates a stale artifact before the run, and requires the marker in the final-message
file. It exits non-zero — loudly — on any of those, so a silent no-verdict run cannot be
mistaken for a completed one.

```bash
scripts/headless-exec.sh --last /tmp/run.last --log /tmp/run.log --timeout 1200 \
  -- codex exec --sandbox read-only --output-last-message /tmp/run.last \
     '<prompt … end with VERDICT line>'
```

It prints the final message on success, so the caller reads stdout and does not have to
know the artifact convention. `--marker` overrides the default `^VERDICT:`.

Doing it by hand, if you must:

```bash
timeout 1200 codex exec --sandbox read-only --output-last-message /tmp/run.last \
  '<prompt … end with VERDICT line>' </dev/null > /tmp/run.log 2>&1
rc=$?
if [ "$rc" -ne 0 ] || ! grep -q '^VERDICT:' /tmp/run.last; then
  echo "WRAPPER FAILURE: exit=$rc, no terminal marker — do not trust /tmp/run.log"
  exit 1
fi
```

## Launch-Blocker Guard

Some runners show a post-launch gate before compose is available.

| Runner | Blocker             | Auto action                |
| ------ | ------------------- | -------------------------- |
| Grok   | `project-directory` | `Enter` on `(current)` row |
| Cursor | `workspace-trust`   | `a`                        |

Detection lives in `pane-state.sh` (optional `[runner-id]` scopes Grok/Cursor blockers; includes `auth-required`). Harness `lib/pane-blockers.mjs` and `resolveLaunchBlockers()` delegate here — keep patterns aligned with `services/gateway/src/runners/registry.ts` `detectRunnerLaunchBlocker`.

Protocol:

1. launch runner from verified shell state
2. poll `pane-state.sh` until `phase` is not `launch-blocker`, or call `resolve-launch-blockers.sh`
3. only then send the task prompt
4. if `verification` is `launch_blocker` after a compose send, you skipped step 2

Auth-required blockers have no safe auto action — stop and ask a human to log in.

## Submission Guard

After every compose submit (`send-keys -l` + runner-specific submit key), do a capture pass.

Be careful: panes can show **ghost input** that looks like pending text but is not actually the active prompt line.

Examples:

- dimmer echoed command text from prior output
- recap text that visually resembles a prompt
- a previously submitted command still visible in scrollback

Do not decide from one visual snapshot alone.

Bad outcome:

- the same line is still visibly pending at the prompt
- no output started
- pane is still in the same mode with unsubmitted text
- what looked like pending input was actually stale dim/echoed text in scrollback

Good outcome:

- shell prompt moved and command output began
- Claude/Codex/Grok/Cursor prompt consumed the instruction and started working
- a new-run shell command no longer appears as pending input inside an old interactive model session
- a fresh model launch only happens from verified shell state

If the bad outcome happens, record it as a driver failure. Do not keep nudging blindly.

## Ghost-Input Guard

Before concluding "input is pending":

1. capture the pane twice
2. check whether the suspected line is attached to the current prompt/cursor position
3. prefer state signals over visual similarity alone

Treat text as **real pending input** only when at least one of these is true:

- it appears on the active prompt line after your send
- a second capture shows the exact same line still sitting at the active prompt
- pane state and current command agree that the model/shell is waiting for input

Treat text as **ghost input** when:

- it is dimmer / visually older than the active prompt
- it appears in scrollback but not on the current prompt line
- a second capture shows the prompt moved but the old text is still visible above

When uncertain, capture again instead of sending more keys.

Treat text as **input buffered but not submitted** when:

- the pane shows compose/editor hints such as `ctrl+g to edit in Nvim`
- your payload is present, but the model has not begun responding

This is not success. It means the text was inserted into the model's input buffer and still needs an actual submit action.

## Feedback Loop

This skill is for recursive self-improvement.

After every real run, capture:

- what pane state was detected
- what was sent
- what actually happened
- what guard failed or succeeded

Feed those findings back into:

- the target skill contract
- the tmux-driver adapter rules
- [scripts/runner-validation/runners/](../../../scripts/runner-validation/runners/) launch adapters
- any runner-specific quirks

Record a distinction between:

- **runner healthy, wrapper unhealthy**
- **runner unhealthy**

Example:

- direct `codex exec` in the shell pane succeeds
- `recipe-cook` batch wrapper around Codex fails to reach terminal output

That is not "Codex broken". It is a wrapper-contract failure and should be tracked separately.

## Minimum Protocol

1. Detect pane state with `scripts/pane-state.sh <pane-id>`.
2. If this is a new run, reset context first. Prefer exiting to shell and relaunching a fresh process.
3. If the next action is a shell launch, require verified `shell` state first.
4. If `phase` is `launch-blocker`, run `resolve-launch-blockers.sh` before composing.
5. If state is wrong for the intended action, transition first.
6. For long launch lines, use `send-shell-script.sh` instead of raw `send-keys -l`.
7. Send one message or command with `scripts/send-and-verify.sh`.
8. Re-capture the pane.
9. Check for ghost-input false positives before deciding input is pending.
10. Confirm the send actually landed.
11. Append a trace event.
12. Only then continue.

## Common Failures

| Failure                                                                | Fix                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Sent shell command into interactive Claude                             | detect state first; exit to shell or send Claude-language instruction instead                                                    |
| Sent instruction but it stayed pending at `❯`                          | use named `Enter` (not `C-m`); re-capture; for cross-review stay in interactive pane — do not fall back to `claude -p` in tmux   |
| Launched `claude -p` in tmux shell pane for review                     | driver bug; use interactive model pane (`send-keys -l` + `Enter`) or run `-p` only from agent terminal                           |
| `send-and-verify.sh` said submitted but Claude still composing         | verifier false positive; wait for `Cooking…` / tool output, not script JSON alone                                                |
| Started a new benchmark inside an old Claude session                   | exit to shell and relaunch fresh process; do not rely on prior session state                                                     |
| Sent `claude ...` while still inside Claude                            | shell-launch guard failed; return to shell first                                                                                 |
| Thought dim scrollback text was pending input                          | ghost-input guard failed; re-capture and verify active prompt line                                                               |
| Claude showed `ctrl+g to edit in Nvim` after a nudge                   | input was buffered, not submitted; verifier must not mark success                                                                |
| Assumed Claude and Codex prompts behave the same                       | use runner-specific adapters                                                                                                     |
| Kept nudging a busy pane                                               | classify `busy` and wait or interrupt intentionally                                                                              |
| Grok launched but prompt never reached compose                         | project-directory blocker still up; run `resolve-launch-blockers.sh`                                                             |
| Cursor launched but compose unavailable                                | workspace-trust blocker; send `a` via blocker resolver                                                                           |
| Long `codex exec` / `cursor-agent` line split mid-command              | launch-script guard failed; use `send-shell-script.sh`                                                                           |
| Codex hooks never fired in smoke                                       | used marker-only wait; wait for Stop hook or use hook-smoke scenario                                                             |
| Grok `-p` works but interactive path fails                             | two paths differ; use interaction-smoke protocol for production parity                                                           |
| `codex exec` hangs forever on "Reading additional input from stdin..." | stdin was a pipe, not a TTY; relaunch with `</dev/null` (headless-exec guard)                                                    |
| Headless review "completed" with partial output and no verdict         | timeout killed it and the pipe masked exit 124; gate on the process's own exit code + anchored marker in `--output-last-message` |
| Claude pane at `❯` silently ignores delivered prompts (ctx ≳90%)       | context-saturated session; do not keep nudging — kill the process and relaunch fresh (fresh process > `/clear` > reuse)          |

## Output

When using this skill, keep a short trace of:

- pane id
- detected state
- sent input
- verification result
- next action

Prefer JSON Lines so gateway/orchestrator can ingest it later.

Suggested per-event keys:

- `ts`
- `pane_id`
- `session_name`
- `action_kind`
- `payload`
- `before_state`
- `after_state`
- `verification`
- `launch_blocker`
- `notes`
