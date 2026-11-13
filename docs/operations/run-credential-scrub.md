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
missing ones.

Pass `--root <dir>` or `--root=<dir>` (repeatable) to scan exactly those
directories: any `--root` replaces the default list, so stores you leave out
(an `archive/` you mean to keep, say) are neither scanned nor rewritten. An
unknown argument exits with status 2 before anything is scanned. So does a
`--root` that resolves, symlinks followed, to `/`, the home directory, the farm
home (it holds `credentials.json`), any directory containing the farm home, a
system tree (`/System`, `/Applications`, `/Library`, `/usr`, `/bin`, `/sbin`,
`/opt/homebrew`) or a path with fewer than 3 segments such as `/Users/x` or
`/Volumes/disk` (paths inside the temp dir excepted); the message names the
refused root and why.

Set `FARMSLOT_SCRUB_ALLOWED_PREFIX=<dir>` to confine a run: any root (default
or `--root`) whose real path is outside `<dir>` exits with status 2 before
scanning, and the library refuses to rewrite a file outside it. The tests set it
to their own temp dir. Never run `--apply` by hand outside a `mktemp -d`
directory except for the real one-shot against the gateway's stores.

Only real credential values change: a value assigned to a name ending in
`_KEY`, `_TOKEN`, `_PAT` or `_CREDENTIALS` when it looks like a secret (16+
characters mixing at least two of lowercase, uppercase and digits; not a
`$NAME` reference or an `org/repo` path); any 12+ character value under a name
ending in `_SECRET`, `_PASSWORD` or `_PASSWD`, single-case passwords and
hyphenated or quoted spaced passphrases included (not a reference, path, URL or
plain number; an unquoted shell value ends at the first space);
and provider token shapes (`sk-`, `sk-ant-`, `ghp_`/`gho_`/`ghs_`/
`github_pat_`, Atlassian `ATATT`, `xoxb-`/`xoxp-`, `AKIA…`, `glpat-`, `npm_`,
`AIza…`, `hf_`, `xai-`, `fw_`) wherever they appear. Placeholders such as `local`, numbers,
single-case slugs such as `metamask-extension`, names such as
`…_API_KEY_INDEX` or `…_MAX_TOKENS`, and ordinary prose are left alone. The
gateway applies the same rules when it stores and loads run records.

Add `--apply` to rewrite in place. Files keep their mode and JSON
layout; no backup copies are written. A second run reports zero records.
Packed `.farmrun`/tar bundles are listed, not rewritten; re-export or delete them.
