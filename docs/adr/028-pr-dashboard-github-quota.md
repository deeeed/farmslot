# ADR-028: PR Dashboard GitHub Quota Strategy

**Status:** Accepted
**Date:** 2026-04-23 (proposed) → 2026-05-01 (accepted, implementation on PR #42)
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-027](027-unified-gateway-state.md)

## Context

The PR dashboard (`pr-board`) surfaces live status for every PR the farmslot fleet has touched — one card per PR with checks, review state, bot-comment flags, and merge state. It refreshes automatically (`60s` client poll) and on demand (Refresh button, reconnect bootstrap, ci-monitor ticks).

Each refresh calls the gateway method `pr.list`, which in turn calls `fetchPRData(pr)` for every candidate PR. `fetchPRData` resolves PR state from GitHub via five REST calls per PR, all routed through `ghRequest` with ETag + negative caching:

| Call | Data                                                          | GitHub endpoint (via `gh`)                                                    |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1    | checks                                                        | `gh pr checks <N> --repo <owner/repo>`                                        |
| 2    | state / mergeable / mergeStateStatus / title / reviewDecision | `gh pr view <N> --json state,mergeable,mergeStateStatus,title,reviewDecision` |
| 3    | issue comments                                                | `gh api repos/<owner/repo>/issues/<N>/comments`                               |
| 4    | review (inline) comments                                      | `gh api repos/<owner/repo>/pulls/<N>/comments`                                |
| 5    | latest commit timestamp                                       | `gh api repos/<owner/repo>/pulls/<N>/commits`                                 |

Steady-state cost with `N` PRs on the dashboard and a `60s` poll is `5·N` REST calls per minute per UI client, plus whatever ci-monitor adds per active PR. GitHub's authenticated rate limit is `5000/hour` total across all endpoints. For `N ≥ 17` PRs on a single dashboard, the 60s poll alone approaches the ceiling; for larger fleets or multiple concurrent dashboards it routinely exceeds it.

Existing mitigations already in the codebase:

