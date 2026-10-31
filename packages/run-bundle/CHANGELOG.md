# Changelog

All notable changes to `@farmslot/run-bundle` are tracked here.

## Unreleased

- A wait on a run-bundle lock fails with `ELOCKED` only once the operation holding it in this process has run past its own limit (15 minutes for store-lock holders, 60 for a bundle repair or the gateway's retention pass), and the error names that holder, e.g. `held by capture of run <id> for 912s`. A long queue of healthy holders still waits, and a waiter that gives up leaves later callers queued behind the holder. Waits over 10 seconds are logged with the waiter's label. `withRunBundleStoreLock` accepts `{ label, holdLimitMs }`.

- Return the acquisition scan's file count and elapsed time for completion logging, without another tree walk.

- Measure acquisition and store trees with bounded parallel filesystem calls, so run completion no longer waits 30+ minutes on a busy gateway.

- Reuse existing admission reservations before scanning acquisition trees, allow new scans two minutes on a loaded gateway, and time out without creating a late reservation.

- Repair a missing gateway-written payload from its own directory.

- Retain gateway-written files from their own directory through `gatewayFiles`, so a package can freeze a file the gateway wrote after its source bundle.

- Share inactive reservation and abandoned capture selection with archive-only gateway retention, preserving admission capacity without deleting evidence.

- Queue retention work within a process so long captures do not exhaust other runs' file-lock retries. External contention errors include the lock path.

- Reading a retained artifact the capture declared it could not keep names the reason, e.g. `Artifact not retained (media-capacity): <path>`, instead of a bare `ENOENT` from `realpath`. The error keeps `code: 'ENOENT'`.
- Bundle garbage collection releases the reservations and pins of a refused completion once it is discarded or archived.
- `runBundleRefs(run)` lists every bundle a run references, each decision's with its decision, so garbage collection, the gateway's readers and run retention share one list.

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
