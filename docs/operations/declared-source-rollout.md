# Roll out declared sources

This procedure implements [ADR-069](../adr/069-declared-pinned-sources.md) and its
[source contract](../reference/declared-pinned-sources.md). Keep the private farm
configuration and evidence outside Git. Source management does not deploy services.

## Declare and verify

Inventory project packs, recipe libraries, helper repositories and every consumer.
Preserve operator edits upstream before enabling admission or deleting old copies.
Do not run filesystem migrations against a materialized source. Use upstream
schema changes or versioned load-time conversion.

The gateway reads `sources.json` under its farm home, or the explicit
`FARMSLOT_SOURCES_CONFIG` file. A declaration file has schema version 1, a positive
revision, a farm reconciliation interval between 1 and 300 seconds, a `sources`
array and `packs` bindings. Each source declares `id`, `kind`, credential-free
`repo` and optional `ref`, defaulting to `main`. Pack bindings select `sourceId`
and a contained repository-relative `entry` containing `project.json`.

Each source may declare a `farm-sources.json` file with schema version 1 and a
`dependencies` array of `sourceId`/`entry` bindings. Pack provider/library/template
bindings use the same IDs and contained entries. Hook paths use
`{{source:source-id}}/relative/entry`. Dependencies are read as data before code
loads. Undeclared sources, missing entries, cycles and unresolved external Git
objects refuse admission.

Change the declaration revision whenever its contents change. Authentication
stays in the existing per-repository Git credential handling. No credentials,
operator checkout paths or dirty snapshots belong in source declarations.

During this first stage, `sources.status` and `sources.sync` are gateway RPCs.
Status is read-only. Sync requires `operationId` and
`expectedDeclarationRevision`, with optional `sourceId`/`nodeId`. Retry the same
operation ID after a lost acknowledgement. It retains the exact saved lock plan.
Inspect per-project/node errors before proceeding. A repaired source uses a new
operation identity. Dedicated CLI/SDK commands and scoped branch pins follow in
the next approved stage.

## Prove the fleet

Run `scripts/sources-validation/fleet.mts` through the checkout-local TypeScript
loader with a private configuration file and a new absolute output directory.
Its configuration contains `sources` as above and `nodes` with unique
`source-proof-*` IDs, new `bundle`/`home` roots and the installed service's
`serviceNodeModules` directory. Remote nodes also provide `ssh` and an unused
`forwardPort`; their proof roots contain a `source-proof-*` directory.

The driver starts its own loopback gateway and temporary nodes with issued
credentials. It copies service code only; packs arrive through exact Git locks.
It verifies equal node inputs, write/chmod refusal, exact sync retry, retained-image
remount after a lost mount and drift refusal. It closes its services, tunnels and mounts, retaining `evidence.json`
and logs. Live fleet proofs stay outside default tests and CI.

## Enable admission and retire copies

Drain legacy runs against their original inputs. Their missing source facts stay
unknown; never relabel them as lock-admitted. With declarations enabled, new runs
freeze their selected closure and record it before execution. Nodes attest that
same lock before source-dependent actions. Drift holds the run in reconciliation
with ownership preserved. Restore the exact admitted inputs before replaying.

After a host reboot, materialization reattaches a missing mount from its retained
image and verifies the complete tree against the admitted lock. The receipt and
commit remain unchanged. Missing images, changed files at the mountpoint, writable
mounts and tree drift refuse work. Status and verify stay read-only. Explicit
`sources.sync` or the next admitted run step triggers recovery.

Sources mount read-only. macOS uses read-only disk images; Linux requires
SquashFS creation and permission to mount read-only volumes. Missing tools or
failed protection refuse work. Build/install caches, artifacts and mutable policy
remain outside those mounts. Backlog and auto-recovery settings retain their
operator update APIs through farm-owned runtime settings, with backups.

Retain run-referenced objects and materializations. Automatic ref advances create
new inputs without replacing an admitted generation. Keep deployment pack rsync
and stale copies until the final approved stage passes consumer parity and fleet
acceptance. Coordinate retirement of external source-sync stopgaps before that
deletion PR. Service deployment remains separate.
