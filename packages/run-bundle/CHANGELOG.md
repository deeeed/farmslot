# Changelog

All notable changes to `@farmslot/run-bundle` are tracked here.

## Unreleased

- Skip non-run JSON in the runs directory when selecting runs to export, so a run-id prefix lookup no longer fails on the runtime capability store. Export `parseRunRecordFile` for the Gateway run store.
- Strip runner session archive pointers on export and import, and never pack `.runs/session-archives/`.

- ADR-039 portable `.farmrun` export/import codec and CLI integration.
- Human-first CLI flags: default writable import, `--read-only`, `--keep-ids`, `--forensic`.
