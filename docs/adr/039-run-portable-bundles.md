# ADR-039: Portable Run Bundles for Cross-Gateway Reference Seeding

**Status:** Accepted
**Date:** 2026-06-27
**Relates to:** [ADR-005](005-state-persistence.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-025](025-run-family-observability.md), [ADR-030](030-replay-provenance-and-reference-evals.md), [ADR-036](036-cli-gateway-profiles.md)

## Context

Farmslot operators increasingly work in **parallel git worktrees** while keeping a single **canonical operator plane** on the main clone (gateway `7777`, Companion, durable `.runs/` history).

Today that split breaks down for eval validation:

1. **Run history is gateway-local.** `.runs/{id}.json` lives under the gateway process's `farmslotRoot` ([`services/gateway/src/runs/store.ts`](../../services/gateway/src/runs/store.ts)). A worktree sandbox on `7778` starts with an empty store.
2. **`prior-run` eval references require local run records.** `eval.experiment.create` with `{ kind: 'prior-run', runId }` calls `getRun()` in the connected gateway ([`services/gateway/src/methods/eval/source-resolution.ts`](../../services/gateway/src/methods/eval/source-resolution.ts)). Main-history run IDs are invisible in sandboxes.
3. **`package` import works but is manual.** ADR-030 made `ResultPackageManifest` the portable comparison unit. The `#evals` cockpit already accepts `{ kind: 'package', packagePath }`, but operators must hand-locate `reference.result-package.json` and sibling artifacts — there is no first-class export path.
4. **`FARMSLOT_RUNS_DIR` sharing is a footgun.** Pointing a sandbox gateway at main `.runs/` makes `prior-run` resolve, but new trials also write into canonical history unless the operator is extremely disciplined.
5. **ADR-030 follow-up #8 is adjacent, not sufficient.** Portable replay delta targets cross-slot hydration of artifact-only comparison branches. Worktree seeding needs cross-**gateway** reference portability without polluting main history.

The immediate product goal: **worktree agents can seed themselves with reference runs/packages from main**, run comparison/eval candidates locally, and keep real production history on main unless explicitly merged.

This ADR is the **transport layer** for that workflow. It must not fork the eval product model in [ADR-030](030-replay-provenance-and-reference-evals.md) or replace the future **corpus / suite** surfaces described there.

## Long-Term End State

Farmslot should converge on four distinct layers. Each layer has one job; conflating them creates the history-fragmentation and ontology drift problems we are trying to avoid.

