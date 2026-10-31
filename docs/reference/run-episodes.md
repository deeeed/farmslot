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
- An operator completion releases its slot after the router returns, outside its
  locks. Its transition reports `episode-capture` as skipped, and the hourly pass
  writes the episode after that release.
- The hourly retention pass captures every ended run updated since its last pass
  whose episode is missing or has an older `runUpdatedAt`. A failure keeps the
  watermark (`episodes/watermark.json`) at the failed run, so the next pass
  retries it. The first pass after an upgrade covers the preceding 24 hours.
- `farmslot runs bundle retain <runId>` rewrites the run's episode after the
  capture. A failed rewrite is logged; the retain result stands.
- Capture reads the run record and the manifests of the bundles it references
  (`runBundleRefs`). It MUST NOT open, re-read or re-hash an artifact. An
  inventory entry with no recorded sha256 is counted in `sources.undigested`.
- The write is atomic (temporary file, then rename). A later run update replaces
  the file.

## Schema `farmslot-episode-v1`

| Field                                               | Content                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `runId`, `capturedAt`, `runUpdatedAt`     | Identity, and the run revision described.                                                                                                                                                                                                                                                                                                            |
| `project`, `flowType`, `status`                     | From the run.                                                                                                                                                                                                                                                                                                                                        |
| `input`                                             | `ticket`, `summary`, `branch`, `startRef` (resolved sha, else requested ref), `dispatchHead`, `pr {repo?, number}`, `files[]`: `TASK.md`, `CHECKLIST.md`, `*.diff`, `*action-manifest.json`.                                                                                                                                                         |
| `trajectory.recipes[]`                              | `recipe.json`, `*.recipe.json`, `recipe-resolution.json` and `recipe-library/` files outside recipe-run directories.                                                                                                                                                                                                                                 |
| `trajectory.recipeRuns[]`                           | `{dir, files[]}` for each directory holding `summary.json` beside `recipe.json` or `trace.json`, in path order, failed attempts included.                                                                                                                                                                                                            |
| `trajectory.agents[]`                               | `role, runner, model, runnerSessionId, archive {relativeDir, sha256, sizeBytes}` (ADR-056).                                                                                                                                                                                                                                                          |
| `trajectory.steps[]`, `trajectory.recoveryAttempts` | Step `name, status, startedAt, completedAt`; replay count.                                                                                                                                                                                                                                                                                           |
| `labels`                                            | `outcome` (run metrics), `failedStep`, `error`, `decisions[] {type, resolvedAction, resolvedAt}`, `reviews[]` (`*review-result*.json`), `recipeQuality[]` (`recipe-quality*`), `evidence[]` (`evidence-manifest.json`, `acceptance-status.json`, `artifact-manifest.json`, `latest-valid-recipe-run.json`, also when inside a recipe-run directory). |
| `sources`                                           | `bundles[]` (digests read), `unreadableBundles[] {digest, error}`, `undigested`, `media` (count of media files, which are not listed).                                                                                                                                                                                                               |

A file reference is `{path, sha256, bytes?, bundle?}`. `path` is relative to the
task directory; `bundle` is the digest of the retained bundle holding the bytes.
Without `bundle`, the bytes are where the run left them, or in the run archive
after Amendment 3 archival, and `sha256` verifies them. When both a retained
bundle and the output inventory name a path, the retained entry wins.

Files that match none of the roles above are left out. The schema names no
project, host or domain; projects differ only in the files their packs produce.
