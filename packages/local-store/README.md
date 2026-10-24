# Local resource store

Private SQLite adapters for the ADR-071 client cache. Command Center and its
desktop app use a dedicated SQLite WebAssembly worker on `opfs-sahpool`.
Companion uses `expo-sqlite` in its platform cache directory. Protocol owns the
portable contract and never imports this package.

## Source layout

- `src/sqlite-store.ts` owns scoped query rows, atomic replacement, schema resets,
  deletion fencing and the five-store limit.
- `src/native.ts` adapts Expo SQLite.
- `src/browser.ts` owns the worker, tab ownership and deletion coordination.
- `src/browser-worker.ts` opens the browser database and serves store operations.
- `test/` runs the exported portable conformance contract and SQLite regressions.

## Maintenance rules

Keep one database owner per platform connection so its serial executor also owns
schema changes and deletion. A deleted incarnation never accepts another write,
including one queued before deletion. Closing a profile preserves its store;
authority revocation deletes it. Store no credentials. Drafts belong elsewhere.

Query persistence is enabled only as its resource slice migrates. Platform open
failures fall back through the shared cache with a visible notice.

## Local quality

Run `yarn workspace @farmslot/local-store quality`. Unit tests use real SQLite;
browser and native recipes additionally prove the actual storage adapters,
ownership, cache-directory placement and fallback behavior.
