# Pipeline-ops analytics event stream goal

Status: proposed for confirmation
Use as: `/goal docs/plans/pipeline-ops-analytics-goal.md`
Supports: `docs/ROADMAP-next.md` (Later Lanes / Captured Backlog), `docs/PRD-automation-intelligence-canonical.md` run/family observability.

## Goal

Give the operator durable, queryable analytics about **how the dispatch pipeline performs over time** — where wall-clock goes step by step, how often runs fail and at which step, how many self-review and CI loops a run takes, and how those vary by project, host, flow, runner, and model — so prompts, templates, and setup can be tuned from evidence instead of memory.

The analytics data must **outlive run history**. Run JSONs are transient operational state and should be prunable (including failed runs) without losing the analytics signal.

## Background — first-pass evidence

A read-only aggregation over the current set of live run records (a few hundred runs, multiple projects/hosts) established what is and is not learnable from existing data:

- **Reliable today, full coverage:** per-step start/end timestamps (so step durations and the bottleneck map are free), run status, nudge count, project/host/flow/runner/model dimensions.
- **The bottleneck is waiting, not setup.** End-to-end wall-clock is dominated by idle time (queue + human gate + CI waiting) and by CI retry loops. Prepare is cheap and bounded; self-review typically converges in a single loop.
- **Partial coverage (recent schema):** self-review loop counts, CI pass/fail and poll counts, independent-review depth. These already populate on new runs and will deepen with time — no backfill needed.
- **Structurally unavailable today:**
  - **Cost / tokens** — populated on 0% of runs across every runner. Not merely inaccurate; absent. Deferred (see non-goals).
  - **Failure attribution** — zero steps are ever persisted with an `error` status, and failed runs are removed from run history. Failure monitoring is therefore impossible from current data.
  - **Host load at dispatch** — never captured, so prepare/dispatch problems cannot be correlated with machine pressure.

## Design

### 1. Analytics sink — decoupled, append-only

A separate append-only event store, independent of the `.runs/` lifecycle, written **before** a run can be pruned. One record per terminal run. Holds distilled metrics only — never transcripts or large step outputs.

- Format: **NDJSON**, month-rotated (e.g. `<runtime>/analytics/events-YYYY-MM.ndjson`). Zero-dependency, grep-able, trivial append. Corpus is small (hundreds/month).
- Run history can then be deleted/archived aggressively — including failures — with no analytics loss.

### 2. Per-run record (embedded step array)

```jsonc
{
  "ts": "<terminal transition ISO>",
  "runId", "project", "host", "slotId",
  "flowType", "runner", "model", "status",
  "failedStep": "<step name or null>",      // computed at emit
  "failureReason": "<reason code or null>", // normalized enum, not free text
  "steps": [
    { "name", "status", "startedAt", "completedAt", "durationMs" }
  ],
  "wallMs", "idleMs",                        // idle = wall − Σ step durations
  "nudgeCount",
  "selfReviewLoops",
  "ciResult", "ciInlineFixAttempts",
  "hostLoad": { "load1", "freeMemPct", "activeRunsOnHost" }, // snapshot at prepare start
  "templateProvenance"
  // cost/tokens intentionally omitted — unreliable, deferred
}
```

The embedded `steps` array gives full per-step granularity inside each per-run record. A separate per-step-transition stream is **not** built: it would only add (a) repeated executions of the same step and (b) mid-run streaming, neither needed for v1, and step retry history is not retained in run data today regardless.

### 3. Emitter

Fires at the run's terminal transition (done / failed / cancelled — the canonical `TERMINAL_RUN_STATUSES`) in the run engine, writing exactly one record. `blocked` is non-terminal (a paused, human-gated state): a blocked run emits when it later resolves to done/failed/cancelled, so no analytics is lost. Failure attribution (failing step + reason code) is computed here from the run's step states.

Durability: `updateRun` fires the append and forgets — the run stays in the store, so a dropped append is recoverable by re-running `analytics.backfill` (which dedups on actual sink presence, not the emitted flag). The eviction paths (`archiveRun`/`deleteRun`) await the append before removing the run, since an evicted run can no longer be backfilled.

### 4. Forward-capture additions (minimal, additive)

These feed fields the current data lacks. Each is small and additive; none changes run-history persistence shape beyond the analytics record:

1. **Failure attribution** — when a step fails, record an `error` status + a normalized `failureReason` code (e.g. `merge-conflict`, `metro-timeout`, `cdp-timeout`, `dep-install`, `auth`, `ci-flake`, `lint`, `type`, `test`, `timeout`, `unknown`) so the emitter can attribute failures.
2. **Host-load snapshot** — at prepare/dispatch start, capture `loadavg`, free-memory %, and count of active runs on that host.
3. **Persist prepare substep timing** — prepare substeps are already broadcast live; persist them with timestamps so prepare's internal cost (checkout / merge / install / preflight / health) is visible.

### 5. Query + dashboard

A read-only query method over the sink (extending the existing `run.list` summary/project-analytics foundation), and a Command Center analytics view with granularity and filters by project, host, flow, runner, model, and time window. Charting library: none is currently a dependency — pick a small one at implementation time.

### 6. Backfill

A one-time read-only pass over current live runs seeds the sink (timing, durations, nudges, status, loop counts where present). Forward-only fields (failure reason, host load, prepare substep timing) stay null for backfilled rows.

## Non-goals

- **Token/cost extraction hardening / cost-per-PR.** Real, but blocked on unreliable per-runner token capture. Deferred; maps to the captured "Worker phase decomposition and sub-agent cost roll-up" lane. Reliable cost-per-merged-PR is the eventual target, especially once work is split across smaller models.
- **Eval-package corpus/history dashboards or external eval exports** (an explicit ROADMAP-next non-goal). This lane is pipeline-operations telemetry, a separate concern.
- **Mining archived/old failed runs.** Historical prepare failures are considered resolved; analytics is forward-looking. No archive dependency.
- **A per-step-transition event stream** and **step retry history** in v1.

## Open decisions for confirmation

1. Sink format: NDJSON (proposed) vs sqlite.
2. Sink location and rotation policy under the runtime dir.
3. Failure-reason enum: confirm the initial code set above.
4. Whether the backfill should run automatically once on first deploy or as an explicit operator command.

## Acceptance criteria

- One analytics record is emitted per terminal run, before any run-history pruning, and survives deletion of the run JSON.
- Failed/cancelled runs produce records with a populated `failedStep` + `failureReason`.
- The dashboard renders the bottleneck map (per-step P50/P90/max), wall-vs-idle split, failure rate by step, self-review and CI loop distributions, and nudge rate — each filterable by project, host, flow, runner, model, and time.
- Analytics continue to function after failed runs are pruned from run history.
- No tokens/cost surfaces are shown until extraction is hardened.
- Docs/UI contain no uncleared work project names, private hostnames, or local absolute paths.
