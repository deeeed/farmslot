# Gateway change notifications

**Status:** Specification for [ADR-071](../adr/071-gateway-change-notifications.md), accepted 2026-10-19.
**Owner:** Farmslot gateway and protocol maintainers.
**Delivery:** Unimplemented. This document defines a proposed contract, not available APIs.

## Public surface

`@farmslot/protocol` owns the wire types and the portable SDK cache. The proposed
`@farmslot/protocol/client-cache` entry exports `ResourceKey`, `ResourceRevision`,
`ResourceQuery`, `ResourceQueryState` and `createGatewayResourceCache`. Command
Center and Companion are the only consumers. The module must run in browser and
React Native environments without Node APIs or a framework-specific state library.
The package rule that protocol holds contracts, not implementations, already has
portable client controllers as exceptions (`SourceStatusController`,
`PersonSessionClient`); the first implementation step amends that rule for this
cache rather than adding another package.

`createGatewayResourceCache` accepts an authenticated request/event/connection
adapter. It exposes `observe(query, listener)`, `read(query)`, `retry(query)` and
`dispose()`. Observing returns an unsubscribe function. Query definitions and
event dependencies belong to this module, not to individual panels. Each client
uses one cache per gateway and authenticated session. Cache state includes data,
`loading | ready | stale | error | unsupported`, observed revisions and an error
when present. A failed refetch may retain old data only as explicitly stale data.

The proposed `RESOURCE_CHANGED` event constant in
`@farmslot/protocol/transport/events` has wire name `resource.changed`.
`GatewayAuthConnectResult.capabilities.resourceChanges` in
`@farmslot/protocol/rpc/auth` advertises `{ version: 1, epoch }`. Every
authenticated principal receives that reply, including native-only principals
that receive no `hello`. Successful cacheable read responses add an optional
`ResponseFrame.resourceState: { epoch, dependencies: [{ key, revision }] }` in
`@farmslot/protocol/transport/frames`, beside `payload`. A negotiated read that
lacks this metadata leaves its query `stale` (or `unsupported` when the method
never provides it); the cache never treats such a reply as current. Existing
payload DTOs and mutation preconditions remain authoritative.

There are no new CLI commands or flags. Existing RPC reads supply data and
existing mutations perform actions. `@farmslot/cli`, mm-harness and recipe
workers are not consumers and gain no extension point: the key registry is
closed to packs and harnesses. Nothing outside the gateway emits revisions, and
an invalidation never implies that a command succeeded. The contract starts experimental. Implementation must
publish matching protocol exports and document compatible gateway/client
versions before consumers cut over. Missing capabilities produce `unsupported`,
with no silent fallback to panel polling.

## Notification and revision contract

`ResourceChangedPayload` contains `epoch`, `changes` and `version: 1`.
Each change contains a typed `key`, a `revision` and `kind: updated | deleted`.
Keys are discriminated records from the catalog below, with explicit identifiers
such as `runId`, `slotId`, `nodeId` or `project`. They are not paths, arbitrary
strings or client-authored selectors. Collection keys include their ownership
scope. The protocol query registry canonicalizes query parameters, including
filters, pagination and projection options.

- An epoch is an opaque gateway-process identity. Revisions are nonnegative safe
  integers with one counter per key, never one global sequence, so a principal
  cannot infer other principals' write volume. A restart creates a new epoch;
  revisions from different epochs are never compared.
- A committed change advances affected keys and publishes only after their read
  methods can return that revision or a newer one. Publication happens on the
  store/writer path after commit, not from a request handler's `emit`, which
  reaches only the calling socket ([ADR-053](../adr/053-run-lifecycle-transition-routing.md)).
  Each ordered effect advances its own store's keys after that effect commits.
- A read samples its dependency revisions before reading the data and stamps the
  reply with them. The data is then at or above its stamp, and a write landing
  during the read publishes a newer revision that triggers the next refetch.
