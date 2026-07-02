# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- Expose optional `releaseNotes` on `gateway.status` from `release-notes.json` generated at release cut.
- Return a gateway-owned Doctor section catalog and support catalog-only or section-scoped reports for progressive clients.
- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted.
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo.
- Active-development baseline; add user-facing changes here before release or package publication.
