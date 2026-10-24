# CI decision check context

**Status:** Accepted under [ADR-064 Amendment 1](../adr/064-deterministic-checklist-checks.md#amendment-1-2026-10-12-ci-decision-check-context).
**Implementation:** Merged in [#951](https://github.com/deeeed/farmslot/pull/951).

## Contract

The six decisions are `ci_inline_fix_blocked`, `ci_merge_conflict`,
`ci_ci_timeout`, `ci_review_comments`, `ci_ci_failed` and
`ci_review_comments_early`.

Existing `PRStatus` may include `checkSnapshot`, with `fetchedAt` as an ISO
timestamp and an array of check rows. Each row has a name, normalized progress status, nullable provider conclusion,
nullable latest source timestamp and nullable check link. A legacy status creation
time is an activity timestamp, never a check-start claim or duration. Every individual check is included, rather than only
watched group summaries. GitHub CLI and GraphQL sources use the same row model.
Check age uses the latest recorded completion/start timestamp, or a legacy status
creation timestamp; fetch age is a separate measurement. Status records progress
or completion, while conclusion retains the provider's reported terminal state.

New CI decisions retain that same field in `context.checkSnapshot`, without changing which older decision types carry watched-check context. The snapshot belongs to the gate's creation
and remains unchanged on refresh. Older records may lack the field; their
recorded coarse checks remain usable, and absent metadata must say it was not
recorded. An absent snapshot must never become the current PR's check data.

Both renderers label **Gate snapshot** and **Current PR checks** separately and
show name, status, conclusion, age and check link where recorded. Fetch age is
labelled separately from check age. Unknown ages/links/conclusions are explicit.
Empty current checks differ from current checks that have not loaded.

Companion refresh uses existing `pr.status` with `force: true`. The client binds the
response to the selected decision's PR/project/repository and active connection;
late responses from another decision or connection cannot replace it. Loading
and failure keep the frozen snapshot visible and expose a retry. Refresh does
not resolve, rerun, publish or modify the gate's actions.

## Public surface

### CI-watch run cards

Command Center and Companion MUST show a shared plain-text CI-watch summary on
the run card and run pipeline. It uses the recorded `checkSummary`, failing check
names, actionable comment count and `nextPollAt`. A green check count does not
hide outstanding actionable comments. Decisions, paused runs and active worker
fixes MUST describe their actual activity instead of advertising a poll.

The existing CI monitor MUST project optional `progressTimeoutAt` and
`totalTimeoutAt` ISO timestamps into its step outputs and update events. They
come from its current no-progress and total-window clocks plus configured limits,
including progress resets and an operator's existing Keep waiting action. This
adds observation only; timeout, polling, fix and decision behavior is unchanged.
The no-progress default is two hours. Total defaults to the larger of six hours
or three configured no-progress windows; project overrides remain authoritative. Clients MUST use the earlier recorded deadline, never
reconstruct a total window from the run or step start, or invent default limits
for a legacy record. Past deadlines say timeout is due until the engine raises
its decision. Countdown clocks stop when the run is no longer watching.

`@farmslot/protocol` owns the optional output/event fields. The stable additive
`ciWatchStatusView` export belongs to `@farmslot/review-dispatch`; both clients use
that model and one thin renderer per platform. `run.list`, run detail and events
already carry the step outputs. There is no new RPC, CLI flag, harness hook or
wire version; fresh SDK/shared minor releases carry these additions.

### CI decision check snapshots

`@farmslot/protocol` owns the snapshot types and comparison view-model. Gateway
`pr.status` returns the optional field; the CI monitor retains it when
raising a decision. Command Center and Companion use the same model inside their
existing decision components. No additional CLI flag, RPC or harness hook.

The optional snapshot and named row/view-model exports are additive package and
decision-context changes. Existing watched groups, recommendations, actions and
cache semantics remain unchanged. Extend the existing check queries without an
additional request or endpoint. Harnesses inherit the gateway response and
decision context, without a new project policy, gate-resolution rule or schema
version. Gate-review screens, review posting/curation, CI reruns, auto-resolution,
historical reconstruction and farm changes remain outside this contract.

## Read availability and refresh boundary

Populate the field only for successful complete check reads. A genuine empty
rollup is an available empty snapshot. Failed reads and truncated batch pages
have no snapshot; they must not look like zero checks. Keep list-cache payloads,
backoff, broadcasts and existing watched summaries unchanged.

Preserve `PRRawSnapshot.fetchedAt`. Both transports emit state/link metadata
through one normalizer. CLI `state` is the reported conclusion for terminal
states and progress otherwise; GraphQL emits the equivalent state. Treat zero
times such as `0001-01-01T00:00:00Z` as missing. Preserve duplicate returned check
rows rather than joining by name. Snapshot and current sections list their own
rows; they do not claim a one-to-one join by name.

Freeze PR number and repository identity in the snapshot. Do not add commit
identity or attempt to reconstruct historical fields. Refresh is disabled while
one request is pending and ignores stale connection/decision responses.

The new Companion refresh path is read-only. Command Center consumes the shared
model only in its existing renderer; its existing timeout auto-resume and timer
remain separate and unchanged. This work adds no call to their resolver.

## Existing desktop data and bounded list projection

Companion shows both sections for all six CI types. Command Center uses the
shared model for the gate snapshot on all six, and current checks only for its
existing timeout fetch. Its other CI decisions omit the current section. The
model's `current not requested` state is distinct from loading, unavailable and
available-empty. No desktop fetch, timer, resolver or retry is added. The
read-only refresh/retry rules above apply to the new Companion path only.

`run.list` omits `context.checkSnapshot`, marking the omission with the existing
`payloadTrimmed` key list using `context.checkSnapshot`. The full run store,
`run.get`, `decision.list` and run/decision events retain it. Both clients use
the marker and their existing detail hydration, showing snapshot loading rather
than claiming nothing was recorded. Other context fields remain unchanged.

A successful CLI no-check response yields available-empty data. If the CLI
reports no checks as a failed query, keep unavailable; do not parse its message
or invent a successful read. Different provider paths can retain different
counts of repeated check names, so both sections list independent rows.

## Acceptance

Unit checks cover all six decisions, legacy/missing data, PR/repository identity,
changing current checks, immutable gate snapshots and ages. Real read-only RPC
proof covers metadata and force refresh.

The iOS proof uses a non-validation CI-watch run on a real open PR, with a sandbox
watched group that never matches and a short hold timeout. It opens the resulting
pending CI timeout, refreshes, and reads gateway state to prove snapshot/actions
and unresolved state stay intact while current metadata reloads. HUD stills have
intents below 80 characters and no error banners. A seeded legacy decision covers
unrecorded data. Other CI types are covered at unit level. No inline fixes, model
dispatch or review posting are part of the proof.
