# @farmslot/run-bundle

Portable `.farmrun` codec for exporting and importing Farmslot run history between
gateways and worktrees.

This package collects run records, artifacts, and related metadata from a
`.runs/` tree, packs them into a zstd-compressed tar archive, and imports them
into another workspace with configurable identity and write policies.

## Canonical documents

- [ADR-039: Portable run bundles](../../docs/adr/039-run-portable-bundles.md) — bundle format, import modes, and operator model.
- [Worktree operator model](../../docs/operations/worktree-operator-model.md) — main operator plane vs sandbox seeding.

## Install

```bash
yarn add @farmslot/run-bundle @farmslot/protocol
```

## Main exports

```ts
import { exportRunsToBundle, importBundle, listBundle } from '@farmslot/run-bundle';
```

## CLI and gateway

Human-facing commands live in `@farmslot/cli`:

```bash
farmslot runs export <runId> -o baseline.farmrun
farmslot runs import baseline.farmrun
farmslot runs bundle ls baseline.farmrun
```

Gateway RPC methods: `run.bundle.export`, `run.bundle.import`, `run.bundle.list`.

## Import modes

| Mode             | CLI flag             | Behavior                             |
| ---------------- | -------------------- | ------------------------------------ |
| `seed`           | default              | Writable copy with new run ids       |
| `reference-only` | `--read-only`        | Read-only reference for eval seeding |
| `mirror`         | `--keep-ids --force` | Preserve ids when safe               |

## Source layout

| Path                     | Owns                                               |
| ------------------------ | -------------------------------------------------- |
| `src/index.ts`           | Public package export surface.                     |
| `src/archive.ts`         | zstd+tar `.farmrun` pack/unpack.                   |
| `src/collect.ts`         | Run tree collection and manifest assembly.         |
| `src/export.ts`          | Export profiles (`reference`, `family`, `full`).   |
| `src/import.ts`          | Import modes (`seed`, `reference-only`, `mirror`). |
| `src/paths.ts`           | Run-root and artifact path helpers.                |
| `src/hashing.ts`         | Content hashing for bundle integrity.              |
| `src/copy-tree.ts`       | Filesystem copy helpers for import.                |
| `src/round-trip.test.ts` | Seed-mode export/import round-trip tests.          |

## Maintenance rules

1. **Keep bundles portable.** No machine-specific absolute paths in exported manifests.
2. **Import modes are contractual.** CLI and gateway defaults must stay aligned with ADR-039.
3. **Protocol types only.** Run record shapes come from `@farmslot/protocol`; do not fork schemas here.
4. **Fail loudly.** Corrupt archives, hash mismatches, and unsafe mirror imports must throw with useful errors.

## Local quality

```bash
yarn workspace @farmslot/run-bundle quality
```
