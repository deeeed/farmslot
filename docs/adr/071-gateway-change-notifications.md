# ADR-071: Gateway change notifications and shared client cache

**Status:** Proposed, awaiting Arthur's approval
**Date:** 2026-10-17
**Owner:** Arthur / Farmslot
**Delivery:** Design only. No implementation, release or rollout is authorized by this draft.
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

Each notification reaches a principal only if that principal may call the
key's read methods. For `resource.changed`, this per-key check replaces the
event-name broadcast allowlist, so native-only principals keep live native
sessions and approvals. Existing domain events such as `run.updated` stay for
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
   GitHub accounts, PR review threads). The CI-timeout auto-resolve moves into
   the gateway CI monitor. Remove remaining duplicate client caches and event
   mappings, and enforce the panel rule in review/CI.

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
