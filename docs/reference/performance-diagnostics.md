# Performance diagnostics

Status: Accepted under ADR-001 Amendment 1.

## Collection and ownership

The gateway MUST wrap shared RPC dispatch once, including failures. It MUST
record method, count, duration p50/p95/max, serialized UTF-8 response bytes and
outcome. Shared client/cache code supplies the action class, not endpoints.
Serialization MUST happen once; measurement MUST reuse the serialized
response. Requests and responses MUST retain their existing behavior.

Shared exec helpers MUST record managed spawn count and elapsed time by command
kind, including git, tmux, ssh and node. Shared node request helpers MUST record
node-call count, elapsed time and reconnect wait. Attribution MUST follow the
request's async context. Detached background work MUST NOT be charged as time a
completed foreground request waited. Event-loop lag MUST be measured centrally.
Counters describe managed invocations, not guessed shell descendants or CPU time.

A shared client request wrapper MUST cover Command Center and Companion.
The shared resource cache MUST record foreground cache demand, before lookup/hydration, through the first rendered
data paint, cache hit/miss/source and age, background refresh duration, stale reads,
reads with no held data and actual transport rereads in the last minute per
opaque query identity. Shared collection reuse is not another network reread.
Paint samples MUST include cache lookup and hydration, and end at a foreground
render scheduler after data is rendered. Delivery-to-paint alone is insufficient. Missing paint or age
information is unknown, never zero. Cache delivery MUST NOT await telemetry.

No endpoint or screen may add a timer. A newly registered method MUST appear
without instrumentation changes. The cache and request wrapper MUST distinguish
visible waits from background refreshes. Client reports MUST be bounded,
asynchronous and batched; disconnected clients keep local measurements until
normal reconnection. Auth negotiation advertises diagnostics version 1; clients
MUST report only to a supporting gateway. Unsupported older gateways retain
normal behavior. Reports MUST merge deltas idempotently by source and sequence,
with bounded checkpoints and explicit dropped/unmeasured coverage.

## Data and protocol

`@farmslot/protocol` owns `PerformanceSnapshot`, `ClientPerformanceReport`, the
shared histogram implementation and `PERFORMANCE_BUDGETS`. Durations use seconds,
bytes use bytes, and timestamps identify the observation window and gateway boot.
Histograms expose finite bucket boundaries, cumulative counts, count, sum and max;
p50/p95 are derived consistently from those buckets and marked as estimates.
Version 1 uses duration boundaries in seconds
`[.001,.005,.01,.025,.05,.075,.1,.15,.25,.5,1,2,5,10,20,30,60,120,180,300,600,3600]`,
response-byte boundaries
`[0,1024,4096,16384,65536,131072,262144,524288,1048576,2097152,4194304,8388608,16777216]`,
and cache-age boundaries in seconds
`[1,5,10,30,60,300,900,3600,21600,86400,604800]`, each followed by `+Inf`.
All producers and renderers MUST use these shared versioned boundaries. Every
action budget is an exact duration boundary. Budget verdicts MUST use the exact
fraction at or below that boundary, at least 95%, rather than an interpolated
p95. The check requires at least 20 eligible samples per expected class/source;
fewer samples remain unmeasured. Exact maxima remain visible.

Collectors MUST bound method/query/client cardinality and retain no per-request
history. Unknown methods share a bounded fallback label. Query identities MUST
be opaque; arguments, responses, command text and credentials MUST NOT be stored
or exported. Raw measurements MUST remain available for interpreting inferred
causes; parallel process/node times MUST NOT be represented as exclusive CPU time.

`gateway.performance.get` returns the collector snapshot for Doctor and tools.
`gateway.performance.report` accepts validated bounded client aggregates from
Command Center and Companion. Both use the typed protocol registry and method classification. Snapshot and
Prometheus reads require existing diagnostics authority. Every authenticated
non-node client may submit only its own bounded aggregates; the route binds the
report source to the authenticated principal. Authenticated
`GET /metrics` emits Prometheus text from the same collector. Unauthorized reads
MUST refuse without exposing measurements. These operations create no identity,
credential, node service or external telemetry dependency.

Required metric families use the `farmslot_` prefix: RPC duration and response-size
histograms, managed exec/node counts and elapsed seconds, event-loop lag,
client cached-paint and background-refresh histograms, cache-source/stale/blocking
read counters, cache-age histograms and per-query rereads per minute. Histogram
output MUST use `_bucket{le="..."}`, `+Inf`, `_count` and `_sum` with Prometheus
escaping and type declarations. Doctor MUST derive its ranked Slowest actions
from the same snapshot, showing count, p50/p95/max, bytes and observed
payload/process/node-wait/event-loop causes. It MUST keep foreground and
background measurements distinct and preserve cached first display.

## Budgets and proof

One shared budget table MUST serve clients, Doctor and the nightly check.
Initial p95 targets are cached paint 100 ms, interactive read 250 ms, gate action
2 s and background refresh 5 s. Gateway slow logs start above 2 s and contain
only method, outcome and measured costs. Collection overhead MUST be measured
against the unwrapped path on the same fixture and documented with the result.

Every performance fix MUST retain before/after snapshots with the same method,
parameters or fixture, workload size, action class and cache state, naming the
build and host. A cached hit MUST NOT substitute for the network measurement.

The existing nightly canary MUST run a versioned normal-performance workload in
an isolated gateway, with no restart, fault injection, model or external service.
Version 1 uses 100 retained run records in four families, eight fixture slots,
and 20 non-publishing fixture gate actions. After warming the same data, it
records at least 20 family reads, 20 fleet reads, 20 gate actions, 20 foreground
cached paints including disk hydration, and 20 background refreshes with held
data. The performance observation window is bounded to 120 seconds after setup.
It MUST assert expected result identities/counts alongside timing and preserve
workload version, build, host, cache state and sample counts in the snapshot.
Intentional downtime/recovery cases MUST run outside this window and MUST NOT
enter the normal budget verdict. A timed-out window is a visible failure;
missing expected class/source coverage remains unmeasured, never a pass.
The nightly MUST save a dated snapshot, coverage and budget verdict for trends.

Regressions MUST be flagged against the shared action-class budgets. Proof MUST
cover automatic new-method capture, failures, byte counts, async process
attribution, cached offline paint independent of a held refresh, report batching,
authentication, Prometheus formatting and repeatable nightly budget failures.

Completion MUST include the agent-instructions link to the operational process
and a top-five bottleneck report in the lane report, with measured duration,
bytes, relevant process/node counts, observation window and a proposed fix for
each. The supplied starting observations, family.observability.get 157 s/2.2 MB
and fleet.status 20 s/209 KB, are starting evidence, not replacement measurements.
