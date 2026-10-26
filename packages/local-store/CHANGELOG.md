# Changelog

## Unreleased

- Store content by identity in schema 4 (`resource_content`, `resource_content_aliases`, and prefetch origin and cohort on query rows), with blob binding through the browser worker and the native adapter.

- Forward foreground and background changes to shared collector interests without replacing the selected cache or renewing interest through reads.

- Share workspace snapshot retention and access recency across readers, reset outdated cache schemas, and preserve saved observation age and drafts.

- Add private SQLite stores for the shared client cache, with browser worker and Expo adapters, remembered scope for offline rendering, scoped deletion, schema rebuilds and a five-store limit. Query metadata inspection shares the store serialization queue. Navigation retires the browser worker before document teardown and reopens it when a page returns from the back/forward cache.
