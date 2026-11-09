# Run episodes

Normative specification for [ADR-039 Amendment 4](../adr/039-run-portable-bundles.md#amendment-4-2026-11-01-run-end-episode-capture).

Every run that ends (`done`, `failed` or `cancelled`) has one episode file at
`<runs dir>/episodes/<run-id>.json`. An episode describes the run as input,
trajectory and labels, for tools that learn from or retrieve past runs. It holds
references only: a file is named by its task-relative path and the sha256 already
recorded for it, never copied.

## Capture

- The terminal transition router's advisory `episode-capture` effect writes the
  episode after `backlog-settle` and the slot teardown. Its failure is reported on
  the transition result and never blocks or reverts the terminal state.
- An operator completion (force complete, output close, a result decision,
  adoption, re-review, supersede) releases its slot after the router returns,
  outside its locks. Its transition reports `episode-capture` as skipped, and the
  caller writes the episode right after that release
  (`captureEpisodeAfterRelease`). A run superseded by fresh reuse, a nudge or a
  warm handoff gets its episode after the old worker's teardown or the new run's
  slot claim.
- The hourly retention pass, before and independently of its archival work,
  captures every ended run updated since its last pass
  whose episode is missing or has an older `runUpdatedAt`. A failure keeps the
  watermark (`episodes/watermark.json`) at the failed run, so the next pass
  retries it. The first pass after an upgrade covers the preceding 24 hours.
- `farmslot runs bundle retain <runId>` rewrites the run's episode after the
  capture. A failed rewrite is logged; the retain result stands.
- Capture reads the run record, the manifests of the bundles, and the task's small binding and receipt files it references
  (`runBundleRefs`). It MUST NOT open, re-read or re-hash an artifact. An
  inventory entry with no recorded sha256 is counted in `sources.undigested`.
- The write is atomic (temporary file, then rename). A later run update replaces
  the file.

## Schema `farmslot-episode-v1`

| Field                                               | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `runId`, `capturedAt`, `runUpdatedAt`     | Identity, and the run revision described.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `project`, `flowType`, `status`                     | From the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `input`                                             | `ticket`, `summary`, `branch`, `startRef` (resolved sha, else requested ref), `dispatchHead`, `pr {repo?, number}`, `files[]`: `TASK.md`, `CHECKLIST.md`, `*.diff`, `*action-manifest.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `trajectory.recipes[]`                              | `recipe.json`, `*.recipe.json`, `recipe-resolution.json` and `recipe-library/` files outside recipe-run directories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trajectory.recipeRuns[]`                           | `{dir, files[]}` for each directory holding `summary.json` beside `recipe.json` or `trace.json`, in path order, failed attempts included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `trajectory.agents[]`                               | `role, runner, model, runnerSessionId, archive {relativeDir, sha256, sizeBytes}` (ADR-056).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `trajectory.steps[]`, `trajectory.recoveryAttempts` | Step `name, status, startedAt, completedAt`; replay count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `labels`                                            | `outcome` (run metrics), `failedStep`, `error`, `decisions[] {type, resolvedAction, resolvedAt}`, `reviews[]` (`*review-result*.json`), `recipeQuality[]` (`recipe-quality*`), `evidence[]` (`evidence-manifest.json`, `acceptance-status.json`, `artifact-manifest.json`, `latest-valid-recipe-run.json`, also when inside a recipe-run directory).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `provenance`                                        | `source`, `provider {package, version}`, `libraries[] {name, revision, fingerprint, dirty}`. Libraries come from the task's node-verified receipt (`artifacts/harness-provenance.json` `bindingIdentity`, refreshed at release, also after a repin) or else its binding (`inputs/recipe-binding.json`, ADR-069); the provider is copied from the binding only while both name the same libraries. `null` for an unbound task or an unreadable binding; a re-capture after retention archived the task copy keeps the recorded value; absent on episodes written before the field. `recordedAt` is the receipt's node time; `mirrored` is true only when the completion step captured the output and no agent attempt began after it; otherwise (cancelled while monitoring, even after a manual mirror refresh, or during a review fix after completion) a later repin is not reflected. |
| `sources`                                           | `bundles[]` (digests read), `unreadableBundles[] {digest, error}`, `undigested`, `media` (count of media files, which are not listed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`process` is an additive optional field on older episode-v1 records. New episodes
copy `RunAnalyticsRecord.activity.process`, as specified below. Its absence in
historical files MUST NOT be interpreted as successful adherence or zero work.

A file reference is `{path, sha256, bytes?, bundle?}`. `path` is relative to the
task directory; `bundle` is the digest of the retained bundle holding the bytes.
Without `bundle`, the bytes are where the run left them, or in the run archive
after Amendment 3 archival, and `sha256` verifies them. When both a retained
bundle and the output inventory name a path, the retained entry wins.

Files that match none of the roles above are left out. The schema names no
project, host or domain; projects differ only in the files their packs produce.

## Shared process activity

Normative contract for [ADR-032 Amendment 4](../adr/032-runner-observability-via-hooks.md#amendment-4-process-observations-in-the-shared-activity-record-2026-11-08).
`Run.metrics.activity` holds the frozen original-worker projection. Analytics
schema 3 copies it to `activity`; episode capture and recapture copy its `process`
section. Consumers MUST reuse this record rather than reconstruct labels from
the latest task mirror or start a separate activity stream. Analytics readers
continue accepting schema 1 and 2 records.

| Process field                            | Meaning                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`, `capturedAt`, `attempt` | Version 1; original run/context/role, engine generation, execution node and freeze boundary.                                                                                                                                                                                         |
| `sources`, `sourceBundle`                | Source identity, verified clock, session/generation/lease/command, event or byte window and content digests; the ordinary retained bundle preserves frozen sidecars. Paths are task-relative or retained-source-relative.                                                            |
| `checklist`                              | Original tick order/timestamps, expected rows, captured completion and source reference. Later bulk ticks do not erase earlier observations.                                                                                                                                         |
| `commits`                                | Pinned base/head range in graph order, with parents and author/committer times. A debug subject alone never proves a marker-only commit.                                                                                                                                             |
| `firstProductEdit`, `firstBaselineRun`   | First attributable non-marker product edit and first task-declared recorded baseline attempt, with event references. Edit start and completion observations bound the write; requested, failed and observed edits are distinguished. Baselines include failed reproduction attempts. |
| `rootCause`                              | Whether the frozen worker document has a non-empty Root Cause section outside code fences. It does not judge correctness or infer when it was written.                                                                                                                               |
| `markCalls`                              | Correlated requests/results, normalized checklist, step or terminal/subtask action and status. Shell success alone does not prove each nested mark succeeded.                                                                                                                        |
| `coverage`                               | Complete, partial or unavailable per field, with the reason. A readable source does not by itself prove complete attempt coverage.                                                                                                                                                   |
| `labels`                                 | Only `skipped_checklist` and `fix_before_baseline`, each with `true`, `false` or `null`, reason and source references.                                                                                                                                                               |

### Capture and attribution

The original worker's first finished-output acquisition MUST freeze these facts
before review reuse and slot teardown, outside terminal-transition locks. The
existing generation-fenced retained-output commit persists the projection and
its bundle reference together. Runtime normalizes events on their execution
host; raw command bodies, transcripts and credentials MUST NOT be copied into
analytics or episodes. Retain the existing worker task/checklist/signal sidecars
with the ordinary bundle. Later captures retain that original source reference.
Sidecars are advisory metadata: they follow required proof in retention admission
and become coverage gaps when unavailable, changed or unaffordable. The process
reference preserves metadata without adding a media pin.

Native capture uses the recorded owner, lease, generation and command window.
It MUST NOT start a host or use a recovery reader that repairs journal bytes.
Legacy transcript fallback needs a verified conversation and explicit attempt
boundaries. A verified fresh legacy conversation may use its first explicit
structured task request as a provider-clock boundary; this associates history
only and grants no prompt-delivery or lifecycle authority. Repeated tool IDs and correlated start/completion records are
deduplicated. Missing or ambiguous role/retry boundaries remain unattributed;
Gateway timestamps alone do not establish execution-node clock equivalence.
Timestamp comparisons require verified compatible clocks.

Product scope excludes task/runtime outputs and uses the existing contribution
filter. Proven diagnostic-only marker edits are excluded; ambiguous edits stay
unknown. Git reads use the pinned worker range before teardown, never a recycled
slot's HEAD. Baselines come from task-bound evidence/provenance metadata, not
directory names, filenames or filesystem mtimes.

`skipped_checklist` is true for a covered empty required checklist, or an observed
non-marker product edit before any tick. A later back-fill cannot erase the
observed skip. False requires a complete matching checklist and sufficient edit
coverage. `fix_before_baseline` is true only when attributable edits and complete
baseline coverage establish that order or the absence of a baseline at the
edit. A write must complete before the baseline to establish a violation;
overlapping intervals and equal timestamps leave order unknown. False requires
sufficient baseline and edit coverage. Partial, ambiguous
or incompatible observations produce `null`, never an invented negative.

Source failures are recorded as bounded coverage gaps and MUST NOT change any
run verdict or lifecycle decision. Retry only exact frozen identities, windows
and digests. No terminal enrichment may replace original-worker facts with a
review-fix or later task revision. Runs that ended before a snapshot receive a
shared deterministic unavailable projection. Historical readback MUST leave
original runs, analytics, episodes and judgments unchanged.
If cancellation wins while capture is pending, terminal emission freezes the
unavailable projection before its append; late acquisition cannot replace it.