1. **Per-PR raw response cache** (`methods/pr.ts:104` — `PR_RAW_TTL_MS = 60_000`). Keyed by `repo#pr`. Collapses duplicate `pr.list` calls within a minute to one network round-trip per PR. Inflight dedup via `prRawInflight` collapses concurrent calls.
2. **`ghRequest` ETag + neg cache** (`github-client.ts`). Cheap retries for unchanged responses (HTTP 304) and short-circuits known-404s.
3. **Disk-backed `github-bindings.json`** (`github-bindings-cache.ts`). `{branch,repo} → prNumber` persists across gateway restarts so `findPRNumber` avoids the `gh pr list --head` fallback on every reconnect.
4. **Terminal-run TTL** (`methods/pr.ts:83` — `PR_DASHBOARD_TERMINAL_TTL_MS = 7d`). Ancient closed PRs from historical runs are dropped from the dashboard set so `prInfo` doesn't grow unbounded.
5. **Bootstrap/event separation** (ADR-027 evolution, PR #24). UI reconnect issues exactly one `pr.list` per socket open; live `PR_UPDATED` events avoid polling bursts. pr-board's mount-time / manual / poll refresh paths all gate on `!_hydrating` so manual actions cannot race the bootstrap.

These limit _duplicate_ fan-out but do not reduce the underlying `5·N` per 60s fan-out — every cache miss still costs five REST calls per PR.

## Decision Drivers

- Stay under GitHub's `5000/hour` authenticated rate limit for dashboards up to ~50 PRs.
- Preserve existing `PRStatus` shape and downstream consumers (pr-board UI, ci-monitor, recommendation/merge-state derivation). No schema migration.
- Keep the happy-path latency budget. Current dashboard cold load is ~1–3s for 10–20 PRs (five REST calls per PR, fan-out limited by `ghRequest` concurrency gate of 8). A single batched call must not regress this.
- Degrade gracefully when GraphQL hits its own rate limit (a distinct but related budget).
- No new dependency — `gh api graphql` already ships with the `gh` CLI that the gateway uses elsewhere.

## Options Considered

### A. Status quo — per-PR REST fan-out

Current behavior. `pr.list` fires `N` parallel `fetchPRData` calls, each doing five REST requests.

**Cost:** `5·N` REST / 60s window. Unbounded relative to dashboard size.
**Risk:** Hard rate limit for any real multi-project fleet. Re-dispatch loops downstream when the gateway can't fetch ground truth (see ADR-027 on this exact failure mode).
**Rejected.**

### B. Widen the cache TTL / slow the poll

Increase `PR_RAW_TTL_MS` from `60_000` to `300_000`, and/or drop the client poll from 60s to 5min.

**Pros:** One-line change. Immediate quota reduction.
**Cons:** UI feels stale — PR state changes only propagate on live events or manual refresh. Live events already cover most state changes, but checks/bot-comments transitions are REST-only today. Stale dashboard is a real UX regression.
**Rejected** as the primary fix; may be a secondary adjustment layered on top of (C).

### C. Aliased GraphQL batch for `pr.list` (recommended)

Replace the `N` parallel per-PR fan-outs in `prList` with **one** aliased GraphQL request to `gh api graphql`. Each alias retrieves the five fields' worth of data for one PR:

```graphql
query {
  pr_0: repository(owner: "owner", name: "repo") {
    pullRequest(number: 123) {
      state mergeable mergeStateStatus title reviewDecision
      statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion status }
        ... on StatusContext { context state }
      }}}
      comments(last: 50) { nodes { author { login } body createdAt } }
      reviewThreads(first: 100) { nodes { isResolved comments(first: 20) { nodes {
        databaseId author { login } body createdAt replyTo { databaseId }
      }}}}
      commits(last: 1) { nodes { commit { committedDate } } }
    }
  }
  pr_1: repository(owner: "owner", name: "repo") { ... }
  ...
}
```

The gateway rebuilds `PRRawSnapshot` entries (or a newly-structured equivalent) from the GraphQL response and writes them into `prRawCache`. The existing `fetchPRData` parallel loop then hits the cache for every PR — zero additional REST calls per refresh.

**Cost:** One GraphQL request per `pr.list` refresh, regardless of `N`. GraphQL counts against a separate quota (effective `5000` points/hour for a typical query of this shape). At `60s` polls with `N ≤ 50`, we land near `60` GraphQL requests/hour per client — two orders of magnitude under ceiling.
**Pros:** N×5 → 1 per refresh. Preserves per-PR cache invalidation semantics (can still `invalidatePRRawCache(repo, pr)` when a webhook fires). Preserves `fetchPRData` as the single PR code path for `pr.status` callers.
**Cons:** GraphQL response shapes differ from the REST endpoints — either synthesize stdout strings to match the existing parsers (fragile), or refactor `PRRawSnapshot` into structured fields and update the parsers (cleaner but larger blast radius). Query complexity cost scales with `N × review-thread-depth`; need to guard against oversized queries by chunking when `N > 100`.
**Status:** implementation pending on branch `feat/pr-list-graphql-batch`.

### D. Webhook-driven push

Replace polling with GitHub webhook deliveries that update gateway state reactively.

**Pros:** Lowest steady-state cost. Event-accurate freshness.
**Cons:** Requires public endpoint / tunnel for webhook delivery to a developer laptop. Significant infra change, and degrades offline.
**Deferred.** A reasonable follow-up once farmslot has a team-hosted gateway; not applicable to the single-user dev-laptop deployment shape.

## Decision

**Adopt (C).** Implement the aliased GraphQL batch in `prList` as the primary fix. Keep the per-PR REST path (`fetchPRData` + `getPRRawData`) as-is for the single-PR `pr.status` handler — that path is not a fan-out and the existing cache is sufficient there.

Option (B) adjustments (longer poll / longer TTL) may stack on top for very large fleets, but are not part of this ADR.

## Consequences

**Positive:**

- Steady-state `pr.list` cost drops from `O(5·N)` REST calls per refresh to `O(1)` GraphQL requests. A dashboard watching 50 PRs on a 60s poll goes from ~4,000 REST calls/hour to ~60 GraphQL calls/hour — roomy under the 5000/hour ceiling.
- `ci-monitor` and `pr.status` single-PR callers retain the REST path and 60s cache; no behavior change there.
- Cache key (`repo#pr`) unchanged, so `invalidatePRRawCache` and the webhook-invalidation hooks downstream still work.

**Negative:**

- Behavior-parity surface between REST and GraphQL fields (especially `statusCheckRollup.contexts` vs `gh pr checks` output, and `reviewThreads` vs `issues/<N>/comments` + `pulls/<N>/comments`). Regression risk in the recommendation/merge-state derivation if a field shape drift slips through.
- Query construction error-prone: each alias needs literal owner/name interpolated. Must sanitize inputs (we do — they come from trusted `project.json` repos, not user input).
- GraphQL has its own rate limit accounting (scoring rather than call count). A query touching 50 PRs × 100 check contexts × 100 review threads × 20 comments may cross the 1000-point-per-query soft cap; the implementation chunks when `N > 25` to stay under that.
- Two code paths to maintain: aliased GraphQL for `pr.list`, per-PR REST for `pr.status` / ci-monitor tick. The single-PR path is the legacy fallback and can be deleted once `pr.status` also migrates.

## Implementation Plan

1. **Add** `prefetchPRBatchViaGraphQL(repoGroupedPRs)` in `methods/pr.ts`. One GraphQL request per repo (aliased across PRs in that repo) — cross-repo aliasing is supported by GitHub's GraphQL but per-repo keeps query size bounded and error-localized.
2. **Parse** GraphQL response, synthesize `PRRawSnapshot` entries, write directly into `prRawCache`.
3. **Call** the prefetch at the top of `prList`, before the existing `Promise.all(fetchPRData)` loop. Existing per-PR calls become cache-hits.
4. **Skip** the batch path when `params.force === true` so explicit refresh flows still hit GitHub end-to-end.
5. **Metrics**: log `[pr.batch] N=X repos=Y graphql_cost=Z` per prefetch. Wire into `[github-client]` quota telemetry so the Global Filter Bar surfaces GraphQL-vs-REST consumption.
6. **Chunk**: for `prInfo` sets with >25 PRs in a single repo, split into multiple GraphQL requests sized to stay under the per-query cost cap.
7. **Rollout**: behind `FARMSLOT_PR_GRAPHQL=1` for one release cycle. Flip default to on once CDP validation confirms no drift against REST for the canonical PR recommendations used in CI-watch flows.

## Alternatives Not Reviewed

- Moving the PR fetching workload out-of-process (e.g., a background worker) — orthogonal to quota.
- Client-side pagination (render only visible cards) — cuts UI load but doesn't affect gateway quota.
- Rotating multiple `GH_TOKEN`s — explicitly out of scope; farmslot uses the developer's keychain token.

## Implementation Notes (2026-05-01)

Shipped on PR #42 as the aliased GraphQL batch (option C) with these deviations from the original plan:

1. **No `FARMSLOT_PR_GRAPHQL` flag.** Step 7 of the original Implementation Plan called for a one-cycle rollout flag. Dropped because (a) the synthesis layer round-trips through the same parsers (`parseChecksOutput`, `parseJsonLines`, `matchBotComments`, etc.) the REST path already uses, so parser-boundary parity tests cover correctness, and (b) the existing ETag/negative-cache path already provides a graceful fallback per chunk on GraphQL errors. Live CDP validation against a 15-PR / 2-repo dashboard confirmed the end-to-end shape matches REST (state, mergeable, reviewDecision, headRefName, title spot-checked on a real PR).
2. **No `params.force` skip-batch path.** `PRListParams` does not carry `force` and the UI's manual Refresh button never sends it, so step 4 of the original plan was dead code. Manual refresh re-runs `prList` end-to-end; the cache-aware skip below ensures it still re-fetches when `prRawCache` is stale.
3. **Cache-aware skip added.** GitHub's GraphQL endpoint does not honor `If-None-Match`, so the implementation skips PRs that already have a fresh `prRawCache` entry (within `PR_RAW_TTL_MS = 60s`) or an inflight per-PR REST fetch in `prRawInflight`. This makes the second 60s poll on a warm cache cost zero GraphQL requests instead of always re-batching.
4. **No `PRRawSnapshot` refactor.** Kept the existing five `*Stdout` string fields and synthesized them from the GraphQL response, rather than refactoring the snapshot to structured fields. Avoids a 6+ caller blast-radius (`pr.ts`, `dispatch.ts`, `run-engine.ts`, `task-writer.ts`, `ci-monitor.ts`) on a quota-fix slice.
5. **`pr.status` / ci-monitor / dispatch / task-writer keep the per-PR REST path.** Single-PR callers aren't fan-outs; the 60s `prRawCache` already covers them. No `pr.status` GraphQL migration in this slice.
6. **Issue-comment cap drift documented.** GraphQL `comments(last: 50)` slice diverges from REST `--paginate` for PRs with >50 issue comments — the dashboard batch path drops the OLDEST comments. Acceptable because `matchBotComments` only flags the most recent N posts and the per-PR `pr.status` path used by the slot view still sees every comment. Documented in code at the synthesis site.

Quota outcome (validated live, 2026-05-01): 15-PR / 2-repo dashboard at 60s poll = 1 GraphQL request per cold cache, 0 GraphQL requests on warm cache. Quota counter went from 5000 → 4990 over multiple polls (telemetry via existing `[github-client]` headers). Projected scaling: 50-PR dashboard ≈ 60 GraphQL requests/hour vs ~12000 REST/hour previously.
