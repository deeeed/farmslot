# ADR-067: CI decision check context

Status: Proposed

## Context

Phone CI decisions show gate-time prose while Command Center reads `pr.status`
for current checks. That existing RPC has names and coarse states, but omits
conclusions, timestamps and links. Three of the six CI decision types also omit
check context. The requested fix is one comparison inside the existing decision
workspace, with read-only refresh.

## Decision

Add one optional read-only `PRStatus.checkSnapshot` field, containing PR/repository identity, a fetch
timestamp and individual GitHub check rows. Keep existing watched groups,
recommendations, actions and cache semantics. Extend the existing GitHub check
queries with state and link fields; do not add another endpoint or request.

Use the same normalized rows for CLI fetches and GraphQL batch prefetch. Status
records progress or completion; conclusion retains the provider's reported
terminal state. Missing values remain unknown. A check's age uses its latest
recorded completion/start timestamp or legacy status creation timestamp; the fetch age is separate.

Retain the snapshot with every newly raised `ci_*` decision. Companion refresh reads
`pr.status` with `force: true`; it does not overwrite that gate snapshot, resolve
the decision or alter its actions. Old decisions keep their recorded coarse
checks or explicitly show that no snapshot was recorded. Never invent old
conclusions, times or links from current data.

Own the comparison view-model in `@farmslot/protocol`, used by Command Center's
existing CI decision renderer and Companion's existing decision workspace/panels.
Only presentation differs by platform. Refuse current data for a different PR
or repository, and keep snapshot data visible during loading or refresh failure.

## Public surface

- RPC: additive optional `PRStatus.checkSnapshot` on existing `pr.status` only; existing `force` refresh flag. No new RPC, command or CLI flag.
- SDK: named check snapshot/row types and a pure CI decision view-model in
  `@farmslot/protocol`, consumed by the gateway and both operator clients.
- Persistence: additive `RunDecision.context.checkSnapshot` on the six CI
  decision types; existing records remain readable without backfill.
- Harnesses inherit the gateway response and decision context. No new harness
  hook, project policy, gate-resolution rule or schema-version change.

## Non-goals

Gate-review screens, review posting, review verdict curation, CI reruns,
auto-resolution, new CI policy, historical check reconstruction and farm changes.

## Verification

Unit checks cover all six decisions, legacy/missing data, PR identity, changing
current checks, immutable snapshot and ages. Real read-only RPC proof covers
metadata and force refresh. An iOS recipe opens CI decisions, refreshes in place
and captures HUD stills with intents under 80 characters and no error banners.

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

The iOS proof uses a non-validation CI-watch run on a real open PR, with a sandbox
watched group that never matches and a short hold timeout. It opens the resulting
pending CI timeout, refreshes, and reads gateway state to prove snapshot/actions
and unresolved state stay intact while current metadata reloads. A seeded legacy
decision covers unrecorded data. Other CI types are covered at unit level. No
inline fixes, model dispatch or review posting are part of the proof.

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