| Layer                | Job                                                           | Durable home                                             | Mutable?               |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| **Operator plane**   | Live dispatches, monitoring, decisions, Companion history     | Main gateway `.runs/` + task trees                       | Yes — operational      |
| **Eval packages**    | Comparison evidence, rubric inputs, regression identity       | `ResultPackageManifest` under `projects/.../evals/...`   | Immutable once `final` |
| **Corpus / dataset** | Curated catalog of known-good references and recurring cases  | Future gateway-owned corpus store (ADR-030 follow-up #6) | Curated append/replace |
| **Portable bundles** | Explicit import/export between gateways, machines, and agents | `*.farmrun` files (transport only)                       | N/A — snapshots        |

**Canonical operator model (steady state):**

```text
Main clone (7777)          Worktree sandboxes (7778+)
─────────────────          ─────────────────────────
canonical .runs/    ──export──►  *.farmrun bundle
canonical packages           import (seed / reference-only)
real dispatches/evals        candidate trials (throwaway or promote-back)
Companion history            optional promote-back of packages only
```

**Promotion rule:** sandboxes may import references freely, but **candidate outcomes return to main** only via explicit promote/import of packages or new comparison runs — never by shared-writes into main `.runs/`.

**Relationship to ADR-030 suite/corpus:**

- **Dataset / suite draft** (ADR-030 §13) = _planning_ over many cases. The `#evals` cockpit already fans out `eval.experiment.create` / `eval.trial.start` per case.
- **Suite execution history** (future) = gateway-owned progress over many experiments. Bundles are **not** a suite runtime; they are snapshots _of_ suite/corpus selections for transport.
- **Corpus** (future) = versioned reference packages keyed by `datasetId` / `datasetItemId`. Corpus export is a **batch bundle of packages**, not a second run database.

**Relationship to portable replay delta (ADR-030 follow-up #8):**

- Bundles move **evidence and metadata** across gateways.
- Replay delta moves **re-appliable contribution patches** across slots.
- A `full` profile bundle may eventually embed delta payloads; the concerns stay separate.

**Companion / Command Center steady state:**

- **Companion:** read-only consumer of whichever gateway profile is active. No import UX — imported sandboxes appear automatically after CLI seed.
- **Command Center:** corpus/suite surfaces own batch _selection_; export/import buttons call the same bundle library as CLI.
- **CLI + agents:** primary automation path for worktree seeding and promote-back.

## Decision

Add a **portable run bundle** format and **CLI-first export/import** commands. Bundles are the interchange layer between gateways; they do not replace `ResultPackageManifest` as the eval comparison contract.

### 1. Bundle format: `farmrun` v1

A `*.farmrun` file is a **zstd-compressed tar** with a content-addressed manifest and payload entries (hash + byte verification on import).

```
farmrun-v1/
  manifest.json          # schema version, export profile, source provenance
  runs/                  # one or more Run JSON records (gateway shape)
  tasks/                 # relative task trees keyed by manifest task keys
  packages/              # optional ResultPackageManifest + EvalExperimentManifest copies
  analytics/             # optional per-run analytics slices (omit in reference profile)
```

`manifest.json` (minimum fields):

| Field                 | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `version`             | `1`                                                                  |
| `profile`             | `reference` \| `family` \| `full`                                    |
| `exportedAt`          | ISO timestamp                                                        |
| `source.gatewayUrl`   | e.g. `ws://localhost:7777`                                           |
| `source.farmslotRoot` | absolute path at export time (informational)                         |
| `source.runIds`       | original run IDs                                                     |
| `entries`             | map of logical keys → `{ sha256, bytes, path }` for integrity        |
| `remapPolicy`         | hints for import (`preserve-ids` \| `remap-ids` \| `reference-only`) |

**Profiles:**

- **`reference`** (default) — enough to seed eval comparisons: run metadata, task inputs + diff/evidence artifacts needed by `resolvePriorRunSource`, and any existing result packages. Omits active/monitoring fields and analytics.
- **`family`** — all runs sharing a `familyId`, plus shared task artifacts deduped by content hash.
- **`full`** — reference profile + analytics + quarantine-safe optional extras for forensic/debug export.

Bundles must be **public-safe**: no pool secrets, gateway tokens, or slot credentials. Strip or refuse export when run artifacts embed local paths that cannot be relocated; record `missingData` in manifest instead of failing the whole export when non-critical artifacts are absent.

### 2. Batch export scope

**Yes, batch export belongs in the long-term design — but not as a separate product surface.**

The `farmrun` format is intentionally **multi-entry** from v1 so batch and single export share one codec. What ships in phases:

| Phase    | Batch selector                                                         | Primary use                                                            |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **v1**   | `--family-id <id>` (implicit when exporting one run that has siblings) | Seed a comparison family into a sandbox                                |
| **v1**   | repeated `--run-id` or stdin list                                      | Agent script: export N baselines in one archive                        |
| **v1.1** | `--tag`, `--lane`, `--project`, `--since`                              | Operator collections, demo/review sets                                 |
| **v1.1** | `--eval-experiment <manifestPath>`                                     | Export one experiment's reference + candidate packages                 |
| **v2**   | `--suite-draft <manifestPath>`                                         | Snapshot a local `#evals` basket for offline replay on another gateway |
| **v3**   | `--corpus-slice datasetId/itemIds`                                     | Corpus migration once ADR-030 follow-up #6 lands                       |

**v1 does not need** a parallel `farmslot runs export-batch` command. One `farmslot runs export` with selector flags produces one `*.farmrun` containing N runs/tasks/packages. Import always accepts multi-entry bundles; default import mode applies per entry.

**Batch import semantics** (same human/protocol mapping as single import; default is `seed`):

- `seed` (default) — remap all run IDs; preserve `familyId` grouping when the bundle profile is `family`.
- `reference-only` (`--read-only`) — import all packages; create read-only stubs for runs.
- `mirror` (`--keep-ids`) — refused for multi-entry bundles unless `--force` (too risky for accidental history collision).

**What batch export is not:**

- Not a replacement for gateway-owned suite execution history.
- Not a corpus database — exporting 50 runs does not make them curated; corpus curation is a separate promote step.
- Not a live sync protocol — bundles are point-in-time snapshots, not subscriptions.

### 3. CLI commands (v1 surface)

Ship in `@farmslot/cli` first (ADR-036: profiles let any checkout target any gateway).

#### Human CLI surface (primary)

Operators should not need to learn protocol vocabulary. The CLI exposes plain flags; RPC/protocol keep the internal enum names.

**Export:**

```bash
farmslot runs export <runId> -o baseline.farmrun
farmslot runs export --family-id <familyId> -o family.farmrun
farmslot runs export --run-id <id1> --run-id <id2> -o refs.farmrun
farmslot runs export <runId> -o dump.farmrun --forensic
farmslot runs export <runId> --as-package /tmp/candidate.result-package.json
farmslot runs bundle ls baseline.farmrun
```

| Human flag    | Protocol profile | When                    |
| ------------- | ---------------- | ----------------------- |
| _(none)_      | `reference`      | Default baseline export |
| `--family-id` | `family` (auto)  | Whole comparison family |
| `--forensic`  | `full`           | Support / debug only    |

**Import:**

```bash
farmslot runs import baseline.farmrun
farmslot runs import baseline.farmrun --read-only
farmslot runs import baseline.farmrun --keep-ids --force
farmslot --url ws://localhost:7778 runs import baseline.farmrun
```

| Human flag                 | Protocol mode    | When                                             |
| -------------------------- | ---------------- | ------------------------------------------------ |
| _(none)_                   | `seed`           | **Default** — writable sandbox copy, new run IDs |
| `--read-only`              | `reference-only` | Packages + stubs; eval display only              |
| `--keep-ids` (+ `--force`) | `mirror`         | Disaster recovery; not worktrees                 |

Legacy hidden flags `--profile` and `--mode` remain for scripts and RPC callers.

#### Protocol import modes (internal)

| Mode                             | Behavior                                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed` (**CLI default**)         | Imports run records + task trees with **new run IDs** and `provenance.importedFrom` pointing at source IDs. Enables `prior-run` and comparison sibling launches in the target gateway without ID collision.    |
| `reference-only` (`--read-only`) | Writes packages + minimal run stubs marked `imported: true`, `readOnly: true`. Enables `eval.experiment.create` `package` and read-only `prior-run` display; **does not** allow relaunch/monitor as if native. |
| `mirror` (`--keep-ids`)          | Preserves original run IDs. Refused when a conflicting ID already exists unless `--force`. For disaster recovery, not daily worktree use.                                                                      |

Default target roots:

- Export reads from `FARMSLOT_ROOT` or the connected gateway's reported root.
- Import writes to the **target gateway's** `.runs/` and orchestrator task roots (`projects/.../tasks/...`), remapping `taskFile` paths on import.

### 4. Gateway RPC (v1.1, optional)

CLI filesystem export/import is sufficient for worktree seeding. Defer gateway methods until Command Center needs in-browser export:

- `run.bundle.export` — returns bundle bytes or a temp path + manifest summary
- `run.bundle.import` — validates manifest, applies import mode, returns imported run IDs

CLI remains the automation/agent contract; RPC is a thin wrapper over the same library code.

### 5. Eval integration

Import/export must align with ADR-030, not fork it:

1. **Preferred eval seed path after import:** `eval.experiment.create` with `{ kind: 'package', packagePath }` when the bundle included packages; `{ kind: 'prior-run', runId }` only after `seed` mode imported a resolvable run.
2. **Export should emit packages when present.** If the run participated in an eval experiment, include `reference.result-package.json` / `candidate.result-package.json` and experiment manifest paths in the bundle.
3. **`reference-only` imports** must not register writable comparison branches that violate `start-ref-policy.ts` remote-branch guards. Packages remain the safe comparison substrate.

### 6. UI scope

| Surface                            | v1          | Rationale                                                                                                                                                                              |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLI**                            | Yes         | Agents and worktree scripts need deterministic, scriptable seeding.                                                                                                                    |
| **Command Center `#evals`**        | Light touch | Reuse existing manual `package` path field; add optional post-import "browse bundles" only if CLI proves insufficient.                                                                 |
| **Run detail**                     | Defer       | Optional "Export reference bundle…" button in v1.1 once CLI stabilizes.                                                                                                                |
| **Companion**                      | **No**      | Companion reads whatever the connected gateway exposes. After sandbox import, runs appear automatically — no mobile-specific import UX. Operators who need seeding use CLI or desktop. |
| **Family compare / observability** | No change   | Imported runs use normal family projections once seeded.                                                                                                                               |

### 7. Operator model (canonical workflow)

**Main** stays the production operator plane. **Worktrees** seed sandboxes:

```text
Main:     farmslot runs export <baselineRunId> -o /tmp/baseline.farmrun
Worktree: farmslot --gateway sandbox runs import /tmp/baseline.farmrun
Worktree: farmslot --gateway sandbox rpc eval.trial.start '{...}'
```

Real dispatches/evals that must appear in Companion history still target `--gateway local` (main). Sandbox seeding is for **validating gateway/eval code changes**, not for fragmenting production history.

### 8. Non-goals (v1)

- Gateway-owned corpus database or suite execution runtime (ADR-030 follow-ups #5–#6 remain separate).
- Live sync / watch / mirror of `.runs/` between gateways (bundles are explicit snapshots only).
- Replacing `ResultPackageManifest` with raw run JSON as the comparison contract.
- Implementing portable replay delta / cross-slot patch apply (ADR-030 follow-up #8).
- Companion import UI or mobile batch upload.
- npm-published standalone CLI dependency (ADR-036 deferred item).

## Alternatives Considered

### A. Extend ADR-030 in place instead of a new ADR

**Rejected.** ADR-030 defines eval experiment/package semantics. Cross-gateway operational portability is a transport concern that spans run persistence (ADR-005), CLI profiles (ADR-036), and eval seeding. A focused ADR keeps ADR-030 readable.

### B. `FARMSLOT_RUNS_DIR` symlink/share documentation only

**Rejected.** Sharing `.runs/` conflates read and write paths; sandboxes silently append to canonical history. Bundles make import explicit and auditable.

### C. Gateway-only export via live `run.get` + manual artifact zip

**Rejected.** Filesystem-aware export handles offline main clones, large artifacts, and agent automation without requiring the source gateway to stay up.

### D. Companion import UI first

**Rejected.** Mobile operators consume history; they do not manage worktree sandboxes. CLI-first matches the parallel-agent workflow and ADR-036 automation story.

## Consequences

### Positive

- Worktree agents can self-seed reference baselines without touching main `.runs/`.
- Eval validation in gateway sandboxes (`7778`) becomes practical with explicit import modes.
- Formalizes the ad-hoc `package` path workflow ADR-030 already assumes.
- Keeps Companion and main history simple — no new mobile surfaces.

### Negative

- Bundle format maintenance (schema versioning, artifact relocation edge cases).
- Risk of duplicate family IDs if operators misuse `mirror` / `--keep-ids` on main — mitigated by defaulting imports to `seed` (writable remap) and hiding `mirror` behind `--keep-ids --force`.
- Some task artifacts remain machine-local; manifest must surface `missingData` honestly.

## Implementation Plan (after acceptance)

1. **Protocol** — `RunImportProvenance`, bundle manifest types in `@farmslot/protocol`.
2. **Library** — `packages/cli/src/run-bundle/` (or `services/gateway/src/runs/bundle/`) shared pack/unpack + validation.
3. **CLI** — `farmslot runs export|import|list-bundles` with `--gateway` targeting.
4. **Tests** — round-trip fixtures: prior-run eval create after `seed` import; `reference-only` + package eval path.
5. **Docs** — `docs/operations/worktree-operator-model.md` cross-link (operator workflow).
6. **Roadmap** — slot under ROADMAP-next item 3 (replay closure) as enabling infrastructure for item 4 (eval regression program).

## Follow-Ups

1. v1.1 selectors: `--tag`, `--lane`, `--eval-experiment`, `--suite-draft`.
2. Command Center export on run detail + family compare ("Export family bundle…").
3. Gateway RPC wrapper (`run.bundle.export` / `run.bundle.import`) once UI needs it.
4. `farmslot runs import --seed-eval <bundle>` — import + auto `eval.experiment.create` per package.
5. **Promote-back flow:** sandbox candidate → `--as-package` export → main import as new comparison sibling.
6. Corpus slice export once ADR-030 follow-up #6 lands (batch of curated reference packages, not raw runs).
7. Coordinate with ADR-030 follow-up #8 so `full` profile bundles can embed replay-delta payloads.

## Amendment 1: 2026-10-15 gateway-retained run artifacts

**Status:** Accepted by the lead, 2026-10-15, at `978e2e27`. Implementation pending.
**Normative specification:** [Retained run artifacts](../reference/retained-run-artifacts.md).

### Decision

Use the existing farmrun-v1 manifest and payload layout as the gateway's retained
artifact home under `FARMSLOT_HOME`. Materialize immutable, digest-addressed bundles
when completion, output review or publication produces a report or evidence.
The owning Run store durably binds one bundle root under its data home. Gateways
sharing that Run store use the same binding, not a sandbox's private auth home.
The Run store keeps references; decisions, reviews and attestations pin their
digest. This extends the original transport-only scope without
creating another run database or changing eval-package authority.

Command Center, Companion, CLI, publication and artifact HTTP reads use these
bundles. Only explicit capture/backfill may read a slot. Slot reuse, cleanup,
node downtime and mark-reviewed cannot change a retained report. Read a verified
manifest index directly; do not unpack an archive or rescan a slot per view.

A stale review binding is a visible warning when reading an available report,
not a reason to hide it. Reading never grants proof or publication admission.
ADR-062's canonical reader, package validation, selection and judgment rules
remain authoritative.

Default limits are 2 GiB per bundle and 20 GiB per owning store, including a
protected 512 MiB report/metadata reserve. Reserve mandatory metadata before
admission and commit produced reports before media. Media quota exhaustion must
leave reports readable, with missing media explicit. Recording/transcode limits
stay unchanged.

Preserve ADR-062's separate lifetimes: history pins reports and lightweight frozen
metadata; unresolved gates and required published references pin media.
Unpinned media follows its existing 30-day Storage policy and may become pruned
without changing manifest identity or historical verdicts. GC shares the capture
commit lock and removes only eligible media, unreferenced bundles and abandoned
staging. It cannot evict pinned evidence or active reservations.

One supported backfill command captures existing done/failed runs while their
source remains available. It preserves run identity, verdicts and historical
bindings, records missing or changed bytes honestly, and never executes work.

### Public surface

- `farmslot runs bundle retain <runId>` in `@farmslot/cli` calls `run.bundle.retain`.
  Operators use this idempotent command for historical backfill.
- `@farmslot/run-bundle` owns experimental `materializeRunBundle` and
  `resolveRunBundleEntry` exports, using the existing v1 codec and integrity rules.
  Gateway capture, HTTP readers and export consume them.
- Additive protocol bundle references carry the digest to existing run, gate and
  artifact consumers. Existing SDK evidence reader/model/validator APIs remain.
  New surface is experimental and ships with normal package versioning.

### Rationale and consequences

Remote artifact discovery makes report latency depend on the node and allows a
reused slot to invalidate history. One local immutable capture removes that
read-time dependency. It costs bounded gateway disk and copy work at capture.
Incomplete historical data remains explicit; retention does not manufacture
missing proof. Export/import continue to use the same portable bundle format.

## Amendment 2: 2026-10-20 settled-run retention

**Status:** Accepted (lead, 2026-10-20).
**Related:** [ADR-056](056-runner-session-archive.md) (session archives),
[ADR-058](058-static-review-and-farm-owned-qa.md) (review workspaces),
[ADR-062](062-recorded-run-evidence.md) (evidence lifetimes),
[ADR-065](065-fail-closed-run-lifecycle.md) (settled-run guards).
**Normative specification:** [Settled-run retention](../reference/retained-run-artifacts.md#settled-run-retention).

### Context

A run kept its record, task directory with recordings, session archive, review
workspace, native worker state and bundle until an operator deleted it. Archive
kept them forever, and task pins were never removed. On the dev farm host this
filled the disk while runs worked: 21 GB free fell to 14 GB in 3.5 hours. The
owner's rule (2026-10-19) is that completely done runs are cleaned up, with no
archive.

### Decision

The gateway runs one retention pass 10 minutes after it starts and then every
hour. It deletes a run, and the storage only that run owns, when all of these
hold:

- the run is done or cancelled, or archived;
- it settled at least 48 hours ago;
- it needs none of its execution storage: no open decision, its review workspace
  is cleaned, no closeout is pending and no native worker is held;
- it holds no slot and has no pending backlog reconciliation;
- it carries no operator tags;
- it has no PR, or its PR is merged or closed.

Live, gated, blocked and unarchived failed runs are never selected. A PR the run
does not record as merged or closed is checked under every identity the run has:
the review-session identity (adopted target, PR work, PR link or `owner/repo#N`
ticket) and its number in the project's repository. It counts as settled only when
the pass read those repositories' open PRs and none is among them. An
unresolvable identity, an unreadable repository or a possibly truncated list keeps
the run.

Deleting the run releases its backlog link without requeueing the item, as
archiving a blocked run does, and releases its history pin. The bundle store's
collector then removes bundles no remaining run references. Just before deleting
each run, the pass rechecks it and, in the same synchronous step, moves aside the
directories no other run references and no run being admitted holds: its task
directory under a farm task root, and its review-workspace directory and native
worker state on the gateway's own node. Each move is recorded first. A refused
delete moves them back; an interrupted pass's directories go back if their run
still exists and are purged once it is gone. A directory on another volume, which
cannot move reversibly, keeps its run. Task pins whose task directory no longer
exists are removed 48 hours after they were written. Other nodes' storage and slot
checkouts are left to their owners.

### Rationale and consequences

Published PR evidence lives in the project's artifacts repository, so deleting a
merged or closed run's local bundle leaves its PR intact. Archive becomes a
48-hour holding state rather than permanent history. A deleted run also leaves
roadmap delivery lineage, family observability, evaluation trial results and
review-round history. Operator tags keep a run for those uses.

Shared caches (review repositories and support caches, slot scaffolding) and the
bundle store budget keep their existing owners. Storage on other nodes has no
retention pass yet. Settled runs with stale open decisions stay until those
decisions are resolved.

### Public surface

No RPC or protocol change. `@farmslot/run-bundle` exports `runBundleRefs`, the one
list of a run's bundle references that GC, readers and retention share.
`services/gateway/scripts/run-retention-plan.ts` is a read-only dry run of the pass
that lists entries and GB per store.

## Amendment 3: 2026-10-29 permanent run history and movable storage

**Status:** Proposed, explicitly requested by Arthur, 2026-10-29. Supersedes Amendment 2's deletion policy.

Retention never deletes run records. Active and archived JSON records remain in
place and visible in Command Center forever. The existing settled/48-hour,
PR, tag, ownership and admission guards select storage for archival only.
Storage moves into `FARMSLOT_RUN_ARCHIVE_ROOT`, defaulting to `run-archive` under
the farm home. A run's existing links record its restore manifest. The manifest
journals original paths and archive destinations, preserving relative paths,
bytes, modes and symlinks. Repeated/interrupted moves retain every generation.
Cross-volume moves verify the copy before removing the source copy.

The root must already exist and the gateway process must successfully write and
sync a probe there before any move. Missing/unwritable roots fail the pass loudly;
there is no deletion fallback. Old retention trash is archived with its restore
metadata. Gateway startup/capture no longer invoke destructive bundle GC; budget
admission continues to refuse insufficient capacity. Inactive reservations and
abandoned capture scaffolding are archived before admission rather than charged
forever. Only selection and staging hold admission locks; bulk copying does not.
Operators restore storage
using the recorded paths while its run is inactive. Automated restore is outside
this change.

### Public surface

One environment setting, `FARMSLOT_RUN_ARCHIVE_ROOT`. The hourly gateway pass and
read-only retention-plan script remain the consumers. Run records use the existing
`links` field for a local manifest reference; no public package or RPC change.
The private `@farmslot/run-bundle` housekeeping selector is consumed by gateway
admission, capture and hourly archival. No worker protocol changes.

## Amendment 4: 2026-11-01 run-end episode capture

**Status:** Accepted, lead-approved amendment (2026-11-01). Implementation: [#1663](https://github.com/deeeed/farmslot/pull/1663).
**Specification:** [Run episodes](../reference/run-episodes.md).

### Decision

Every run that ends (done, failed or cancelled) records one small episode: a
`farmslot-episode-v1` JSON describing the run as input, trajectory and labels.
The ADR-053 transition router writes it through the advisory `episode-capture`
effect, which runs after `backlog-settle` and after the slot teardown, so it never
delays a slot. A failure is recorded on the transition result and never blocks or
reverts the terminal state. An operator completion (force complete, output close,
a result decision, adoption, re-review or supersede) releases its slot only after
the router returns and its locks are free, so its transition skips the effect and
the hourly pass captures the episode after that release. The hourly retention
pass also retries every other run: each pass
captures every ended run updated since the last pass whose episode is missing or
describes an older revision. A failure keeps that pass's watermark at the failed
run.

An episode lists references, not copies. Each file is a task-relative path plus
the sha256 that the run's output inventory or a retained bundle manifest already
recorded, with the bundle digest when a retained copy holds the bytes. Capture
reads only those small manifests. It never opens, re-reads or re-hashes an
artifact, and an inventory entry without a recorded digest is counted, not hashed.
Media is counted and follows the existing retention policy.

- **Input:** ticket, branch, start ref, dispatch head, PR, and the task, checklist,
  diff and action-manifest files.
- **Trajectory:** the recipe documents, every recipe-run directory the inventory
  names (failed attempts included), agent contexts with their session-archive
  digests (ADR-056), steps and recovery attempts.
- **Labels:** outcome, failed step, error, decisions, review results,
  recipe-quality outputs, and evidence and acceptance manifests.

Retained bundles are immutable and digest-addressed, so the episode lives beside
the run record rather than inside a bundle: `<runs dir>/episodes/<run-id>.json`.
Like the record, it is kept forever. Earlier attempts' bytes stay where the run
left them and are preserved by Amendment 3's task-dir archival; the episode's
digests verify them. The schema is project-neutral, and a project contributes
only its pack (action manifests and recipes).

### Rationale and consequences

A run's training value used to depend on which side store survived. Analytics
rows outlive records, bundles keep only the selected attempt, and transcripts
link to runs only through session ids. One capture point at run end makes every
future run a complete episode for one small file write, using digests that
already exist. Offline tools derive app maps and recipe scores from episodes; the
gateway computes neither.

### Public surface

- `<runs dir>/episodes/<run-id>.json` (`farmslot-episode-v1`), plus the retry
  pass's `episodes/watermark.json`. No new RPC and no protocol type.
- `farmslot runs bundle retain <runId>` also rewrites that run's episode, so a
  backfilled capture's digests reach it.
- The `episode-capture` effect outcome appears on terminal transition results.
