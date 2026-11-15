# Copied from T3 Code

These files are copied from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, see `LICENSE`), `packages/shared/src` at commit `b8c2cfad`:

- `path.ts`
- `fileLinks.ts`
- `markdownLinks.ts`

Changes from upstream: formatted with this repository's Prettier, import specifiers end in `.js`, and the two `catch` blocks handle only the error they expect (`URIError`, `TypeError`) and rethrow anything else. Keep other edits out of these files so a later upstream sync stays a plain copy.
