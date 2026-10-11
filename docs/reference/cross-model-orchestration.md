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
Status reads neither persist lane bindings nor acknowledge delivery receipts. Configure existing
pane IDs and hook directories in `pane_id` and `observability_dir`; unknown native state stays
explicit. A read-only native transcript probe can observe manual lanes without installing hooks.

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
threads, and a clean portability scan. Vercel is excluded; completed SUCCESS/SKIPPED/NEUTRAL
checks pass. `ci.no_ci_repos` explicitly lists absent-CI exceptions. Project `required_workflows`
requires successful Actions runs at that head; `ci.workflow_skip_repos` and `ci.workflow_skip_file`
waive only workflow presence. One pass merges at most one PR. Drafts are readied after the gate
and rechecked; conflicts alert once per head, merged/closed heads are suppressed. Markers may be
embedded in configured reports. Portability exclusions match added lines or filenames, including
the built-in home-path scan.

Existing PRs keep their legacy verdict files under `reviews.legacy_root` until merged. Never
migrate historical rounds. New review state takes exclusive ownership of its latest verdicts.
`heartbeat` discovers PR references from reports and exposes lane state, missing nodes,
review escalation, and approved PRs waiting to merge. `attention` reads the project's
`runs` hook and reports failed, blocked, or stale runs with ticket, slot and error. It remembers
run ID/status pairs permanently and may read a legacy `attention_seen_file`. `attention --watch`
waits for new alerts. Hooks execute bounded argv commands. Project `heartbeat_hooks` calls existing
machine scripts; `heartbeat --read-only` skips names listed in `mutating_heartbeat_hooks`.

Final review validation uses full local quality when permitted. If that suite requires a real
or private tmux server the lane cannot start, record focused local gates plus exact-head green CI.

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
