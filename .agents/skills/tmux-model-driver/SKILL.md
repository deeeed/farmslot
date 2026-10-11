---
name: tmux-model-driver
description: Send to a model in tmux with process identity checks, native turn proof, and guards for questions, busy turns, shells and queued input.
---

# Tmux model driver

Use this transport for lane messages. Submission always uses named `Enter`.
The shell entry points resolve their TypeScript loader from the owning Farmslot checkout,
so they also work when invoked from another checkout or a temporary directory.

## Send and inspect

```bash
scripts/pane-state.sh <pane> [runner]
cat prompt.txt | scripts/send-and-verify.sh <pane> <runner> [trace.jsonl]
```

`pane-state.sh` returns JSON with `state`, `phase`, `confidence`,
`pending_question`, `question`, `queued`, `queue_kind`, `delivery_phase`,
`session_id`, `session_path`, `turn_token` and `evidence_source`.

The process tree and argv identify Codex, Claude, Cursor, Gemini, Grok or a
shell. A rendered prompt cannot establish runner identity. Native session
records and pane-bound hooks establish idle or active turns. Missing or stale
observability means `unknown`, even when the screen looks idle.

`send-and-verify.sh` returns JSON and exits nonzero when refused or unverified.
It refuses the wrong runner, a shell when a model is expected, a busy turn,
a pending question, an existing queue or unavailable native readiness evidence.
It pastes the payload once and submits with `Enter`. It never answers a question.

`submitted` requires a matching structured prompt receipt and a new turn token.
Codex native history supplies exact prompt and turn evidence. Native `/goal` delivery requires
a matching active `thread_goal_updated` objective followed by its new `task_started` turn. Pane-bound hook
digests supply acceptance and new-turn evidence for hook-capable runners.
Rendered output is only a fail-closed veto for questions, queues and launch gates.
Cursor, Gemini and Grok identities can be detected, but sends fail closed unless
compatible structured observability is installed.

## Questions and queued input

Question details come from unresolved native `AskUserQuestion` or
`request_user_input` calls and matching tool results. A visible menu or question
also blocks delivery. Surface the captured question to the lead; never guess an answer.

For an explicit answer, first inspect `question` and `question_fingerprint`.
The lead must choose the response before calling:

```bash
printf '%s' '["Down","Enter"]' | scripts/answer-question.sh <pane> <runner> <question-fingerprint> [trace.jsonl]
```

The driver rechecks the captured question and pane identity under a lock. Only
navigation keys and explicit `{ "text": "answer" }` actions up to 2048 bytes
are accepted. A changed question is refused. `response_sent` acknowledges the
input attempt; it does not claim the runner started a turn. Read native state
again before continuing. Historical screen questions never authorize a response.

An unverified send retains a private receipt. A later send refuses to append or
repeat its prompt. Native acceptance remains recorded across inspections. Ordinary sends refuse
`acceptance_unacknowledged` until the owner records completion of the handoff in its registry
and calls `scripts/ack-acceptance.sh <pane> <runner> <receipt_id>`. The lane CLI performs this
acknowledgement after persisting its state. Inspection alone never consumes the receipt.

```bash
cat original-prompt.txt | scripts/flush-queued.sh <pane> <runner> [trace.jsonl]
```

Flush requires an idle native turn, a driver-owned receipt and the exact original
payload still visible in the buffer. It sends only `Enter`, then verifies the
new turn. A different payload, edited buffer, foreign queue or pending question
is refused. Never clear the composer or resend an unverified prompt.

## Runtime settings

- `TMUX_MODEL_DRIVER_SOCKET`: tmux `-L` socket name. Every driver tmux call uses it.
- `TMUX_MODEL_DRIVER_OBSERVABILITY_DIR`: the runner's `.observability` directory.
  Default is `<pane-current-path>/.agent/.observability`.
- `TMUX_MODEL_DRIVER_STATE_DIR`: private receipt and lock directory.
- `TMUX_MODEL_DRIVER_VERIFY_TIMEOUT_MS`: verification ceiling, default 3000 ms.
- `TMUX_MODEL_DRIVER_STAGE_ROOT`: directory for staged shell launch scripts.

Use a private socket for tests and live validation. Never start or kill an
operator's tmux server. If delivery times out, retain the receipt and inspect
state before deciding whether an explicit flush is safe.

## Launch and file-backed work

`runner-launch.mjs` reads JSON from stdin with `id`, `runner`, `cwd` and
`runtime_dir`, plus optional `model`, `binary`, `resume_id`, `effort`,
`safety_tier`, `account_label`, `env` and `goal_command`. Safety tiers must be
`sandboxed`, `full-auto` or `dangerous`.
It delegates launch, resume and hook installation to the shared runner adapter. Fresh Codex
lanes first run a READY bootstrap turn so native session records exist before `/goal` delivery.
The JSON result includes `command`, `runtime_dir`, `observability_dir`,
`goal_supported` and `goal_prefix`. Codex supports native `/goal`; Claude uses
a natural-language instruction unless a local `.claude/skills/goal/SKILL.md`
or `.claude/commands/goal.md` exists and `/goal` is declared.

Existing helpers remain available:

- `send-shell-script.sh <pane> <repo> [trace]` stages a mode-600 script outside
  the checkout and launches it through the guarded shell transport. A private
  file sentinel proves shell execution started. The staged script removes itself.
- `launch-file-task.sh <pane> <runner> <model> <task-file> [trace] [signal] [skill]`
  launches a file-first task from a verified shell, including clean-room Claude mode.
- `watch-file-task.sh` classifies task-file and signal-file progress.
- `resolve-launch-blockers.sh <pane> <runner> [seconds]` resolves only the known
  Cursor workspace-trust or Grok current-project gate for the expected live runner.
  Auth gates and model questions require the lead.
- `headless-exec.sh --last <file> --log <file> --timeout <seconds> -- <command>`
  closes stdin, records the process exit code and requires an anchored terminal
  marker in the final-message artifact. Headless Claude review must follow the
  project's review policy; use the interactive path when required.
- `write-trace.py <trace> <event-json>` appends trace events.

Runner behavior belongs in the shared capability and observability adapters.
Run the matching live scenario under `scripts/runner-validation/` for behavior
proof. Unit tests guard regressions; fixture runners are never live proof.
