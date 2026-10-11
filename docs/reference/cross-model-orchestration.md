# Cross-model orchestration

The [cross-model-orchestrator skill](../../.agents/skills/cross-model-orchestrator/SKILL.md)
coordinates lanes, independent reviews, and merge checks through one CLI.
Workers own fixes, tests, and evidence. Reviewers own findings. See the
[two-lane quick-start](../operations/cross-model-quick-start.md).

## Lanes and configuration

Version 1 configuration declares `state_dir`, a private tmux socket name, lanes,
and projects keyed by `owner/repo`. File paths resolve relative to the config.
Each lane has a runner, checkout, GOAL.md, REPORT.md, and reservations.
Project configuration supplies merge permission, hooks, portability patterns,
and expected node IDs. Keep local config and state outside the tracked tree.

All lane messages use `tmux-model-driver`. The runner adapter owns launch syntax
and structured acceptance signals. Questions and queued input stop ordinary delivery.
`restore` recovers missing sessions, leaving surviving sessions alone.
`reserve` and `transfer` persist ownership changes without reapplying old config reservations.

## Review and merge

Round 1 reviews the branch. Round 2+ receives the saved previous-head to current-head
delta and prior findings. Use `reviews.lanes` for retained reviewer panes. Native session IDs bind
each pane to one canonical PR; first use of an existing pane needs `reviews.clean_sessions`.
Fresh subprocess reviews record the fallback. Only top-level `codex.md` and `claude.md` authorize progress:

```text
VERDICT: APPROVE|REQUEST_CHANGES
COMMIT: <full SHA>
```

Round history and JSON logs cannot override those files. Blockers require a realistic
failure. Nits become follow-ups. Settled code is reopened only for funds, credentials,
or user-data loss. Escalate at round 4; stop at round 5 with a design or scope diagnosis.

Both approvals freeze the head. `ready` checks CI and the merge gate, then writes
`MERGE-READY owner/repo#number <SHA>` to REPORT.md. Later work goes under `FOLLOW-UPS`.
`merge-watch` defaults to a dry run. Execution requires project permission, the matching
head, both approvals, at least one finished CI check, all checks green, resolved review
threads, and a clean portability scan. `heartbeat` exposes lane state, missing nodes,
review escalation, and approved PRs waiting to merge. `attention` reads the project's
`runs` hook and reports failed, blocked, or stale runs. Hooks execute bounded argv commands.

## Removed capability map

The old `fs-cross-review-loop` folder has no shim.

| Previous capability                                                                  | New home                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Pane discovery, routing, worker/reviewer boundaries                                  | `lanes-status`, `send`, and review protocol                                       |
| Retained reviewer sessions                                                           | `reviews.lanes`, exact native identity, and persisted PR bindings                 |
| Prior findings and immutable reviewed ranges                                         | Saved review state, round history, and delta prompts                              |
| Retained reviewer process                                                            | Configured reviewer commands may select a persisted session; defaults start fresh |
| Optional cross-model review and cycle limit                                          | Required independent pair, four-round escalation, five-round stop                 |
| Evidence scope, command restrictions, grouped findings, validation and fix summaries | Review prompts and coordination artifacts                                         |
| Blocking nits and clean/escalated stopping                                           | Follow-ups and exact-head approval policy                                         |
| Compose, busy-pane, shell-launch and secret safety                                   | Required driver and runner adapter                                                |
| Markdown/JSON templates and schema                                                   | New skill's `templates/` directory                                                |
| Per-round validation gate and artifact validator                                     | `quality:review-loop` and `scripts/validate-cross-review-loop-json.mjs`           |
| Shared gateway review policy, observability and costs                                | Existing gateway integration and runner capabilities                              |

The old authoring prompt is folded into the canonical skill. The moved schema still
validates historical `PASS`/`ISSUES` artifacts. Those records never authorize live approval.