- A writer includes detail, collection and derived projection keys affected by
  insertion, update or deletion. Broad scoped collection invalidation is allowed
  when finer dependency tracking would be unsafe. Filters do not excuse missing
  newly inserted members. Deletion invalidates list membership and evicts the
  detail after an authorized not-found response.
- Node observations and filesystem/mirror observers notify through their owning
  gateway service. A completed recipe alone cannot claim that its mirrored
  artifacts are readable. Mirror arrival publishes its own change.
- Notifications may coalesce to the highest revision per key. Each family
  declares a minimum publish interval; `workspace`, `progress`, `native-session`
  and operation-log keys must coalesce so a burst of writes, such as a worker's
  code generation, cannot drive back-to-back reads. Duplicates and out-of-order
  revisions are harmless. The cache does not treat websocket `seq`
  gaps as lost changes: existing sequence numbers also cover events filtered out
  by authorization. A dropped event on an otherwise open connection must force
  connection resynchronization; it cannot be silently discarded by backpressure.
  A receiver whose authorization check throws is disconnected for
  `resource.changed`, not skipped as broadcasts are skipped today.
- This is invalidation, without replay guarantees or a durable event log. The
  transport must preserve delivery on a live connection or close it. Reconnect
  invalidates all observed data regardless of whether the epoch changed.

## Resource catalog

All rows use the single `resource.changed` event. These are typed key families,
not additional websocket transports. Exact identifier fields must be finalized
in the protocol registry before implementation; each row needs writer coverage.

| Key family and scope                                         | Changes that advance it                                                                        | Reads/projections invalidated                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `runs`, project; `run`, run ID                               | Create, step output, status, ownership, archive/delete, replay and recovery                    | Run lists/detail and scoped active-run queries                            |
| `family`, family ID                                          | Member run, comparison, iteration, evidence selection or family link changes                   | Family snapshot, observability and comparison                             |
| `decisions`, authorized scope; `decision`, decision ID       | Create, update, resolve, handoff or advice completion                                          | Inbox, decision detail and owning run                                     |
| `gate`, run and decision IDs                                 | Gate status, required evidence, visual judgment, override or resource posture reconciliation   | Gate/ready workspace and action eligibility                               |
| `slots`, project/node; `slot`, slot ID                       | Allocation, lifecycle, branch, current run, prepare/release and resource state                 | Fleet, slot detail and dispatch candidates                                |
| `node`, node ID; `pressure`, node ID                         | Connection, health sample, machine pause, admission or pressure operation                      | Node/fleet cards, pressure/history and relief dialog                      |
| `sources`, declaration/pin scope and optional source ID      | Declarations, scoped pin/unpin, resolved refs, sync progress, node materialization or run lock | `sources.status` in farm, node, draft and retained run contexts           |
| `review`, run and review identity                            | Retained result, curation, publication/retry outcome or saved review record                    | Review workspace, saved review and PR review observations                 |
| `package`, run and decision IDs                              | Explicit package rebuild, HEAD/diff change or evidence inventory change                        | Publish package, preview, binding and gate eligibility                    |
| `artifacts`, run and recipe invocation IDs                   | Inventory, mirror arrival/failure, report or recipe-run completion                             | Evidence/diff viewers, output, recipe groups and artifact availability    |
| `progress`, run and worker context IDs                       | Checklist, operation, signal or retained history update                                        | Run timeline, fleet progress and worker cockpit                           |
| `capabilities`, node/slot scope; `capability`, capability ID | Inventory, acquire, release, readiness or lease state                                          | Runtime resources and recipe target picker                                |
| `workspace`, slot or native workspace identity               | File tree/content, git/index/HEAD, diagnostics or branch diff changes                          | Editor/tree, git status/diff and workspace lists                          |
| `workers`, node ID                                           | Tmux inventory, pane/session identity, linked runner or control availability                   | Worker lists, terminal controls and runner keys                           |
| `native-session`, node/session/owner and worker binding      | Session lifecycle, structured transcript, command receipt, pending question or approval        | Native conversation cursor reads and session inventory                    |
| `profiles`, node and owner scope                             | Registered profile or workspace catalog change                                                 | Native profile/setup pickers; external login observations remain separate |
| `configuration`, authorized scope                            | Pool, project, execution template, provider or account registration changes                    | Config panels, preview and account pickers                                |
| `planning`, project and optional item ID                     | Roadmap, backlog, work graph, launch plan or delivery change                                   | Planning lists/detail and dispatch context                                |
| `pr-automation`, authorized project/team scope               | Rule, monitor, policy, queue, review intake or push enrollment change                          | Automation configuration, queue and monitor cards                         |
| `assessment`, authorized scope and optional assessment ID    | Assessment/advice/triage progress, saved result, feedback, audit or incident                   | Assessment history, advice, incidents and training exports                |
| `analytics`, authorized query scope                          | New persisted metrics/audit data or backfill completion                                        | Analytics and derived exports                                             |
| `copilot`, owner/session scope                               | Runtime, conversation context, usage observation or saved memory change                        | Copilot status and chat context                                           |
| `gateway-update`, gateway scope                              | Observed remote ref, installed version or update-operation phase                               | Version details and update progress/banner                                |
| `upstream`, registered integration/query scope               | GitHub PR/check/comment/catalog or provider account observation                                | Cached remote lists, review status, checks and account chips              |

