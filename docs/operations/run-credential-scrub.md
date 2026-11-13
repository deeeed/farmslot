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
FARMSLOT_HOME=~/.farmslot-dev TSX_TSCONFIG_PATH=services/gateway/tsconfig.json \
  node --import tsx scripts/scrub-run-credentials.mts
```

Run it from the gateway's checkout with the gateway's `FARMSLOT_HOME` (and
`FARMSLOT_RUN_ARCHIVE_ROOT`, if the gateway sets it). Without `--root` it scans
the stores `farmslot paths` reports for that home: the runs directory, the run
archive, the run bundle store (`run-bundle-retention.json` `storeRoot`), and
`run-archive/` and `archive/` in the bundle store's data directory. The farm
home itself is never scanned. The output starts with every root and marks
missing ones. Pass `--root <dir>` (repeatable) to choose stores.

Only real credential values change: a value assigned to a name ending in
`_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PASSWD`, `_PAT` or `_CREDENTIALS`
when it looks like a secret (16+ characters, not a `$NAME` reference, number,
placeholder such as `local`, or `org/repo` slug), and provider token shapes
(`sk-`, `sk-ant-`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, Atlassian `ATATT`,
`xoxb-`/`xoxp-`, `AKIA…`, `glpat-`, `npm_`) wherever they appear. Names such as
`…_API_KEY_INDEX` or `…_MAX_TOKENS` and ordinary prose are left alone. The
gateway applies the same rules when it stores and loads run records. Add `--apply` to rewrite in place. Files keep their mode and JSON
layout; no backup copies are written. A second run reports zero records.
Packed `.farmrun`/tar bundles are listed, not rewritten; re-export or delete them.
