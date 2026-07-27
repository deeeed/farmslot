# Changelog

All notable changes to `@farmslot/node` are tracked here.

## Unreleased

- **BREAKING:** `exec` runs argv arrays without a shell (login-shell PATH resolved once per node and reused), and `fs.*` resolves `{root, relPath}` under the declared root instead of trusting a pre-joined absolute path. Opens use `O_NOFOLLOW` and act on the returned handle, so a path cannot be swapped between check and use; `.git` is refused outright. Callers see `EACCES` for a refused path and a bounded-size error for an oversized read rather than a silent full read.
