# ADR-071: Gateway change notifications and shared client cache

**Status:** Accepted (owner, 2026-10-19)
**Date:** 2026-10-17
**Owner:** Arthur / Farmslot
**Delivery:** Design only. Implementation follows in separate PRs; no implementation, release or rollout is authorized by this document.
**Specification:** [Gateway change notifications](../reference/gateway-change-notifications.md)

## Context

Command Center and Companion repeatedly read gateway state because they cannot
reliably learn when it changes. An audit of both clients found 40 Refresh
controls and 30 polling loops that reread gateway-owned or node-observed state;
two of the controls also recheck an external CLI login. For example, the Sources Refresh button only rereads `sources.status`,
and screens poll runs, progress, native sessions, git status and inventories.
Opening more screens creates more reads.

The websocket already carries typed domain events, including run, decision,
fleet, PR and worker updates. Coverage is incomplete, and each client separately
decides which queries an event invalidates. A connected socket therefore does
not establish that a panel is current. Delayed reads after recipe completion
also try to guess when artifacts have reached the gateway.

This is a new client/gateway consistency contract. It extends the transport in
[ADR-001](001-gateway-architecture.md), the state ownership in
[ADR-027](027-unified-gateway-state.md), and the explicit lifecycle routing in
[ADR-053](053-run-lifecycle-transition-routing.md). Notifications do not become
lifecycle commands or a second state store.

## Decision

The gateway publishes typed change notifications on the existing authenticated
websocket. Each notification identifies a resource key and its revision.
Writers publish after the changed state is readable. Related collection and
projection keys change too, so creating a run updates both its detail and list.

One portable client cache in `@farmslot/protocol` owns query identities,
dependencies, request deduplication, invalidation, freshness and reconnect
recovery. Command Center and Companion each instantiate that same implementation
once per authenticated connection. Their renderers subscribe to shared query
state. They do not implement separate event-to-query maps or polling policies.

Each notification reaches a principal only if that key's read would return it
to that principal, including the handler's owner scoping. For `resource.changed`,
this per-key check replaces the event-name broadcast allowlist, so native-only
principals keep live native sessions and approvals, and see only the sessions
their handler owns. Existing domain events such as `run.updated` stay for
their current consumers; the cache treats them only as invalidations.

A notification invalidates data; it does not carry a replacement verdict,
grant authority, approve a gate or replay a command. Clients refetch through the
existing authorized read methods. Disconnect marks cached state stale. Reconnect
and Companion foreground recovery refetch active queries, including when the
gateway has not restarted. Stale gate data cannot authorize an action.

Panels must not poll or offer Refresh to reread gateway-owned state. Keep explicit
commands that perform work, such as rerunning diagnostics, rebuilding a publish
package, syncing artifacts or reloading a worker. Keep Retry after a failed read.
Name these actions for their effect rather than using a generic Refresh label.

External services without a reliable subscribed change feed still need slow
polling. The gateway owns one collector for each shared upstream query. It
publishes changes to the observed result. Device-local update services use one
client integration. Local clocks, reconnect backoff, request deadlines and media
streams remain under their existing owners.

## Public surface

All names below are proposed and unshipped. The specification owns their fields
and validation rules.

- `@farmslot/protocol/transport/events` adds `RESOURCE_CHANGED` with the wire name
  `resource.changed` and the typed `ResourceChangedPayload`.
- `@farmslot/protocol/client-cache` exports `ResourceKey`, `ResourceRevision`,
  `ResourceQuery`, `ResourceQueryState` and `createGatewayResourceCache`.
  Both clients consume the same query registry and cache behavior. Existing
  websocket clients provide transport adapters; the cache opens no sockets.
- `GatewayAuthConnectResult.capabilities.resourceChanges` in
  `@farmslot/protocol/rpc/auth` advertises notification support and the gateway
  epoch. Every authenticated principal receives it, including native-only
  principals that receive no `hello`.
- `ResponseFrame.resourceState` in `@farmslot/protocol/transport/frames` carries
  revision metadata on read replies without changing their domain payloads.
- There are no new CLI commands or flags. Existing read and mutation commands
  keep their behavior. `@farmslot/cli`, mm-harness and recipe workers are not
  consumers and gain no extension point; the key registry is closed to packs
  and harnesses.

`packages/README.md` keeps implementations out of `@farmslot/protocol`. Portable
client controllers (`SourceStatusController`, `PersonSessionClient`) are already
exceptions, and step 1 amends the rule for this cache rather than adding a
package.

