# Changelog

All notable changes to `@farmslot/node` are tracked here.

## Unreleased

- fix(fs): include file modification time in `fs.stat` responses so remote gateways can reject stale derived artifacts using the same freshness contract as local slots.
- fix(resources): replace each slot's complete resource-watch set on refresh, including empty sets, so removed device and process watches cannot keep publishing stale status.
- perf(exec): resolve the exported operator login environment once and reuse it in no-rc command shells, preventing frequent resource health probes from repeatedly sourcing expensive startup files; restart the node after changing shell-managed environment or toolchains.
- fix(screen): reject unsupported thumbnail platforms instead of silently routing them through the iOS simulator capture path.
- fix(fs): path confinement no longer rejects every path under a root that already ends with the separator (`root='/'` demanded a `//` prefix). Any absolute remote path the gateway decomposes to `{root:'/', relPath}` hit this — remote-slot support-bundle writes failed as `Path traversal outside root is not allowed`.
- **BREAKING:** `exec` runs argv arrays without a shell (login-shell PATH resolved once per node and reused), and `fs.*` resolves `{root, relPath}` under the declared root instead of trusting a pre-joined absolute path. Opens use `O_NOFOLLOW` and act on the returned handle, so a path cannot be swapped between check and use; `.git` is refused outright. Callers see `EACCES` for a refused path and a bounded-size error for an oversized read rather than a silent full read.
