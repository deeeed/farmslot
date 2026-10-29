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

[ADR-071 Amendment 1](../adr/071-gateway-change-notifications.md#amendment-1-2026-10-20-persistent-client-store)
adds persistence to this cache. Its exports, fields and rules are listed in
[Offline client store](#offline-client-store).

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
| `node`, farm collection or node ID; `pressure`, node ID      | Connection, health sample, machine pause, admission or pressure operation                      | Node/fleet cards, pressure/history and relief dialog                      |
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

## Offline client store

**Status:** Accepted with [ADR-071 Amendment 1](../adr/071-gateway-change-notifications.md#amendment-1-2026-10-20-persistent-client-store), 2026-10-20. Unimplemented.

The shared cache persists query results and verified content on the device, for
Command Center, its desktop app and Companion. The gateway stays the only
source of truth. Notifications, revisions, authorization and commands work as
the sections above describe.

### Lifecycle

When a client starts, it opens the store for its gateway and principal and
renders every stored result as `stale` with its age. It then connects. If the
connect reports a different scope, the client deletes the store and drops every
result it rendered from it before applying any reply. Otherwise each active
query refetches through its normal read and becomes `ready`. In the background,
the client prefetches what pending gates and active runs need to open without
waiting. Streams are never stored, and commands never pass through the store.

| Kind         | Examples                                                              | How it stays current                                         |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Query result | Run list, run details, decisions, fleet, backlog, workspace snapshots | Stored whole, `stale` until a read on the current connection |
| Content      | Package diffs, files at a commit, evidence images                     | Stored by identity, never stale                              |
| Stream       | Terminal bytes, screen frames, chat tokens, task progress             | Not stored                                                   |

### Exports and fields

| Name                                                                                                                                                                                         | Owner                                              | Consumers                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `ResourceStore`: per-query entries `{ data, observedAt, bytes }` replaced atomically, run-list rows merged by id in one transaction, content entries by identity, `deleteAll()`, byte totals | `@farmslot/protocol/client-cache`                  | The shared cache; implemented by the stores below |
| `createMemoryResourceStore()`                                                                                                                                                                | `@farmslot/protocol/client-cache`                  | Both clients, as the fallback                     |
| `createGatewayResourceCache({ store })`                                                                                                                                                      | `@farmslot/protocol/client-cache`                  | Both clients                                      |
| `createSqliteResourceStore()` with React Native and browser worker adapters, and the browser drafts store                                                                                    | `@farmslot/local-store`, private workspace package | Companion; Command Center and its desktop app     |
| Review-diff identity functions                                                                                                                                                               | `@farmslot/protocol`                               | Gateway package preparation; client verification  |
| `SelfPrincipalSummary.generation`                                                                                                                                                            | `@farmslot/protocol/rpc/principal`                 | Store and draft keys                              |
| `GitShowResult.id` and batched `git.show`                                                                                                                                                    | `@farmslot/protocol/rpc/git`                       | Prefetch, file views                              |
| `mergeBaseSha`, `headSha` on `GitDiffResult`, when `base` is set                                                                                                                             | `@farmslot/protocol/rpc/git`                       | Prefetch                                          |
| `git.diff` option `includeUntracked`, for `target: 'worktree'`                                                                                                                               | `@farmslot/protocol/rpc/git`                       | Prefetch                                          |
| `capabilities.batchedContent`, `capabilities.resourceChanges.versionLists`                                                                                                                   | `@farmslot/protocol/rpc/auth`                      | The shared cache                                  |
| `capabilities.conditionalFileWrites`                                                                                                                                                         | `@farmslot/protocol/rpc/auth`                      | The Command Center editor                         |

### Store

1. Companion opens the store with `expo-sqlite` in the platform cache directory.
   Command Center and its desktop app open it with SQLite WebAssembly on
   `opfs-sahpool`, in a dedicated worker loaded after first paint. The desktop
   content security policy allows `'wasm-unsafe-eval'`.
2. If the persistent store cannot open, including on pages without a secure
   context, the cache uses `createMemoryResourceStore()` and shows a one-line
   notice that data will not survive a restart.
3. In a browser, one tab owns the database and does all prefetching. Other
   tabs use the memory store. A tab that takes over never loads a stored result
   over newer `ready` data.
4. The store key is the gateway connection profile id where the client has one,
   the normalized gateway URL, the principal id and the principal generation.
   Command Center in a browser has no profile id and uses the URL. With
   `authMode: 'none'` the key is the profile id and URL alone. If authentication is on and the
   connect reply has no principal or no generation, the cache uses the memory
   store. A client keeps at most 5 stores (initial), deleting the least recently
   used.
5. Each store records the `roles`, compared as a set, and `workspaceAccess` it
   was filled under. A connect that reports different values deletes it, as the
   lifecycle above describes.
6. Sign-out, principal change, `AUTH_SESSION_ENDED` after a refresh attempt,
   and a rejected credential in token mode delete the store. An expired access
   token, a network failure or a timeout does not.
7. After any tab requests deletion, no tab reads that store again. Pending
   writes to a deleted store are dropped, and a late response for it is
   discarded.
8. The store has a schema version. A mismatch deletes and rebuilds it. Drafts
   are not in this store.
9. The store never holds credentials.

### Persisted queries

1. Each registered query declares `persisted` and a byte bound. A result over its
   bound stays in memory only. A failed store write keeps the in-memory result
   and shows the notice from Store rule 2.
2. A stored result loads as `stale` with `observedAt` from the read that produced
   it. It becomes `ready` only from a read on the current connection.
3. A read refused for authorization, or an authorized not-found, evicts the
   stored result, as Notification and revision contract requires for details.
   Other failures keep it as `stale`.

| Query                                                                                                        | Bound (initial)                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Run list                                                                                                     | 20 MB. The version index and filter projection of every live run; full rows active first, then newest, up to the bound |
| Run details (`run.get`)                                                                                      | 50 most recent runs, 20 MB in total                                                                                    |
| Decisions with gate packages                                                                                 | 10 MB                                                                                                                  |
| Fleet, slots, nodes, backlog, dispatch queue, work graphs, roadmap, projects, sources, upstream observations | 2 MB each                                                                                                              |
| Chat history                                                                                                 | Last 200 messages per session, 10 sessions                                                                             |
| Workspace files and directories the user opened                                                              | 200 entries per slot and run, inside the content budget                                                                |

Not persisted: previews, searches, diagnostics, analytics, doctor output and
dispatch candidates.

### Version lists

Version lists start only after the baseline shows a run-list reread on reconnect
above 2 s or 5 MB (initial). Until then this subsection is inactive.

1. `run.list { versions: true }` returns `{ versions: [{ id, version }],
totalCount, summaryMeta, familySummaries, projectAnalytics }` for every live
   run the principal may read. It ignores filters and the default row limit, and
   excludes archived runs. Versions come in the gateway's current base order,
   which sort ties follow. That order can change across a gateway restart.
2. `version` is opaque to clients and stable across gateway restarts for an
   unchanged row.
3. Only the version reply decides which rows exist. Stored rows it does not list
   are removed.
4. The client reads changed and missing ids with `run.list { ids }`, in pages of
   at most 2 MB (initial) that the gateway enforces. Ids it asked for but did not
   receive are requested once more. Ids still missing after that wait for the
   next version reply. The merged result takes the version reply's
   `resourceState`. An empty store fills through the same pages.
5. Totals for a filtered view are counted from stored rows, which then hold the
   whole collection. Before version lists, totals come from the gateway reply.
6. The client keeps the version index and a filter projection for every live
   run, so the collection and filtered totals stay whole. It stores full rows
   active runs first, then newest, up to the run list's byte bound. Rows past it
   stay in memory and count as missing on the next cold connect. Rows are stored
   one per run beside their query entry and merged in one transaction, so a
   catch-up page rewrites only the rows it carries. Each run list view is
   answered from these rows, is not stored itself, and stays `stale` until every
   listed id is held at its listed version. Summaries come only from the gateway: an unfiltered view
   that holds every matching run takes the version reply's summaries, and any
   other view that asks for summaries keeps its own read.

### Content

1. Identities:

   | Content                                      | Identity                      | Verified with                                                                                           |
   | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
   | Gate package diff                            | `diffHash`                    | The review-diff identity functions, which normalize index lines and include the untracked-file manifest |
   | File at a commit                             | Git object id                 | Git blob hash of the raw bytes                                                                          |
   | Retained artifact, including evidence images | The manifest entry's `sha256` | SHA-256 of the raw bytes                                                                                |

   An artifact entry without `sha256` is a query result, not content.

2. The client verifies bytes before storing them. On a mismatch it discards them
   and loads the content when opened.
3. Package preparation retains the exact diff and untracked-file manifest that it
   fingerprints into `diffHash`.
4. Repository files over 1 MB or binary, and diffs over 5 MB, are not prefetched
   or cached (initial). They load when opened. Evidence images up to 2 MB each
   are cached. Other retained artifacts follow the 1 MB file cap.
5. Content and workspace snapshots share one byte budget: 500 MB on Companion,
   2 GB on Command Center and the desktop app (initial). Eviction is least
   recently used first.
6. Prefetch may use at most half the budget. Content a user opened is never
   evicted by prefetch. Active-run prefetch waits when it cannot fit without
   evicting pending-gate content.

### Prefetch

1. Pending gates go first, then active runs by most recent update, at most 2 runs
   at a time (initial). After an authorization refusal, prefetch stops for the
   rest of the connection.
2. For each run:
   1. read `run.get`;
   2. read the diff. For a gate, the package's retained diff. For an active run
      on a slot, `git.diff { base, target: 'worktree', includeUntracked: true }`,
      kept as a stale snapshot. For a run in a frozen review workspace,
      `git.diff { runId, base, head }` at its frozen commits;
   3. read the base side of every file the diff or the untracked manifest
      touches, with batched `git.show` at the base commit the diff reply names.
      Added files have no base and are not requested;
   4. for a gate, read evidence images listed in the package manifest.
3. A gate is fetched again when its package changes: on a `package` key change
   the client rereads `run.get` and refetches if `publishGate.packageId`
   differs. Content it already holds by identity is not transferred again. An active
   run on a slot is fetched again when its head commit changes: on a `package` or
   `workspace` key change the client reads `git.log { limit: 1 }`, coalesced to
   the family's publish interval, and rereads the diff only if the head differs.
   A frozen review workspace has a fixed head and needs no check. An open active
   run's diff snapshot refreshes like any observed query. There is no timer.
4. Rebuilding the new side:
   - apply the diff to the base. A new file applies to an empty base, and a
     deleted file has no new side;
   - an entry that appears only in the untracked manifest is an empty file;
   - check the result against the manifest `blobSha` when one exists.
     A gate diff verified by `diffHash` and applied to verified bases needs no
     further check when it does not;
   - when the patch does not apply, or the check fails, read the file by path
     once and accept it only if its blob hash matches the expected id.
     Otherwise show the diff alone.
5. Untracked files come from `git ls-files --others --exclude-standard`. Ignored
   files, such as `.env`, are never listed, read or stored.
6. Runs without a frozen review workspace prefetch with `slotId`. A warm review
   snapshot whose base is not the merge-base, and a snapshot taken from a GitHub
   pull request, load their base files when opened.

### Batched `git.show`

1. Request: `{ slotId | runId, ref, paths, have?, after?, maxBytes?,
maxFileBytes? }`. `have` lists object ids the client holds. `maxBytes`
   defaults to 4 MB and `maxFileBytes` to 1 MB (initial), both counted in raw
   bytes.
2. Reply: `{ entries: [{ path, status, id?, size?, content? }], cursor,
hasMore }`, with `status` one of `ok`, `held`, `missing`, `not-blob` or
   `too-large`. Only `ok` carries `content`. Every page returns at least one
   entry.
3. The command on the slot's host encodes content as base64 before it leaves
   the process, so execution paths that decode text carry it unchanged. Nodes
   need no change.
4. A run-scoped read accepts the run's frozen head and the merge-base the gateway
   derives from the frozen base and head, after today's owner and repository
   checks. A slot-scoped read keeps today's `git.show` rules. Both follow
   `git.show`'s current method authorization.
5. `have` only suppresses transfers. It never authorizes a read.

### Drafts

1. Command Center keeps unsaved edits in IndexedDB, shared by all tabs, with its
   own schema version and migrations.
2. A draft records the store key fields, the slot, the run or none, the path,
   the base content, the base hash and the edited content.
3. A draft whose run is no longer the slot's current run is listed read-only,
   with copy and discard.
4. A draft for a slot the user can no longer read is hidden entirely. It comes
   back if access returns.
5. Either kind is deleted 30 days after it entered that state.
6. Sign-out and principal change delete drafts after the editor shows how many
   are unsaved. Drafts are never sent automatically.

### Capabilities and compatibility

1. `capabilities.batchedContent` is `true` when batched `git.show`, the diff
   commit fields and the `git.diff` option are available. Without it the client
   does not prefetch and loads content when opened.
2. `capabilities.resourceChanges.versionLists` is `true` when the run list
   supports version lists. Without it the client rereads the run list.
3. `capabilities.conditionalFileWrites` is `true` when file edits accept
   `expectedHash` and `runId` ([ADR-009 Amendment 1](../adr/009-slot-workspace.md#amendment-1-2026-10-20-conditional-file-edits)).
   Without it the editor stays read-only.
4. No missing capability falls back to polling. These fields start
   experimental.

### Acceptance

Before a slice removes a freshness mechanism or claims a speed-up, Command
Center in a browser, the desktop app and Companion prove these scenarios against
one gateway, alongside Migration acceptance above:

- Cold start with no network: stored lists and opened runs render as stale with
  their age. Actions are disabled.
- Reconnect: previously cached data stays visible, then each result returns to
  `ready`.
- A role is revoked while the app is closed: on the next connect, the rendered
  data disappears before any reply applies, and the store is deleted.
- Principal change and credential refusal delete the store. Late responses are
  discarded.
- A deleted run: its stored details are evicted after the authorized not-found.
- A pending gate whose prefetch completed opens offline with its details, diff,
  both sides of every size-eligible touched file and its evidence images.
- A fix loop produces a new package: only the new diff and base files not
  already held are transferred. Record the bytes.
- An active run with an untracked new file and an ignored `.env`: the new file is
  prefetched, and `.env` is never listed, read or stored.
- A base branch that moved after the branch point: base files at the merge-base
  are read without refusal.
- A second browser tab works on the memory store. The owner's database passes
  `PRAGMA integrity_check`, and the second tab never opens it.
- Command Center over plain HTTP from another machine runs on the memory store
  and says so. The desktop app loads the WebAssembly module under its policy.
- A schema version change rebuilds the store and keeps drafts.
- Prefetch never evicts content the user opened, and active-run prefetch never
  evicts pending-gate content.
- An operator principal: prefetch stops after the first refusal, and stored
  results never show data the operator cannot read.
- Editing: a save conflict keeps the draft, a save after the slot moved to
  another run is refused, a slot on an old node stays read-only, and a hidden
  draft is deleted 30 days after it was hidden.
- With version lists: versions stay the same across a gateway restart, and an
  empty store fills in pages within Companion's request timeout.
