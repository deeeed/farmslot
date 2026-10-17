# Changelog

All notable changes to `@farmslot/run-bundle` are tracked here.

## Unreleased

- Bundle garbage collection releases the reservations and pins of a refused completion once it is discarded or archived.

- Bundle garbage collection keeps the reservations and pins of a failed run that still holds its resources (`isActiveListRun`).

- Retain immutable gateway artifact snapshots in farmrun v1 bundles, with store pairing, quota reservations, recovery, retention and target-owned imports.
- Pin prepared captures throughout an active run and verify durable manifests before recording references or availability.
- Acquisition accounting counts linked project dirs and charges a projects dir inside `<root>/.sandbox` once, not twice.

- Acquisition accounting finds run task folders under `FARMSLOT_PROJECTS_DIR` through the protocol farm layout.

- Keep imported claim-override metadata from granting gateway authority.

- Skip non-run JSON in the runs directory when selecting runs to export, so a run-id prefix lookup no longer fails on the runtime capability store. Export `parseRunRecordFile` for the Gateway run store.
- Strip runner session archive pointers on export and import, and never pack `.runs/session-archives/`.

- ADR-039 portable `.farmrun` export/import codec and CLI integration.
- Human-first CLI flags: default writable import, `--read-only`, `--keep-ids`, `--forensic`.
