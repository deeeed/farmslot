# Migrating a machine to one farm root

Operator procedure for [ADR-039 Amendment 6](../adr/039-run-portable-bundles.md#amendment-6-2026-11-09-one-farm-root-per-instance-one-path-resolver). Keep with the migration command.

Stop the instance's gateway and node. From its existing checkout, retain its legacy per-store environment overrides and use the local CLI. For example, from `apps/command-center`:

```sh
nice -n 15 yarn farmslot paths migrate --home /path/to/farm --data /volume/farm --plan
nice -n 15 yarn farmslot paths migrate --home /path/to/farm --data /volume/farm --apply
nice -n 15 yarn farmslot paths --home /path/to/farm --json
```

`--data` defaults to `FARMSLOT_DATA`, then `<home>/data`. Use a separate data subdirectory per instance. Planning writes nothing. `--json` lists moves, bytes, volume methods, rewrites, retained paths and conflicts.

Apply refuses live processes, PID/lock holders, a listening gateway port, non-terminal runs, staged archives, `.retention-*` bundles, redirected targets, collisions and insufficient space. Cross-volume trees with symlinks refuse. No symlinks are created.

The journal is `<home>/backups/migrate-<timestamp>-<id>.json`. Moves rename on the same volume; cross-volume copies verify file lists, bytes, permissions and SHA-256 before removing sources. Atomic rewrites keep original bytes beside the journal. Repeat `--apply` after interruption.

Older archive roots are discovered through run-manifest links and media availability paths. Their run directories merge into `data/run-archive`, with every manifest entry preserved, including duplicates. Payload collisions refuse. Bundle ownership/settings, archive paths/links, media availability, pin provenance/receipts and moved JSON/JSONL references follow the new roots.

Slot checkouts and runtime directories stay in place, as do already placed data and shared legacy prepare scratch. Code deployment and service operations remain separate. Provision the instance's code before restarting.

While stopped, roll back with:

```sh
nice -n 15 yarn farmslot paths migrate --home /path/to/farm --rollback
```

Rollback restores original bytes and locations and removes `config/instance.json`. Repeating it is harmless. Keep the journal and its directory. Run history and learning files are never discarded.
