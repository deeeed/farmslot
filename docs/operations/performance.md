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

## Tracked metrics

Baselines are the latest measured values; each performance PR that moves a metric
updates its row in the same PR. "Budget check" is the operator's alert-only check
that runs after every gateway deploy: two 10-minute windows compared with the last
kept windows, never above load 100, and an alert only when the second window
repeats the first.

| Metric                                 | How measured                                                                                               | Current baseline                                                                                             | Alert threshold                                                                                                                  | Owner                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| RPC latency per action class           | `farmslot_rpc_duration_seconds` (`gateway.performance.get`, Doctor)                                        | Targets in the table above                                                                                   | Budget verdict: under 95% of 20+ samples within the class target                                                                 | Runtime performance lane |
| Node and exec calls per RPC, by method | `farmslot_node_calls_total` and `farmslot_exec_calls_total` over the method's RPC count in a budget window | `task.progress`: 8.5 node requests per RPC on a live run (2026-11-15, after #2230; 33–38 before)             | Budget check: at least 1.5x and +2 calls per RPC against every kept window                                                       | Runtime performance lane |
| Gateway CPU                            | `ps` CPU seconds per 10 minutes, and per 100 RPCs                                                          | 55–96 s per 10 minutes over the last five kept windows (2026-11-15)                                          | Budget check: at least 1.5x CPU unless CPU per RPC stays flat (then reported as activity)                                        | Runtime performance lane |
| Event-loop lag                         | `farmslot_event_loop_lag_seconds` max per window                                                           | Read per window; slow-RPC logs carry `loopLagSeconds`                                                        | None yet; reported with slow RPCs                                                                                                | Runtime performance lane |
| Command Center live slot page          | CDP wire frames and `Performance.getMetrics` on a live run's slot page, 3 cold loads and 120 s steady      | First paint 0.43–0.61 s; 3.1 RPC/s, 25 KB/s, main thread 3.85% busy, no long tasks (2026-11-16)              | Checked in each performance PR that touches it; no automatic alert                                                               | Runtime performance lane |
| Companion run detail rereads           | Gateway-client frames per method on the slot screen of a live run, 120 s (iOS simulator, Debug client)     | `run.get` 12 reads, 811 KB per 2 minutes (after #2251; 20 and 1.7 MB before)                                 | Checked in each performance PR that touches it; no automatic alert                                                               | Runtime performance lane |
| Prepare time                           | `prepare` step `durationMs` of completed runs in the run store                                             | p50 118 s, p90 256 s (7 days to 2026-11-16)                                                                  | Budget check `STEP-TIME`: last-24-hour p50 at least 1.5x the prior six days' p50 and 30 s slower, with at least 5 recent samples | Runtime performance lane |
| Dispatch time                          | `dispatch` step `durationMs`                                                                               | p50 20 s, p90 129 s                                                                                          | Same `STEP-TIME` rule                                                                                                            | Runtime performance lane |
| Complete and finalize time             | `complete` and `finalize` step `durationMs`                                                                | complete p50 19 s, p90 81 s; finalize p50 2 s, p90 27 s                                                      | Same `STEP-TIME` rule                                                                                                            | Runtime performance lane |
| Prepare Git commands                   | `git.<sequence>.<operation>` prepare substeps (below)                                                      | Heaviest so far: clear index flags 24 s, checkout default 18 s, reset default 18 s, reset head 16 s (2 runs) | None yet; cost is counted as processes and Git calls per step                                                                    | Runtime performance lane |
| Slot release time                      | Not recorded: `slot.release` prints phase times to the console only                                        | Unmeasured                                                                                                   | None until it is recorded                                                                                                        | Runtime performance lane |

Cached paint starts at foreground demand, before lookup/hydration, and ends after
the subscriber's queued render and data frame. Refresh timing stays separate.
Read counters include cache source, age, stale/blocking state and opaque per-query
rereads per minute. Client-window gauges preserve each source's report times on
its own clock. Managed exec/node counts and elapsed time cover shared helpers,
not shell descendants or exclusive CPU time. Their `method` label is the RPC
that started the command; outside a request it is `host:<operation>` for a
command a host service (`services/gateway/src/host-services`) started, and
`_background` otherwise.

## How to improve a metric

Follow the [performance rules](../../CLAUDE.md#performance-rules).

1. Record method, class, cache source/age, workload size and observation window.
2. Compare bytes, managed processes, Git calls, node wait and loop lag. Confirm the
   cause in source before changing it: a count that rises with run size, a poll that an
   event could replace, or a reread on a change that does not affect the reply.
   Remove repeated work at its owner; bring contract changes to the lead.
3. Repeat the same method, parameters, workload and cache state. Save before/after
   snapshots, build and host. Assert result identities too. A cache hit cannot
   replace a network measurement.
4. State in the PR the processes and Git calls the change adds or removes per call,
   and update the metric's row in the table above.

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

Prepare retains exact `git.<sequence>.<operation>` measurements in its existing
substeps and log stream. Their JSON detail records elapsed `durationMs`, exit code
and whether the measurement covers a command or a full guarded mutation, including
parking. These are nested measurements: do not add them to the parent phase totals.
Command arguments, output and exception text are omitted. Use the read-only
[prepare Git timing recipe](../../scripts/runner-validation/prepare-git-timing-read.recipe.json)
with `FARMSLOT_PREPARE_PROOF_RUN` and an authenticated `FARMSLOT_GATEWAY_PROFILE`
to read the next real run's `prepare.outputs.subSteps` before changing a slow Git operation.
Use `FARMSLOT_PREPARE_PROOF_ACTIVE=1` during Git work to check that measurements
leave the human stage detail intact, then rerun after prepare completes.

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

Passive default-branch ancestry may reuse only a successful exact HEAD/base result for at most ten minutes, without extending expiry on hits. The shared metadata batch supplies graph eligibility; shallow, grafted and replaced histories bypass the cache. Metadata, worktree, ownership and node identity changes invalidate reuse. Acting/force reads and negative/error results remain fresh. Count real node/child commands when comparing rates, not cache-result reads.

## Recipe-call issue diagnostics

The harness lane owns these call-path metrics. Measure five calls per action with
recording and healing off; discard the first and report warm time medians and
maximum direct-child/Git counts. Outer `/usr/bin/time -p` covers elapsed time and
user + system CPU, including descendants. The call profiler records direct Git
starts across traced Node processes; the shared `work.git` counter is narrower.
The existing full-flow call-perf canary fails above 120% of its accepted time
reference or any increase in its count budgets. A busy or incomplete sample is
not release qualification. Baseline changes remain explicit.

| Metric                                 | How measured                                       | Current reference                                                                           | Alert threshold                                                       | Owner        |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| Mobile call wall / total CPU           | Outer warm medians, milliseconds                   | Deployed harness 0.96.25: unlock 3040 / 2945; screenshot 2740 / 3110; positions 1875 / 2605 | More than 20% over the accepted case reference                        | Harness lane |
| Mobile call direct children / Git work | Maximum warm `call-timings.json` counts            | Deployed 0.96.25: unlock 38 / 17; screenshot 42 / 17; positions 38 / 17                     | Any increase over the accepted case budget                            | Harness lane |
| Mobile call traced Git starts          | Profiler child starts across traced Node processes | Deployed 0.96.25: unlock 30; screenshot 32; positions 30                                    | Diagnostic before/after count, not a separate automatic verdict field | Harness lane |

The asynchronous issue-buffer candidate was compared with the same package graph
including the merged source-fingerprint reduction. These are matched preview
measurements, not replacements for the deployed references above:

| Call                              | Outer wall ms, before / after | Total CPU ms, before / after | Direct children, before / after | Traced Git starts, before / after |
| --------------------------------- | ----------------------------- | ---------------------------- | ------------------------------- | --------------------------------- |
| `metamask.wallet.ensure_unlocked` | 2925 / 2780                   | 2830 / 2700                  | 30 / 27                         | 22 / 22                           |
| `ui.screenshot`                   | 2660 / 2545                   | 2995 / 2905                  | 34 / 31                         | 24 / 24                           |
| `metamask.perps.read_positions`   | 1810 / 1700                   | 2480 / 2415                  | 30 / 27                         | 22 / 22                           |

All 30 calls passed; the unchanged call-perf comparison passed. All 90 provenance
snapshots retained identical product fingerprints, and diagnostics retained arm,
baseline drain and final drain. No helper process or Git call is added for old
synchronous adapters. The companion harness removes three helper processes and
adds zero Git calls per Mobile call. Earlier incomplete and contended failures
remain in the operator's receipts; the final complete comparison passed.

To improve these metrics, remove repeated work at its owner. Await the existing
diagnostic operations and use the existing broker instead of Node helpers. Keep
fresh target selection, collection order, deadlines, custom-script/absent-broker
fallback and no replay after an uncertain destructive collection. Verify complete
recipes and recording when changing those contracts. Do not add polling or
per-call work proportional to accumulated runs or artifacts.

## Prepared recipe source witnesses

Task binding must not scan retained task history. Bound executions and explicit
`--unbound` diagnostics need no task-storage lookup; otherwise one filesystem
metadata check detects task storage. This adds no process or Git invocation.

The harness lane owns this candidate. Target zero traced framework Git starts in
unchanged calls, including bootstrap and capture provenance; user-authored Git
commands are separate work. A prepared record is reused only after fresh file
witnesses at source, provider-authority and capture boundaries. Retained output
history must stay outside validation. Unsupported output layouts retain fresh
legacy checks and must not gain a history scan. No persistent call server is used.

`summary.json.sourceWitness` reports wall/CPU time and source-file/directory
counts for each physical-root validation, tagged by checkpoint and boundary.
Cold preparation and refresh counts remain separate from warm measurements.
The recorded call profiler covers direct children and the runner-revision shell
call; `work.git` is a narrower counter. Parent-Node CPU remains diagnostic when
work moves from Git children into the witness. Wall and total descendant CPU
qualify the comparison.

Preliminary matched candidate measurements against published harness 0.96.26,
recording/healing off, five calls per action with the first discarded:

| Case              | Outer wall ms before / after | Total CPU ms before / after | Attributed children before / after | Git work before / after |
| ----------------- | ---------------------------: | --------------------------: | ---------------------------------: | ----------------------: |
| Core command      |                    640 / 525 |                   840 / 660 |                             19 / 1 |                  17 / 0 |
| Mobile unlock     |                  2910 / 2635 |                 2815 / 1995 |                             27 / 5 |                  17 / 0 |
| Mobile screenshot |                  2695 / 2580 |                 3010 / 2170 |                             31 / 7 |                  17 / 0 |
| Mobile positions  |                  1945 / 1560 |                 2630 / 1695 |                             27 / 5 |                  17 / 0 |

All warm traced Git starts were zero. Core cold preparation used 16 Git starts.
These are candidate references under recorded host load, not new shared canary
baselines. Final provider-freshness closeout, Extension proof and exact-head
review remain required. The alert is any warm framework Git start, history-sized
validation work, lost drift refusal, or a wall/total-CPU regression beyond the
accepted comparison budget. File-witness cost must remain below the replaced
Git/provenance work. Improve the declared input owner and shared projections;
do not remove freshness or evidence observations to make the count pass.
