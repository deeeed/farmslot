# Changelog

## Unreleased

- The native storage peers follow Expo SDK 58: `expo-sqlite` ~58.0.15 and `expo-file-system` ~58.0.13.

- Schema 5 stores run-list rows beside their query entry (`resource_rows`): `getRows` reads the entry and its rows in one serial job, `mergeRows` writes the entry, deletes and upserts in one transaction, `putQuery` keeps the rows, and deleting the entry, store or scope removes them. Older schemas are rebuilt; drafts are unaffected.

- Add the drafts store (`@farmslot/local-store/drafts`): one draft per scope, slot, run and path, IndexedDB and memory adapters, and a 30-day sweep once a slot or run can no longer be read.

- A sign-out deletion that fails is retried before the next owner of the same scope opens its store, so that owner never reads the previous owner's rows.

- A sign-out whose cleanup fails, such as observer withdrawal on a closed socket, no longer keeps the next principal in the same tab on memory storage.

- Store content by identity in schema 4 (`resource_content`, `resource_content_aliases`, and prefetch origin and cohort on query rows), with blob binding through the browser worker and the native adapter.

- Forward foreground and background changes to shared collector interests without replacing the selected cache or renewing interest through reads.

- Share workspace snapshot retention and access recency across readers, reset outdated cache schemas, and preserve saved observation age and drafts.

- Add private SQLite stores for the shared client cache, with browser worker and Expo adapters, remembered scope for offline rendering, scoped deletion, schema rebuilds and a five-store limit. Query metadata inspection shares the store serialization queue. Navigation retires the browser worker before document teardown and reopens it when a page returns from the back/forward cache.
