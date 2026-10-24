# Changelog

## Unreleased

- Share workspace snapshot retention and access recency across readers, reset outdated cache schemas, and preserve saved observation age and drafts.

- Add private SQLite stores for the shared client cache, with browser worker and Expo adapters, remembered scope for offline rendering, scoped deletion, schema rebuilds and a five-store limit. Query metadata inspection shares the store serialization queue. Navigation retires the browser worker before document teardown and reopens it when a page returns from the back/forward cache.
