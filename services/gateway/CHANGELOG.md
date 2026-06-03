# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted.
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo.
- Active-development baseline; add user-facing changes here before release or package publication.