The registry must map existing read methods to these dependencies rather than
adding a second implementation of those reads. Projection keys may depend on
multiple families. A command changes all affected keys through its owning
writer, not through a client guessing what to refresh after a successful reply.
Existing stream/data events keep their owners; terminal bytes, video frames and
chat deltas do not become cache invalidations per frame/token. Existing domain
events such as `run.updated`, `decision.*` and `fleet.updated` stay for CLI,
harness and lifecycle consumers. The shared cache treats them only as
invalidations of the queries they cover and never adopts their payloads, so one
update path owns each query during migration.

## Authorization

Resource notifications must apply the same resource- and principal-level read
authorization as their queries. For `resource.changed`, that per-key read check
replaces the event-name broadcast allowlist rather than adding to it: a principal
receives a key exactly when that key's read would return it to this principal,
including the handler's owner scoping, not only method-level authorization.
`native-session` and `profiles` keys follow native-owner access: a native-only
principal receives only the sessions and profiles its handler owns, and keeps
live transcripts and approvals without polling. Never broadcast another
principal's resource IDs, existence, revisions or scope. Private native sessions,
profiles, saved reviews and account metadata retain their existing boundaries.

Permission/session changes clear affected entries, cancel pending reads and
recompute authorized observations. Sign-out, gateway switch and principal switch
dispose the old cache. A late response cannot repopulate another session's cache.
Notifications contain no credentials, raw file paths or sensitive payloads.
Mutations still check current authority, revision/binding and existing gate
preconditions on the server. Cached freshness is never mutation authorization.

## Cache consistency and lifecycle

1. Register event and connection listeners before the initial query read. Track
   an invalidation generation per canonical query and its dependency revisions.
2. Share one in-flight read for an identical query across observers. A response
   may become ready only if its epoch/session still matches and it covers every
   dependency invalidated while the request was in flight. Otherwise retain it
   as stale and schedule one follow-up read. Never overwrite newer ready data.
3. On invalidation, coalesce affected active queries into one refetch each.
   An event arriving during that refetch leaves another read pending if its
   revision is not covered. Unknown dependencies invalidate conservatively.
4. Cursor and append reads, such as native transcripts and logs, continue from
   their saved cursor when invalidated. The existing controller keeps paging; the
   cache only signals that more data is available.
5. Inactive queries become stale without immediate reads. The next observer
   refetches them. Unsubscribe/dispose cancels owned work and prevents late writes.
   Evict inactive entries with a bounded policy; cache memory cannot grow with
   every run ever opened. This cleanup is not a network freshness timer.
