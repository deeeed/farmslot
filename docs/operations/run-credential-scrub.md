# Run credential scrub

Older run records stored worker launch lines with the node's pool environment
inlined, credential values included. Current gateways store names only and
redact older records when they load them. This one-shot rewrites the stored
files themselves: live runs, `archive/`, `quarantine/`, decision journals, the
run archive and run bundle directories.

Deploy the gateway fix first, or stop the gateway, so no running gateway writes
an unredacted copy back. Dry run (prints record ids, field paths and counts,
never values):

```bash
TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx scripts/scrub-run-credentials.mts
```

Without `--root` it scans the gateway's runs directory, run archive and run
bundles for the current farm paths. Pass `--root <dir>` (repeatable) to choose
stores. Add `--apply` to rewrite in place. Files keep their mode and JSON
layout; no backup copies are written. A second run reports zero records.
Packed `.farmrun`/tar bundles are listed, not rewritten; re-export or delete them.
