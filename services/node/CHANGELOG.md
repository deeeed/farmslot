# Changelog

All notable changes to `@farmslot/node` are tracked here.

## Unreleased

- perf(resources): coalesce all iOS simulator liveness watches into one bounded `simctl` inventory probe per node cycle, fan results out by simulator name or UDID, and discard stale results when watch sets are replaced.
- perf(resources): stagger and bound external health probes per node, cancel queued probes from replaced watch sets, reduce fallback polling frequency, avoid CDP/lsof repair while a watched PID is healthy, and expose aggregate watch pressure through node health.

- fix(deploy): require an explicit machine-scoped credential for remote installs, protect credential-bearing service files, and reliably re-bootstrap macOS launchd jobs instead of reporting success after a failed legacy reload.

- fix(fs): enforce `FILE_TRANSFER_CHUNK_MAX_BYTES` fail-closed on `fs.readChunk` length and `fs.writeChunk` payload (MANUAL-000095 self-review).

- fix(fs): `fs.writeChunk` accepts optional `mode` (applied on create + chmod) so private attachments can stay 0o600 (MANUAL-000095 self-review).

- fix(fs): `fs.writeChunk` loops until the full buffer is written and returns actual `bytesWritten` (MANUAL-000095 self-review).

- feat(fs): `fs.writeChunk` for progress-aware remote uploads (MANUAL-000095 follow-up).

- feat(fs): `fs.readChunk` — confined ranged base64 reads for progress-aware large transfers (MANUAL-000095).

- fix(auth): back off to the reconnect ceiling on deterministic auth rejections (node-subject required / auth failed) instead of spinning at 500ms, and print the credential-issue fix line once per rejection; backoff now resets on successful auth, not on socket open (MANUAL-000103).
- feat(auth): re-resolve the gateway credential on every reconnect and prefer the freshly written `.env.local-auth` node token over stale inherited launch credentials, so activation and node credential rotation take effect without restarting the node.
- feat(fs): report `mtimeMs` from `fs.stat` so the gateway can bound its stale-attachment sweep on remote slots.
- fix(resources): replace each slot's complete resource-watch set on refresh, including empty sets, so removed device and process watches cannot keep publishing stale status.
- perf(exec): resolve the exported operator login environment once and reuse it in no-rc command shells, preventing frequent resource health probes from repeatedly sourcing expensive startup files; restart the node after changing shell-managed environment or toolchains.
- fix(screen): reject unsupported thumbnail platforms instead of silently routing them through the iOS simulator capture path.
- fix(fs): path confinement no longer rejects every path under a root that already ends with the separator (`root='/'` demanded a `//` prefix). Any absolute remote path the gateway decomposes to `{root:'/', relPath}` hit this — remote-slot support-bundle writes failed as `Path traversal outside root is not allowed`.
- **BREAKING:** `exec` runs argv arrays without a shell (login-shell PATH resolved once per node and reused), and `fs.*` resolves `{root, relPath}` under the declared root instead of trusting a pre-joined absolute path. Opens use `O_NOFOLLOW` and act on the returned handle, so a path cannot be swapped between check and use; `.git` is refused outright. Callers see `EACCES` for a refused path and a bounded-size error for an oversized read rather than a silent full read.
