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
not shell descendants or exclusive CPU time.

To investigate and improve:

1. Record method, class, cache source/age, workload size and observation window.
2. Compare bytes, managed processes, node wait and loop lag. Confirm the cause in
   source. Remove repeated work at its owner; bring contract changes to the lead.
3. Repeat the same method, parameters, workload and cache state. Save before/after
   snapshots, build and host. Assert result identities too. A cache hit cannot
   replace a network measurement.

Run `node --import tsx scripts/runner-validation/canary/canary.mts --profile nightly --target isolated --only performance` for the same isolated check used nightly. It saves `performance/snapshot.json` under the dated canary evidence directory.

The nightly canary saves a dated snapshot and budget verdict using the versioned
[normal workload](../reference/performance-diagnostics.md). Injected faults stay
outside that window. Missing class/source coverage fails visibly. Keep snapshots
for trends; do not reset measurements or change workloads to produce a pass.

Use the shared dispatch, client/cache and exec wrappers. New methods inherit
coverage; add no endpoint timers or separate measuring service.
