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
Let the transport select the runner's submission key. Never resend buffered text or send a model prompt to
a shell. A send reports exact native acceptance or complete driver-owned Codex queue delivery
with a retained receipt. Queue delivery does not claim a new turn.

Read and surface pending questions before answering. A blocked question, shell, or foreign queue stops a send. Codex busy/unknown
phases accept steering with exact native proof or the complete owned submitted-queue marker.
The queue receipt survives until delivery acknowledgement; a same-prompt retry uses its
evidence or submits only the owned composer with Enter. Other runners
still require idle readiness. The lane CLI retries an acknowledgement for up to 5 seconds while
the driver is busy. When the runner no longer proves a recorded delivery because its input was
pulled back unsent, the lane's `last_delivery` gets `pulled_back: true` and `send` reports
`pulled_back: true`: the handoff is undelivered even though `delivery.submitted` is true.
After reading its choices, use the driver's `answer-question.sh <pane> <runner> <question_fingerprint>`
with an explicit JSON key list on stdin. It refuses if the pane, session, or question changed.
A response acknowledgement does not itself prove a new turn. Interactive attachment is also available. Flush only driver-owned buffered input with `flush <lane>`.
It sends Enter without adding text and verifies acceptance again.

Each lane has GOAL.md, REPORT.md, and file reservations. Use `reserve <lane> <paths...>` and
`transfer <source> <destination> <paths...>` for ownership changes. The registry rejects overlap.
Keep REPORT.md current with state, canonical PR, full head SHA, next step, and blockers.
Launch Codex with its native `/goal`. For Claude, install the supplied
[goal command](templates/goal.md) as the lane checkout's `.claude/commands/goal.md`, then set
`goal_command` to `/goal`. Restore resumes the recorded session and leaves surviving panes intact.

Optional lane `model` and `effort` select the runner model and reasoning effort at launch and
resume. Omit them to use the runner's defaults. The shared runner adapter receives both unchanged.

Launched panes keep an interactive shell after the runner exits, including `/quit` or a failed
turn. `lanes-status` shows `session_id`; when the runner is absent this is the last recorded
native session, not evidence of an active runner. To recover, set that lane's `resume_id` to
this ID in the private config, then run `launch <lane>`. Launch resumes in the retained shell
through the guarded shell driver, or creates a pane if the session disappeared. A running
runner remains untouched. Recovery preserves an already-submitted goal.
If startup failed before a native session existed, `launch` can retry fresh in its own
retained pane after the startup cause is fixed. It checks the saved process identity and
refuses an unrelated or replaced shell.

Fresh launches and resumes suppress startup update checks. If an update menu still appears,
the driver rechecks the runner and pane and submits the shared skip choice once. It never
updates the runner or answers a model question. Native readiness is still required afterward.

`lanes-status` observes without persisting bindings or acknowledging receipts. Existing lanes
may configure `pane_id` and `observability_dir`. Unhooked native sessions held open by a foreground
process can supply observational state; status observation does not authorize recovery. Codex transport rechecks process-owned
native session identity and proves exact prompt acceptance without installing hooks.
Unknown state is reported explicitly. Keep paused and farm-managed sessions outside recovery.

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

Configure `reviews.legacy_root` for existing PRs. Their canonical verdict files remain there until
merge; do not copy historical rounds or start new state for them. Only new PRs use durable review
state. A new review state always owns its verdicts exclusively, with no fallback to old approvals.

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
- Final round: run the full `yarn quality` once on the final committed SHA when lane rules permit it.
- If full local quality needs a real or private tmux server that the lane may not start, accept
  focused local gates plus green CI on the final committed SHA. Record the prohibited server cases,
  focused commands, results and exact-head CI evidence. Do not start a server to satisfy local quality.

Record commands, evidence, and measured test durations before another review. The loop stops only
when the final validation rule is satisfied, required evidence passes, both latest reviews approve
the final committed SHA, and CI is green. Never start or kill a real tmux server in tests.
Use a private socket with teardown. Default tests take less than five seconds each and default
suites less than five minutes; live proofs belong outside CI. Never rebuild shared dist under readers.

## Lead loop

Use `heartbeat` to inspect lane state, missing nodes, protocol mismatches, PR verdicts/CI, round 4
alarms and approved PRs still unmerged. It discovers PR references and GitHub PR URLs in lane reports
and optional `reports` paths/globs. Existing PRs need no review-state migration. Configure project
`heartbeat_hooks` for machine checks; these are names of existing argv hooks. Mark mutating names
in `mutating_heartbeat_hooks`; `heartbeat --read-only` reports those as skipped. Errors stay visible
without hiding other lane, hook or PR observations.

Use `attention <owner/repo>` with a `runs` hook returning run-list JSON. Failed, blocked or active
runs unchanged for 20 minutes alert with ticket, slot and error. Missing timestamps have age zero.
Deduplicate by run ID plus status permanently, including after recovery or timestamp changes.
An optional project `attention_seen_file` seeds acknowledgements read-only from legacy ID|status
lines. `attention <owner/repo> --watch` waits at 120-second intervals until a new alert appears.

Run `ready <owner/repo> <n> <sha> <REPORT.md>` to validate and write MERGE-READY.
`merge-watch` is a dry run. `merge-watch --execute --watch` polls every minute and merges only
repositories with `auto_merge: true`. An explicitly authorized project can set `merge_admin: true`
for its existing GitHub approval override. Every readiness gate still applies. Require an open PR
at the reported head, both latest approvals, non-Vercel CI present and every check completed with
SUCCESS/SKIPPED/NEUTRAL, no unresolved threads, confirmed mergeability and a clean portability scan.
`ci.no_ci_repos` is the explicit absent-CI exception list; failures still block those repositories.
Project `required_workflows` names require successful Actions runs at the exact head.
`ci.workflow_skip_repos` or the read-only `ci.workflow_skip_file` waive workflow presence only.
Optional `required_checks` still require named successes. Vercel is excluded from all CI gates.

MERGE-READY markers may appear anywhere in configured reports, with a full SHA. One execution
pass merges at most one PR, then exits so the next pass rereads mergeability. Drafts are marked
ready only after all gates pass, followed by an exact-head recheck before merge. Conflicts alert
once per head and never merge. Merged/closed heads are remembered and suppressed in later passes.
Dry runs never mark drafts ready or write to GitHub. Merge commands pin the head SHA.

Project `forbidden_patterns` and `portability_exclusions` are regex lists. Exclusions match added
lines or their diff filenames, covering configured guard code, tests and examples. The built-in
home-path scan honors the same exclusions. Keep exclusions scoped to those files or guard lines.

Configure gateway update, node deploy, package sync, cleanup, or other project steps as named hooks.
Run them with `hook <owner/repo> <name>`. Core code does not choose live checkouts or deployment nodes.
Keep historical [review JSON templates](templates/CROSS-REVIEW-LOOP.json) for evidence compatibility;
their schema does not replace the live verdict contract.
