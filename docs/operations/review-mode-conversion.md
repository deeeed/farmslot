# Convert persisted review configuration

This pre-deploy procedure supports [ADR-063](../adr/063-review-modes-warm-cold.md)
and its [review contract](../reference/review-modes-warm-cold.md). Maintainers own
it until every runtime store uses the current contract. It is an offline
conversion, with no compatibility layer in the gateway.

Run the script from the implementation checkout, with its shared package built.
Set `FARMSLOT_ROOT` to the runtime checkout being upgraded. The script uses the
gateway's `FARMSLOT_BACKLOG_FILE`, `FARMSLOT_DISPATCH_QUEUE_FILE`,
`FARMSLOT_RUNS_DIR` and `FARMSLOT_PROJECTS_DIR` overrides when configured; otherwise
it uses `.backlog.json`, `.dispatch-queue.json`, `.runs` and `projects` below that
root. Explicit `--backlog`, `--queue`, `--runs-dir` and `--projects-dir` paths
override those defaults. PR intake configuration comes from `.pr-rules.json`
below the root, or an explicit `--pr-rules` path. It reads only those JSON stores, archived run JSON and
immediate project `project.json` files. It never reads environment files,
credentials, artifacts, session archives or orchestrator verdict/review state.

## Before restarting the gateway

1. Inspect the proposed changes. Dry-run is the default and writes nothing:

   ```bash
   node scripts/migrate-review-configuration.mjs --root "$FARMSLOT_ROOT"
   ```

2. Resolve every reported `unresolved` path in an owned offline copy. Exit code
   `2` means conversion needs an operator choice. A `runner: "same"` row maps to
   its run's recorded worker runner, using run metrics or an unambiguous primary
   agent context. Rows without that evidence are reported by ID and refused.
   The converter never deletes rows or substitutes project defaults. Unknown
   fields, contradictory old/new configuration, invalid counts/order and
   unsupported model/effort choices are also refused. A `full-live` sequence
   requires a separate QA configuration. Existing WARM rows require their
   already recorded lineage context; the converter never creates one.

3. Stop gateway processes that write these stores through the project's normal
   deployment procedure. Re-run the same dry-run against the stopped stores.
   Continue only when `unresolved` is zero, then apply explicitly:

   ```bash
   node scripts/migrate-review-configuration.mjs --root "$FARMSLOT_ROOT" --apply
   node scripts/migrate-review-configuration.mjs --root "$FARMSLOT_ROOT"
   ```

   The final dry-run must report zero changed files and zero unresolved paths.
   Start the upgraded gateway only after that check passes. This procedure does
   not start, stop or restart reviewer sessions or live lanes.

The report contains counts, item IDs, file paths and field paths. It never prints
configuration values or tokens. Missing optional stores are skipped. Other
read/write failures exit `1` with a redacted diagnostic.

## Conversion and preserved history

| Stored contract                                                                 | Conversion                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `reviewDepth`                                                                   | `reviewPolicy`, retaining the stored minimum plus requested extras as `minimumReviews`    |
| `pendingReviewPlan`                                                             | Ordered `reviewSequence`, retaining runner/model/effort and assigning COLD to legacy rows |
| `independentReviews`                                                            | `reviews`, keeping each review ID, verdict and evidence                                   |
| `self-reviewing` status; `self-review` / `self-review-fix` roles and step names | `reviewing`; `review` / `review-fix`                                                      |
| Pipeline review source and summary field names                                  | Current vocabulary, preserving their recorded results                                     |
| Project `self_review` and publication review count keys                         | `review` with COLD defaults and `minimum_reviews`                                         |
| Historical session/range vocabulary                                             | Warm/cold mode labels derived from recorded intent/range, without adding proof            |

PR intake options and execution alternatives also get COLD defaults. Their
model/effort choices, resource restrictions, profile/request IDs and publication
metadata are preserved. Legacy full-live options need an explicit farm QA profile.

The converter applies the outgoing gateway's v1 double-count repair before
folding requested extra reviews into the minimum.

Run, review, decision and context IDs remain unchanged, as do session IDs/paths,
base/head SHAs, diff hashes, provenance metadata, verdicts and artifact references.
Historical artifact filenames are not renamed. Historical WARM labels do not
establish a durable `reviewId` binding or authorize another review. Old gate
receipts remain historical receipts, not new dispatch requests. The separate
orchestrator's legacy verdict files remain in place for existing PRs.

Apply refuses the entire batch before writing if any conversion is unresolved.
Each changed file gets an exclusive `.adr063-original` backup and an atomic
replacement with its original permissions. Applying an already converted store
is a no-op. An existing backup or a concurrent edit is refused. If an I/O failure
interrupts apply, keep writers stopped, inspect the per-file originals and restore
the affected originals before retrying. Retain the originals in a secured backup
directory when preparing another apply attempt. Do not overwrite a backup to
silence an error.
