---
name: cross-model-orchestrator
description: Run long goals across isolated model lanes, independent review rounds, and a lead merge loop through tmux. Use for multi-lane goal orchestration, cross-model PR review, lane recovery, heartbeat, merge-watch, or run attention.
---

# Cross-model orchestrator

Use one local config and durable state directory for the lead's lanes and reviews.
Start with the [two-lane quick-start](../../../docs/operations/cross-model-quick-start.md).
Read the [concepts and migration map](../../../docs/reference/cross-model-orchestration.md)
when cutting over an existing loop. Copy [config.example.json](templates/config.example.json)
outside the tracked checkout and fill in project values there.

Run `python3 .agents/skills/cross-model-orchestrator/scripts/orchestrate.py --config <config.json> <command>`.
Config paths resolve relative to its file. Hooks are project-owned argv commands with bounded
timeouts. Keep machine IDs, credentials, deployment choices, and auto-merge permissions in config.
This skill does not grant permission to commit, publish, or merge.

## Transport and lanes

All lane input goes through [tmux-model-driver](../tmux-model-driver/SKILL.md).
Use `launch <lane>`, `lanes-status`, `send <lane> --file <message>`, and `restore`.
Launch syntax, resume, hooks, and acceptance evidence come from the shared runner adapter.
Submit with named Enter. Never queue with Tab, resend buffered text, or send a model prompt to
a shell. A send succeeds only with structured exact-prompt acceptance evidence.

Read and surface pending questions before answering. A blocked question, busy turn, unknown
state, shell, or foreign queue stops a send. After reading its choices, use the driver's `answer-question.sh <pane> <runner> <question_fingerprint>`
with an explicit JSON key list on stdin. It refuses if the pane, session, or question changed.
A response acknowledgement does not itself prove a new turn. Interactive attachment is also available. Flush only driver-owned buffered input with `flush <lane>`.
It sends Enter without adding text and verifies acceptance again.

Each lane has GOAL.md, REPORT.md, and file reservations. Use `reserve <lane> <paths...>` and
`transfer <source> <destination> <paths...>` for ownership changes. The registry rejects overlap.
Keep REPORT.md current with state, canonical PR, full head SHA, next step, and blockers.
Launch Codex with its native `/goal`. For Claude, install the supplied
[goal command](templates/goal.md) as the lane checkout's `.claude/commands/goal.md`, then set
`goal_command` to `/goal`. Restore resumes the recorded session and leaves surviving panes intact.

## Review

Run `review --repo <owner/repo> --pr <n> --cwd <worktree> --report <REPORT.md>` for one round.
The worker owns fixes and checks. The orchestrator owns reviewer state and sends one consolidated
blocker handoff. Require independent Codex and real Claude reviews of the same committed head.
The default Claude invocation is a direct terminal review. Set `reviews.lanes` to a map of
`codex` and `claude` reviewer lane IDs for retained interactive reviews through the driver.
Each reviewer lane must use the PR worktree. Existing first-round sessions need their exact native
IDs in `reviews.clean_sessions`; fresh lanes start without a worker goal. Session identity stays
bound to one canonical PR. Missing or changed identity, pending questions, queued input, or a
timeout fails the round. Fresh subprocess fallback records prior findings and its continuity choice.
Project config may choose reviewer argv commands. Missing output never approves.

Only the latest top-level `codex.md` and `claude.md` in the PR's review directory count.
Their first two lines must be exactly:

```text
VERDICT: APPROVE
COMMIT: <full SHA>
```

Use `REQUEST_CHANGES` for a blocker. Preserve history in `rN/`; coordination JSON and old verdicts
never authorize merging. Round 1 reviews the full PR. Round 2+ reviews only the saved previous-head
to current-head delta and named fixes. Preserve settled decisions in each prompt. Do not reopen
unchanged code except for real funds, credentials, or user-data loss. Nits never block.
Every blocker needs a realistic failure and a changed file and line. Speculative hardening goes
under FOLLOW-UPS. Deleted capabilities need a new home or evidence that they have no callers.

The hard maximum is five rounds, including failed or interrupted reviewer rounds. At round 4
without convergence, write `ESCALATE <owner/repo>#<n> r4: <reason>` at the top of REPORT.md and
tell the lead before pushing again. At round 5, write `STOPPED <owner/repo>#<n> r5: design problem
| scope creep: <diagnosis and proposed cut or redesign>`. Stop pushes and reviews until the lead decides.

Two exact-head approvals freeze further work. Check CI and emit
`MERGE-READY <owner/repo>#<n> <full SHA>` immediately when green. New requests and hardening become
FOLLOW-UPS. Only merge-conflict resolutions may change a frozen head, reviewed with
`--conflict-only --conflict-files <paths...>` against the saved frozen head. The first resolution
saves its allowed files; subsequent conflict rounds cannot widen that manifest. For a merge from
main, save `git rev-parse AUTO_MERGE` before resolving and pass that immutable tree as
`--conflict-base <SHA>`. The review then excludes unrelated changes imported from main. They still count
toward the hard maximum.

## Validation Contract

- Intermediate rounds: run the exact affected tests for the changed files, then `yarn prepush:quality`.
- Final round: run the full `yarn quality` once on the final committed SHA.

Record commands, evidence, and measured test durations before another review. The loop stops only
when the full `yarn quality` has been run once on the final committed SHA, required evidence passes,
both latest reviews approve it, and CI is green. Never start or kill a real tmux server in tests.
Use a private socket with teardown. Default tests take less than five seconds each and default
suites less than five minutes; live proofs belong outside CI. Never rebuild shared dist under readers.

## Lead loop

Use `heartbeat` to inspect lane state, missing nodes, protocol mismatches, PR gates, round 4 alarms,
and approved PRs still unmerged. Use `attention <owner/repo>` with a `runs` hook returning run-list
JSON. Failed, blocked, or stale active runs raise one alert per changed state and rearm after recovery.

Run `ready <owner/repo> <n> <sha> <REPORT.md>` to validate and write MERGE-READY.
`merge-watch` is a dry run. `merge-watch --execute --watch` polls every minute and merges only
repositories with `auto_merge: true`. Require an open non-draft PR at the reported head, both latest
approvals, at least one CI check, every check finished without failure, at least one successful check, no unresolved threads,
confirmed mergeability, and a clean portability grep. The merge command pins the head SHA.
Completed skipped or neutral path-filtered jobs are allowed alongside a successful check.
Required checks must succeed. No empty-check or failed-check exception is implied by config.

Configure gateway update, node deploy, package sync, cleanup, or other project steps as named hooks.
Run them with `hook <owner/repo> <name>`. Core code does not choose live checkouts or deployment nodes.
Keep historical [review JSON templates](templates/CROSS-REVIEW-LOOP.json) for evidence compatibility;
their schema does not replace the live verdict contract.
