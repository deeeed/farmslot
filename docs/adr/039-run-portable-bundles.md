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

| Layer | Job | Durable home | Mutable? |
| ----- | --- | ------------ | -------- |
| **Operator plane** | Live dispatches, monitoring, decisions, Companion history | Main gateway `.runs/` + task trees | Yes — operational |
| **Eval packages** | Comparison evidence, rubric inputs, regression identity | `ResultPackageManifest` under `projects/.../evals/...` | Immutable once `final` |
| **Corpus / dataset** | Curated catalog of known-good references and recurring cases | Future gateway-owned corpus store (ADR-030 follow-up #6) | Curated append/replace |
| **Portable bundles** | Explicit import/export between gateways, machines, and agents | `*.farmrun` files (transport only) | N/A — snapshots |

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

- **Dataset / suite draft** (ADR-030 §13) = *planning* over many cases. The `#evals` cockpit already fans out `eval.experiment.create` / `eval.trial.start` per case.
- **Suite execution history** (future) = gateway-owned progress over many experiments. Bundles are **not** a suite runtime; they are snapshots *of* suite/corpus selections for transport.
- **Corpus** (future) = versioned reference packages keyed by `datasetId` / `datasetItemId`. Corpus export is a **batch bundle of packages**, not a second run database.

**Relationship to portable replay delta (ADR-030 follow-up #8):**

- Bundles move **evidence and metadata** across gateways.
- Replay delta moves **re-appliable contribution patches** across slots.
- A `full` profile bundle may eventually embed delta payloads; the concerns stay separate.

**Companion / Command Center steady state:**

- **Companion:** read-only consumer of whichever gateway profile is active. No import UX — imported sandboxes appear automatically after CLI seed.
- **Command Center:** corpus/suite surfaces own batch *selection*; export/import buttons call the same bundle library as CLI.
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

| Field | Purpose |
| ----- | ------- |
| `version` | `1` |
| `profile` | `reference` \| `family` \| `full` |
| `exportedAt` | ISO timestamp |
| `source.gatewayUrl` | e.g. `ws://localhost:7777` |
| `source.farmslotRoot` | absolute path at export time (informational) |
| `source.runIds` | original run IDs |
| `entries` | map of logical keys → `{ sha256, bytes, path }` for integrity |
| `remapPolicy` | hints for import (`preserve-ids` \| `remap-ids` \| `reference-only`) |

**Profiles:**

- **`reference`** (default) — enough to seed eval comparisons: run metadata, task inputs + diff/evidence artifacts needed by `resolvePriorRunSource`, and any existing result packages. Omits active/monitoring fields and analytics.
- **`family`** — all runs sharing a `familyId`, plus shared task artifacts deduped by content hash.
- **`full`** — reference profile + analytics + quarantine-safe optional extras for forensic/debug export.

Bundles must be **public-safe**: no pool secrets, gateway tokens, or slot credentials. Strip or refuse export when run artifacts embed local paths that cannot be relocated; record `missingData` in manifest instead of failing the whole export when non-critical artifacts are absent.

### 2. Batch export scope

**Yes, batch export belongs in the long-term design — but not as a separate product surface.**

The `farmrun` format is intentionally **multi-entry** from v1 so batch and single export share one codec. What ships in phases:

| Phase | Batch selector | Primary use |
| ----- | -------------- | ----------- |
| **v1** | `--family-id <id>` (implicit when exporting one run that has siblings) | Seed a comparison family into a sandbox |
| **v1** | repeated `--run-id` or stdin list | Agent script: export N baselines in one archive |
| **v1.1** | `--tag`, `--lane`, `--project`, `--since` | Operator collections, demo/review sets |
| **v1.1** | `--eval-experiment <manifestPath>` | Export one experiment's reference + candidate packages |
| **v2** | `--suite-draft <manifestPath>` | Snapshot a local `#evals` basket for offline replay on another gateway |
| **v3** | `--corpus-slice datasetId/itemIds` | Corpus migration once ADR-030 follow-up #6 lands |

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

| Human flag | Protocol profile | When |
| ---------- | ---------------- | ---- |
| *(none)* | `reference` | Default baseline export |
| `--family-id` | `family` (auto) | Whole comparison family |
| `--forensic` | `full` | Support / debug only |

**Import:**

```bash
farmslot runs import baseline.farmrun
farmslot runs import baseline.farmrun --read-only
farmslot runs import baseline.farmrun --keep-ids --force
farmslot --url ws://localhost:7778 runs import baseline.farmrun
```

| Human flag | Protocol mode | When |
| ---------- | ------------- | ---- |
| *(none)* | `seed` | **Default** — writable sandbox copy, new run IDs |
| `--read-only` | `reference-only` | Packages + stubs; eval display only |
| `--keep-ids` (+ `--force`) | `mirror` | Disaster recovery; not worktrees |

Legacy hidden flags `--profile` and `--mode` remain for scripts and RPC callers.

#### Protocol import modes (internal)

| Mode | Behavior |
| ---- | -------- |
| `seed` (**CLI default**) | Imports run records + task trees with **new run IDs** and `provenance.importedFrom` pointing at source IDs. Enables `prior-run` and comparison sibling launches in the target gateway without ID collision. |
| `reference-only` (`--read-only`) | Writes packages + minimal run stubs marked `imported: true`, `readOnly: true`. Enables `eval.experiment.create` `package` and read-only `prior-run` display; **does not** allow relaunch/monitor as if native. |
| `mirror` (`--keep-ids`) | Preserves original run IDs. Refused when a conflicting ID already exists unless `--force`. For disaster recovery, not daily worktree use. |

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

| Surface | v1 | Rationale |
| ------- | -- | --------- |
| **CLI** | Yes | Agents and worktree scripts need deterministic, scriptable seeding. |
| **Command Center `#evals`** | Light touch | Reuse existing manual `package` path field; add optional post-import "browse bundles" only if CLI proves insufficient. |
| **Run detail** | Defer | Optional "Export reference bundle…" button in v1.1 once CLI stabilizes. |
| **Companion** | **No** | Companion reads whatever the connected gateway exposes. After sandbox import, runs appear automatically — no mobile-specific import UX. Operators who need seeding use CLI or desktop. |
| **Family compare / observability** | No change | Imported runs use normal family projections once seeded. |

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