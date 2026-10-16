---
name: tmux-model-driver
description: Send to a model in tmux with process identity checks, native turn proof, and guards for questions, busy turns, shells and queued input.
---

# Tmux model driver

Use this transport for lane messages. The shared runner adapter selects the submission key.
Codex submission always uses `Enter`, including steering a busy turn. Never press `Tab`.
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
records and pane-bound hooks establish idle or active turns. An unhooked Codex
process can bind its sole kernel-owned parent rollout, excluding subagents, for exact native acceptance.
An unhooked Claude process binds through its own `sessions/<pid>.json` registration, started no earlier
than the process, which names its transcript and busy or idle status. Missing or stale
observability means `unknown`, even when the screen looks idle.

`send-and-verify.sh` returns JSON and exits nonzero when refused or unverified.
Native transcripts and hook logs can outgrow the largest string a process holds, so the
driver reads them in bounded ranges: recent records for questions and hooks, and the session
header plus records after the send for proof. Native probes take their script on stdin, so
payload size has no argument limit. Proof needs the whole message: a hook digest covers only
its prefix, so it proves only a message that short.
It refuses the wrong runner, a shell when a model is expected, a pending question
or a foreign queue. Codex and Claude accept Enter-submitted input during busy or unknown
phases. Claude also needs its bound native session, because only its transcript proves
delivery. Other runners and explicit flush still require idle native readiness.
It pastes the payload once and presses `Enter`. If the exact owned text remains in the
composer, it presses `Enter` once more and re-verifies. An unchanged composer then reports
`not_sent`; its receipt is retained. The driver never presses `Tab` or answers a question.

`submitted` requires exact acceptance of the owned prompt. Codex native history
can prove steering within the active turn, without claiming a new turn started.
A complete driver-owned "Messages to be submitted after next tool call" steering block
reports `submitted`, for the same pane process. This proves steering
delivery at the next tool call, with no new-turn claim. "Queued follow-up inputs" is
postponed input and never proves delivery. Its receipt is preserved without another key.
A marker or shared prefix alone is insufficient. A fresh Enter submission into an empty
queue can also use its matching truncated steering preview and separate overflow line.
Claude transcript records written after the send prove delivery: an exact human prompt
(`native-session`), or input queued during a turn (`native-queue`) that Claude attaches
at its next step (`native-steering`). A `native-queue` receipt stays until its caller
acknowledges delivery. Up pulls queued input back into the composer (`popAll`), which
withdraws that proof: status no longer reports it and acknowledgement keeps the receipt. Claude's own queued input never blocks a handoff; a draft in its
boxed composer does.
Codex native history supplies exact prompt and turn evidence. Native `/goal` delivery requires
a matching active `thread_goal_updated` objective followed by its new `task_started` turn. Pane-bound hook
digests supply acceptance and new-turn evidence for hook-capable runners.
Rendered output vetoes questions, foreign queues and launch gates. The exact owned
Codex steering block also proves delivery. It does not establish a native turn.
Callers must use the driver's structured result. A matching prefix anywhere in a pane,
an empty composer, or a working indicator never authorizes a caller to claim delivery,
paste again, pull back a queued message, or acknowledge another caller's receipt.
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

Only the bottom composer above the status footer supplies live buffered input.
Its empty placeholder and historical submitted prompts never count as a buffer.
Retained uncertain receipts do not block a different fresh handoff into an empty composer;
the new handoff gets its own receipt. Retrying an uncertain original with no live buffer
returns `unverified` without typing or Enter. The original receipt remains intact.

An unverified send retains a private receipt. A retry of the same owned Codex or Claude prompt
returns existing delivery evidence without typing, or submits only Enter when the exact
original remains in the composer. Owned text back in the composer always gets Enter, even
with retained evidence, and only records after that submission prove it. It never pastes that prompt again. A synchronously
native-verified send clears its receipt under the transport lock and returns its
evidence, so direct callers can send again after the turn completes. Late native acceptance
remains recorded across inspections. For Codex, an accepted receipt does not block a different
handoff once the live queue and composer are clear. The old receipt remains available for
its exact-payload retry and explicit acknowledgement; a fresh handoff gets its own receipt.
Questions, foreign drafts and live queued input still refuse delivery. Idle-only runners
and explicit flush retain the `acceptance_unacknowledged` guard.

The caller that persists delivery evidence owns the transport ACK, not the receiving lane.
Direct callers retain their result or trace, then call
`scripts/ack-acceptance.sh <pane> <runner> <receipt_id>` with the same state directory and socket.
The lane CLI performs this acknowledgement after persisting its registry state. A recipient's
task-level reply does not consume a transport receipt. Never ACK another caller's receipt to
unblock a new handoff. Receipt and lock identity uses the server socket, not the caller session. Old caller-specific receipts remain discoverable without migration.
Repeated acknowledgements are harmless; inspection
never consumes a late receipt. Receipt updates share the send lock and use atomic private writes.

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
- `TMUX_MODEL_DRIVER_PROBE_TIMEOUT_MS`: positive integer native shell-probe budget in milliseconds, default 10000. Pane state and send preflight use this same budget. Process-owned rollout headers are checked together; large histories retain their full native boundary and question checks. This is separate from the verification retry window. Lane callers must allow enough total time for startup and all probes.
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
- `resolve-launch-blockers.sh <pane> <runner> [seconds]` resolves known
  Cursor workspace-trust, Grok current-project and Codex startup update gates for the expected
  live runner. Update menus use the shared skip choice after a fresh process/pane check.
  Auth gates and model questions require the lead.
- `headless-exec.sh --last <file> --log <file> --timeout <seconds> -- <command>`
  closes stdin, records the process exit code and requires an anchored terminal
  marker in the final-message artifact. Headless Claude review must follow the
  project's review policy; use the interactive path when required.
- `write-trace.py <trace> <event-json>` appends trace events.

Runner behavior belongs in the shared capability and observability adapters.
Run the matching live scenario under `scripts/runner-validation/` for behavior
proof. Unit tests guard regressions; fixture runners are never live proof.
