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

Use `farmslot sources status [sourceId]` for a farm view, or add `--node nodeId`
or `--run runId`. Status only reads reported facts. It shows effective branch,
pin scope, captured base main, shadowed selections, recorded locks and verified
node receipts. A retained run's inputs remain separate from today's selection.

`farmslot sources sync [sourceId] [--node nodeId]` reconciles the same authority
used by polling and materializes each selected node's complete scoped closure.
It reports source/node errors and preserves active generations. Sync never runs
project hooks, restarts services or grants resource leases.

Experiments require a pushed branch in the declared repository:

```sh
farmslot sources pin pack --ref experiment --node node-1
farmslot sources unpin pack --node node-1
```

Pin/unpin require exactly one of `--farm`, `--node nodeId` or `--run runId`.
Run wins over node, then farm. Unpin stores a visible main selection at that scope,
so a broader experiment does not become effective silently. Run changes require
an unadmitted run and revalidate its plan before execution. Active and historical
inputs are read-only. Use a new run to experiment with those inputs.

CLI commands reuse gateway connection/auth and JSON output options. The shared
`SourceCommandClient` from `@farmslot/protocol` captures current declaration/pin
revisions and prepares an operation packet. SDK hosts pass their existing
authenticated transport to `createSourceCommandClient`; they never resolve refs.
After a lost acknowledgement, retry `execute(preparedCommand)` unchanged. A CLI
error includes that exact `sourceCommand` packet for `farmslot rpc <method> '<params>'`.
Do not mint another operation ID or recapture revisions for an uncertain retry.
A rejected stale revision requires inspecting current status before a new request.

`run.create` accepts `sourceSelections`, an array of `{sourceId, selection, ref}`
where `selection` is `branch` with a pushed branch `ref`, or `main`. The gateway
prepares and validates the entire closure before registering the run. Selections
are run-scoped and cannot escape to siblings. Preview and queue planning use the
same provisional inputs without publishing pins or run execution receipts.

Command Center and Companion reuse one source-status controller/model for farm,
node, run and dispatch contexts. Their platform renderers show gateway facts and
pass selections to the same RPC contract. Mutation controls remain unavailable
for immutable runs and unsupported gateways. An uncertain request stays bound
to its original scope and authenticated farm connection.

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
