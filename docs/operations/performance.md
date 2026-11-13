# Performance

Read Doctor's **Slowest actions**, `gateway.performance.get`, or authenticated
`GET /metrics`. Admin reads use the same in-memory collector. Prometheus output
needs no server. Missing samples mean unmeasured.

| Action class       | Target p95 |
| ------------------ | ---------: |
| Cached paint       |     100 ms |
| Interactive read   |     250 ms |
| Gate action        |        2 s |
| Background refresh |        5 s |

`PERFORMANCE_BUDGETS` in `@farmslot/protocol` owns these targets. A verdict needs
20 samples and at least 95% within the exact budget bucket. Displayed percentiles
are bucket estimates; max and bytes are exact. Calls over 2 s emit a slow log.

Cached paint starts at foreground demand, before lookup/hydration, and ends after
the subscriber's queued render and data frame. Refresh timing stays separate.
Read counters include cache source, age, stale/blocking state and opaque per-query
rereads per minute. Client-window gauges preserve each source's report times on
its own clock. Managed exec/node counts and elapsed time cover shared helpers,
not shell descendants or exclusive CPU time. Their `method` label is the RPC
that started the command; outside a request it is `host:<operation>` for a
command a host service (`services/gateway/src/host-services`) started, and
`_background` otherwise.

To investigate and improve:

1. Record method, class, cache source/age, workload size and observation window.
2. Compare bytes, managed processes, node wait and loop lag. Confirm the cause in
   source. Remove repeated work at its owner; bring contract changes to the lead.
3. Repeat the same method, parameters, workload and cache state. Save before/after
   snapshots, build and host. Assert result identities too. A cache hit cannot
   replace a network measurement.

For `fleet.status` with `forceRefresh: true`, measure the genuine machine-health
generation through its committed `checkedAt`. Optional workspace/Git observations
refresh through their shared background owner and retain their own `observedAt`;
they do not extend the health request's blocking duration. Remote and local slot
checks share the same four-worker bound per host. Keep workload, cache state and
host load in the before/after evidence.

`fleet.refresh` also returns machine health without warming every workspace.
Acting recovery reads remain fenced: `slot refresh --recover --force` waits for
the shared observation if its target has no workspace witness yet.

Run `node --import tsx scripts/runner-validation/canary/canary.mts --profile nightly --target isolated --only performance` for the same isolated check used nightly. It saves `performance/snapshot.json` under the dated canary evidence directory.

For native chat streaming latency, run the
[native stream latency recipe](../../scripts/runner-validation/native-stream-latency.recipe.json).
A synthetic Claude peer streams timestamped deltas through the real native host and an
isolated in-process gateway. The recipe reports runner-to-client and host-to-client
percentiles and event-loop delay, and fails on a lost or reordered delta or a p95 over budget.
`--load` adds slot writes every 100 ms and fails if `fleet.updated` broadcasts stop arriving;
`--viewers <n>` adds subscribers to the same session. It never touches the operator gateway, and
the isolated stack runs without orchestration timers, so it does not show operator stalls; read
those from `farmslot_event_loop_lag_seconds` on the operator gateway.

For terminal fan-out, run the
[terminal backpressure recipe](../../scripts/runner-validation/terminal-backpressure.recipe.json).
One viewer stops reading while a pane floods on an isolated gateway. It fails unless the gateway
closes that viewer for a resync (1013), the viewer's stream has no gap, and it re-attaches to the
current screen.

The nightly canary saves a dated snapshot and budget verdict using the versioned
[normal workload](../reference/performance-diagnostics.md). Injected faults stay
outside that window. Missing class/source coverage fails visibly. Keep snapshots
for trends; do not reset measurements or change workloads to produce a pass.

Use the shared dispatch, client/cache and exec wrappers. New methods inherit
coverage; add no endpoint timers or separate measuring service.

HTTP ingress shares the request context used for managed exec and node attribution.
`farmslot_http_requests_total` counts responses by bounded `http.*` route and status
class, including `aborted`; `farmslot_http_duration_seconds` and Doctor's HTTP rows
measure through response completion. URLs, query strings and caller identifiers
are never metric labels. HTTP streams have no assigned latency budget and their
body bytes remain unmeasured. Older Doctor clients ignore the new HTTP duration
rows; updated clients show them in the HTTP phase.

Passive workspace default and publication ref queries share a 60-second answer only for the same resolved remote, ref, Git authentication configuration and node authority. Acting, recovery and owner-bound reads bypass completed passive answers. Errors do not become verified ref observations.

Unchanged unavailable passive workspace inspections retry after 60 seconds. Metadata is still checked every 15 seconds; changed source/ownership, explicit invalidation and acting reads bypass the retry delay. Reuse retains the original unavailable observation and its timestamp.

Task staging uses `taskFiles.transfer` in the existing background child. SSH/SCP/rsync commands retain their shell, cwd, copy flags and ordered marker publication. Their previous untimed execution remains untimed; child startup stays bounded and inherited cancellation waits for process closeout. Include `host:taskFiles.transfer` when comparing managed command totals. Moving execution does not itself reduce the number of commands.

Passive workspace refresh batches Git metadata through the trusted read-probe executor once per remote node every 15 seconds. Generic node filesystem access to `.git` stays denied. Unchanged metadata retains the existing 90-second inspection limit and original observation time; ownership changes, explicit invalidation and acting reads still force inspection. A missing metadata result cannot justify reuse.
