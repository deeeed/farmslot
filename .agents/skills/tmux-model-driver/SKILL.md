---
name: tmux-model-driver
description: Drive another model through a tmux pane with guardrails. Use when Codex should orchestrate Claude, Codex, or another agent inside an existing tmux session, verify pane state before sending input, and keep a feedback loop around observed pane output.
---

# Tmux Model Driver

Drive a second model through tmux without guessing.

Use this skill when:

- a worker already lives in a tmux pane
- Codex must nudge that worker iteratively
- the worker may be in different modes: shell prompt, interactive Claude, interactive Codex, or a long-running command
- bad `send-keys` can waste tokens or corrupt state

Primary helpers:

- [scripts/pane-state.sh](scripts/pane-state.sh) — detect pane mode and return structured JSON
- [scripts/send-and-verify.sh](scripts/send-and-verify.sh) — send one payload and verify it actually landed
- [scripts/launch-file-task.sh](scripts/launch-file-task.sh) — launch a fresh file-first model run from verified shell state
- [scripts/watch-file-task.sh](scripts/watch-file-task.sh) — classify file-backed progress vs false progress
- [scripts/write-trace.py](scripts/write-trace.py) — append structured trace events for later replay or gateway ingestion

## Core Rule

Do not treat tmux like a blind transport.
Always:

1. detect pane state
2. choose the correct adapter for that state
3. send input
4. verify that the pane state changed the way you expected

If verification fails, stop and reassess instead of spamming more keys.

## Context Reset Guard

When starting a **new run** in an existing model pane, do not assume the old conversation is safe to reuse.

Default rule:

- **fresh process > `/clear` > blind reuse**

Preferred pattern for a new task:

1. return to shell
2. launch a fresh Claude/Codex process
3. pass the new prompt into that fresh process

Use `/clear` only when you intentionally want to keep the same interactive process and you verify the reset actually happened.

Reusing an already-open Claude/Codex prompt for a new benchmark run is unsafe by default because hidden prior context can bleed into the next result.

## State Machine

Use [scripts/pane-state.sh](scripts/pane-state.sh) first.

Design:

- bash collects pane/process evidence only
- one classifier step produces:
  - `state`
  - `phase`
  - `confidence`
  - `reasons`

Operational rule:

- trust the classifier result when confidence is high
- when confidence is low and the next action is risky, prefer `unknown` handling over guessing

Expected states:

- `shell` — safe for shell commands
- `claude` — send natural-language Claude instructions, not shell commands
- `codex` — send natural-language Codex instructions, not shell commands
- `busy` — long-running command still active; usually wait or interrupt intentionally
- `unknown` — do not send anything until clarified

## Runner Adapters

### Claude Pane

Signals:

- pane current command is `claude`
- prompt looks like `❯`
- `/model`, recaps, or Claude-style status line visible

Important:

- exact `pane_current_command=claude` is a strong signal
- text-only prompt/status hints are weak fallback evidence, not the source of truth

Rules:

- send natural-language instructions, not shell commands
- if you need shell work, exit or interrupt back to shell first
- after `send-keys ... C-m`, capture the pane again
- if the raw text you sent is still sitting at `❯`, it did not execute usefully

### Codex Pane

Signals:

- pane current command is `codex`
- Codex prompt / statusline visible

Rules:

- send natural-language instructions to Codex mode
- do not assume Claude prompt semantics
- verify the pane moved off the raw pending input after Enter

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

- if the pane is currently inside Claude or Codex, do **not** send the shell launch line yet
- first interrupt or exit back to shell
- verify the pane state is `shell`
- only then send the new process launch command

If you send `claude ...` or `codex ...` while still inside an interactive Claude/Codex prompt, the line may be treated as chat input instead of a shell command. That is a driver bug, not a model bug.

Prefer a **dedicated shell pane** for visible runner validation.

Pattern:

1. keep the existing model pane intact for ongoing interactive work
2. create or reuse a separate shell pane in the same tmux session
3. launch direct runner commands there
4. report which pane id is shell vs model

This prevents cross-contamination and makes runner validation observable without corrupting the active model session.

## Submission Guard

After every `tmux send-keys ... C-m`, do a capture pass.

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
- Claude/Codex prompt consumed the instruction and started working
- a new-run shell command no longer appears as pending input inside an old interactive model session
- a fresh `claude ...` / `codex ...` launch only happens from verified shell state

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
4. If state is wrong for the intended action, transition first.
5. Send one message or command with `scripts/send-and-verify.sh`.
6. Re-capture the pane.
7. Check for ghost-input false positives before deciding input is pending.
8. Confirm the send actually landed.
9. Append a trace event.
10. Only then continue.

## Common Failures

| Failure                                              | Fix                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sent shell command into interactive Claude           | detect state first; exit to shell or send Claude-language instruction instead |
| Sent instruction but it stayed pending at `❯`        | add a submission verification pass after Enter                                |
| Started a new benchmark inside an old Claude session | exit to shell and relaunch fresh process; do not rely on prior session state  |
| Sent `claude ...` while still inside Claude          | shell-launch guard failed; return to shell first                              |
| Thought dim scrollback text was pending input        | ghost-input guard failed; re-capture and verify active prompt line            |
| Claude showed `ctrl+g to edit in Nvim` after a nudge | input was buffered, not submitted; verifier must not mark success             |
| Assumed Claude and Codex prompts behave the same     | use runner-specific adapters                                                  |
| Kept nudging a busy pane                             | classify `busy` and wait or interrupt intentionally                           |

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
- `notes`