6. Disconnect marks all entries stale. Reconnect refetches active queries even
   under the same epoch. Companion background pauses requests; foreground
   resynchronizes before restoring ready state. Error Retry repeats a read, never
   a mutation. A read failure keeps a visible error/stale state without an
   unbounded retry loop.
7. Commands execute outside the cache and retain their existing idempotency and
   confirmation rules. Never replay a command on reconnect. Gate/package identity
   changes invalidate old confirmations. Preserve user drafts and curation keyed
   to their retained identities; refetching must not silently rebind them.

## What stays polled or manually invoked

| Source/action                                                                                                                                         | Owner and policy                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub PRs, checks, comments, project fields and account observations without a reliable subscribed feed                                              | One gateway collector per normalized upstream query, shared across viewers. Slow poll at least 60 seconds for passive views, honor rate limits/backoff and visibility. Existing active CI monitor schedules keep their execution policy. Pending CI-timeout decisions and their client auto-resolve keep their current policy, owner and authority. Publish a resource change when the observed result or its freshness/error changes. |
| Remote release refs, package registry channels and provider login/quota state without a change feed                                                   | Gateway integration collector, passive interval at least 60 seconds and slower where quotas require. Separate observed time/error from the last successful value. Installed/node state and operation progress use notifications.                                                                                                                                                                                                       |
| Device-local Expo update availability                                                                                                                 | One Companion update integration. Check on foreground or explicit user request; any background check is at least five minutes. Download and reload remain explicit actions under the existing update policy.                                                                                                                                                                                                                           |
| Retry after a read/transport error                                                                                                                    | Keep a contextual Retry action using the shared cache. It must not become a permanent Refresh control in a healthy panel.                                                                                                                                                                                                                                                                                                              |
| Recheck diagnostics/availability, force a remote check, rebuild a package, sync artifacts, OAuth refresh, reload a worker or install/reload an update | Keep the existing explicit command and its safety checks. Label the effect. Its completion invalidates gateway observations automatically.                                                                                                                                                                                                                                                                                             |
| Local elapsed/expiry clocks, confirmation/toast timers, debounces, request deadlines, reconnect backoff, render restoration and media retry           | Keep within their existing UI/transport owners. They do not periodically fetch gateway state.                                                                                                                                                                                                                                                                                                                                          |

Node-observable filesystem, git, device inventory and native session changes are
not external polling exemptions merely because they originate outside the
gateway process. The node reports changes through the owning gateway service.
Any unavoidable sampling belongs to that service, with declared cadence and
staleness, never one sampler per panel. Recipe bridge long-poll transport and
proof-script synchronization are outside the panel-cache migration.

## Migration acceptance

The ADR orders the migration. Before deleting a freshness mechanism, each slice
must prove these scenarios with both real clients against the same gateway:

- Change data through another client, a worker or a background service. Open
  panels update without Refresh. A new/removed item updates filtered lists too.
- Change sources through sync/pin/node receipts; change retained artifacts after
  recipe completion. Clients refresh on actual readable-state arrival.
- Race a slow read with two writes; deliver duplicate/coalesced notifications.
  Old responses never restore stale ready state. A read failure remains visible.
- Disconnect or background, change state, reconnect under the same epoch, then
  restart the gateway. Active queries recover in both cases without command replay.
- Switch gateway/principal and revoke a permission. No former data, event key or
  late response crosses the authorization boundary.
- Connect two native owners and an admin at once. Neither owner receives the
  other's `native-session` or `profiles` keys.
- Run a busy writer, such as a worker generating code in a watched workspace.
  Each observed key refetches at most once per its family's publish interval.
- With multiple observers, an idle gateway produces no periodic panel reads.
  External collectors remain bounded and shared. Existing streams and explicit
  package rebuild/sync/recheck actions still work.

Review must map every removed control/timer to a notification, a retained action
or a declared external collector. The audit is a review artifact, not another
maintained specification. Keep this spec as the single consistency contract.