These additions start experimental and require coordinated protocol/package
versioning and gateway capability negotiation. Existing published clients do not
gain these exports through this document. Approval and implementation releases
must be recorded separately.

## Event coverage and migration order

The [event catalog](../reference/gateway-change-notifications.md#resource-catalog)
covers runs and families, decisions and gates, slots and nodes, sources, reviews,
packages and artifacts, progress, capabilities, workspaces, native sessions,
configuration, planning, assessment, analytics and observed upstream state.

Sources is already being piloted through a Proposed
[ADR-069](069-declared-pinned-sources.md) amendment
([#1245](https://github.com/deeeed/farmslot/pull/1245)). Its change notification
uses the same shape as the `sources` key family in the catalog. That pilot is
the first consumer, not a second contract: step 1 replaces its carrier with
`resource.changed`, and step 2 moves its client handling into the shared cache,
keeping the key fields.

After design approval, implementation proceeds in vertical slices. Each slice
adds its writers' notifications, moves both clients to the shared cache, proves
write/read/event ordering, and only then removes that slice's polls, delayed
settle reads and Refresh controls:

1. Foundation: the shared key/query registry, the auth capability, response
   revision metadata, per-key authorization and cache conformance tests. Swap the
   Sources pilot's carrier to `resource.changed`.
2. Sources in both clients.
3. Runs, decisions, gates, reviews, packages and artifacts, including artifact
   mirror completion.
4. Fleet, slots, capabilities, progress, workspaces, workers and native
   sessions, including node-reported file, git, device and task-progress changes.
5. Configuration, planning, assessment, analytics and copilot.
6. Upstream and gateway-update collectors (gateway update status, runner seats,
   GitHub accounts, PR review threads). Remove remaining duplicate client
   caches and event mappings, and enforce the panel rule in review/CI.

Each implementation PR must name its writer/read/query/event mappings and audit
rows. Mixed deployment reports unsupported or stale state explicitly; it must
not hide missing coverage behind a new polling fallback. No migration changes
frozen task tooling, retained evidence or decision authority.

## Alternatives and consequences

| Alternative                                                  | Reason not selected                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Add a source-specific event and keep per-panel refetch logic | Fixes one screen while retaining duplicated dependency and reconnect behavior.          |
| Poll everything through one client timer                     | Reduces timer count but still delays changes and performs reads when nothing changed.   |
| Push complete replacement objects for every query            | Couples events to every projection and can overwrite newer data with an older response. |
| Add another transport or durable event log                   | Unnecessary for invalidation. Reconnect can rebuild current state from existing reads.  |

Writers take on a completeness obligation: every visible state change must
invalidate every affected query. Revisions and shared race handling make that
obligation testable. The cache reduces duplicate reads but introduces dependency
metadata and stale/error states that both clients must honor.

The design provides current observations, not a globally atomic farm snapshot or
an event history. Upstream observations retain their observation time and errors.
Notifications never make unknown external state current. Read failures remain
visible, and user drafts and review selections survive invalidation.

## Amendment 1 (2026-10-20): Persistent client store

**Status:** Accepted (owner, 2026-10-20). Design only; implementation follows in separate PRs.

### Decision

The shared cache keeps the results of registered queries, and the content it
has fetched, in one local store. Views observe cache queries as before. The
cache loads stored results when it starts. Companion stores them with
`expo-sqlite`. Command Center and its desktop app store them with SQLite
WebAssembly on its `opfs-sahpool` storage, in a dedicated worker, which needs no
cross-origin isolation. Where no persistent store can open, the cache keeps
results in memory and shows that they will not survive a restart. That includes
a Command Center page served over plain HTTP from another machine, because
browsers expose this storage only to secure pages.

A stored result is a cache. It never grants authority. A change to the local
schema deletes the store, and the next reads rebuild it.

**Stale first.** On cold start and on reconnect, each stored result renders at
once as `stale` and shows its age. The ADR-071 rules then apply unchanged.
Active queries refetch, and a result becomes `ready` only from a read on the
current connection. A disconnect keeps results on screen as `stale`.

**What is kept.** Each registered query is marked persisted or not, with a size
bound. Persisted: the run list, run details for runs that were opened or
prefetched, decisions with their gate packages, fleet and slots, nodes, backlog,
dispatch queue, work graphs, roadmap, projects, sources, recent chat history, PR
and other upstream observations with their observation time, and the files and
directories a user opened in a workspace, kept as stale snapshots per slot and
run. Not persisted: one-off queries such as previews, searches and diagnostics,
and streams.

**Version-list catch-up.** Until the run list adopts version lists, its
persisted result is the bounded list each client reads today. When the baseline
shows that rereading it is slow, the run list adopts them. With `versions: true`
the gateway returns `{id, version}` for every live run the principal may read,
unfiltered and without the default row limit, where `version` is a hash of the
row's canonical JSON as served in the list projection. The same reply carries the
list's `totalCount`, its summaries and its `resourceState` stamp. The client
reads changed ids in bounded batches, drops rows no longer listed, runs filters on
stored rows, and gives the merged result that stamp. The gateway keeps no extra
state, so this stays correct across restarts, crashes and rows computed at read
time. An empty store reads every row in the same bounded batches.

**Content.** Content with a stable identity is kept by that identity and not
refetched while cached:

- a gate package's retained diff by its `diffHash`. Package preparation retains
  the exact diff and untracked-file manifest that `diffHash` fingerprints;
- a file at a commit by its git object id;
- a retained artifact by its own SHA-256.

The client verifies bytes against the identity before storing them, with the
same functions that compute it on the gateway, because some content is served by
path. Content without such an identity, such as a working-tree diff, is a query
result and goes stale like one. Content and persisted workspace files share one
byte budget per client and are evicted least recently used first. Diffs and
files over a size cap, and binary content, load when opened.

**Prefetch.** For pending gates first, then active runs most recently updated
first, the client downloads in the background:

- the run's details;
- for a gate, the package's retained diff and its evidence images under a size
  cap. For an active run, its working-tree diff, including untracked files, as
  a stale snapshot;
- the base side of every file the diff touches, at the merge-base commit that
  the diff reply names.

The new side of each file is rebuilt on the device by applying the diff to its
base, and checked against its blob id when one is known, as for untracked
files in a package manifest. On a mismatch, the client reads that file from the
gateway. Nothing else in the repository is fetched. A run is fetched again when
its head commit changes, for a gate when its package changes, and for an active
run when it is opened, not on every file write. Base files are read
with a batched `git.show` that sends the object ids the device already holds, so
cached base files are reused across runs and iterations. Prefetch uses at most a
fixed share of the budget and never evicts content a user opened.

**Commands.** Unchanged. Commands run outside the cache and the store. They are
never queued or replayed, and are disabled while disconnected. An action needs
its records `ready` on the current connection.

**Scope and data at rest.** A store belongs to one gateway connection profile
and one principal generation. In solo mode, with no principal, it belongs to the
gateway alone. The store records the roles and workspace access it was filled
under. A connect that reports different values, sign-out, principal change, or a
connect that refuses the stored credential deletes it. A read refused for
authorization evicts that result. A network failure or token refresh does not
delete anything. The client keeps a capped number of stores, and switching
gateway or profile closes the current one. The store never holds credentials.
Companion keeps it in the system cache location, which platform backups exclude.
If the system purges it, the next reads rebuild it. There is no
application-level encryption. Because the store can be rebuilt, adding encryption
later means deleting it and reading again.

**Browser tabs.** One tab owns the database. Other tabs use the memory store.
The desktop app uses the browser store. Its content security policy must allow
WebAssembly compilation.

### Rationale and consequences

The expected gain comes from rendering stored results before network reads
finish, from not recomputing diffs on every open, and from having a run's
details, diff and files on the device before it is opened. Migration step 1
measures the starting point. Apart from retaining each package's exact diff,
none of this needs new persistent gateway state.

Durable per-row revisions, a durable epoch and a removal journal were considered
and rejected for now. The run store updates memory first and persists in the
background, so after a crash the gateway could reuse revisions that clients
already hold and skip changes. Decisions are computed at read time, expire by
clock and include files written outside the gateway, so no write path could
stamp them. Version lists avoid both problems. If a version list grows past
about 1 MB, a later amendment can revisit durable revisions with crash-safe
persistence.

Timestamp cursors were rejected. They skip writes made in the same millisecond
and writes that commit after a read started, and they record no deletions. Sync
engines that need Postgres or their own service, and client libraries that query
in memory or require an event log as the source of truth, would replace this
cache rather than extend it.

Rebuilding the new side of a file from its base and the diff keeps downloads to
the base files plus one diff per run, and shares base files across runs with the
same base. Snapshots whose base commit is not available locally, such as those
taken from a GitHub pull request, load when opened.

Websocket compression was considered and left out. The gateway compresses
nothing today, but bytes on the wire are not the expected bottleneck. Nodes and
clients share one websocket server, so compressing only client traffic would add
negotiation work. The baseline records bytes, and compression can be revisited
if they turn out to matter.

Stored data can be old. Its stale state and age stay visible, and actions stay
disabled until their records are ready on a live connection. Companion ships a
native SQLite module in a new binary. Command Center loads WebAssembly after
first paint. Devices hold farm metadata and the diffs and base files of runs
they prefetched, not whole repositories. Backup exclusion, deletion when
authority changes, and operating system encryption limit that exposure.

### Public surface

All names are proposed and unshipped. The ADR-071 specification stays the single
consistency contract. This amendment adds a persistence section to it, which owns
these fields.

- `@farmslot/protocol/client-cache` adds the `ResourceStore` interface and
  `createMemoryResourceStore`. Query definitions gain `persisted` and a size
  bound. `ResourceQueryState` gains `observedAt`. `createGatewayResourceCache`
  accepts `{ store }`. Consumers: the caches in Command Center and Companion.
  `@farmslot/local-store` implements `ResourceStore`.
- A new private workspace package, `@farmslot/local-store`, not published,
  exports `createSqliteResourceStore` with a React Native adapter and a browser
  worker adapter. It keeps native and WebAssembly dependencies out of
  `@farmslot/protocol`. Consumers: Companion through the React Native adapter,
  and Command Center and its desktop app through the worker adapter.
- `@farmslot/protocol` gains the review-diff identity functions that compute and
  verify `diffHash`, moved from the gateway. Consumers: gateway package
  preparation and client verification.
- `@farmslot/protocol/rpc/git`: `GitShowResult` gains `id`, the git object id
  of the returned content. `git.show` gains a batched form that takes several
  paths at one commit with the object ids the client holds, and returns ids plus
  raw content for the rest, in byte-bounded pages using `after`, `cursor` and
  `hasMore`. A run-scoped batched read accepts only that run's frozen head
  commit and the merge-base the gateway derives from its frozen base and head,
  with today's owner and repository checks. Slot-scoped reads keep today's
  rules. Held ids only suppress transfers and never authorize a read. Git already runs on the node through
  existing execution, so nodes need no change. `GitDiffResult` gains the
  resolved merge-base and head commits. `git.diff` gains `includeUntracked`,
  which adds untracked files under git's standard exclude rules to a
  working-tree diff. Consumers: the prefetcher and file views in both clients.
- `@farmslot/protocol/rpc/run`, added only when the run list adopts version
  lists: `RunListParams` gains `versions` and `ids`, and `RunListResult` gains
  `versions`. Replies without these parameters do not change. Consumer: the
  shared cache's run list query.
- `@farmslot/protocol/rpc/principal`: `SelfPrincipalSummary` gains
  `generation`. Consumers: store and draft scope in both clients.
- `@farmslot/protocol/rpc/auth`: `capabilities.resourceChanges` gains
  `versionLists`, a boolean while only the run list uses it, and `capabilities`
  gains `batchedContent`. The first capability is not shipped yet, so its first
  version includes the field. Consumers: the shared cache in both clients.
- There are no new events, CLI commands or flags. `@farmslot/cli`, mm-harness
  and recipe workers are not consumers and gain no extension point. The query
  registry stays closed to packs and harnesses.
- These additions start experimental. Against a gateway that lacks a capability,
  the client keeps ADR-071 behaviour for that query and loads content on open.

### Migration

1. Measure time and bytes on all clients against one gateway: cold start to
   first run list, reconnect to first run list, and opening a gate diff. Include
   a Command Center page served over plain HTTP from another machine.
2. Build ADR-071 step 1 with the store seam and the memory store.
3. Ship `@farmslot/local-store`. Companion needs a native build. The desktop
   security policy allows WebAssembly compilation.
4. Persist results family by family, as ADR-071 migrates each slice.
5. Retain each package's exact diff, then add the content cache, the batched
   `git.show` and prefetch, first for pending gates and then for active runs.
6. Add version-list catch-up to the run list if the baseline justifies it, and
   lift Companion's run history cap with it.
