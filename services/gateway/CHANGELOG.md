# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- Allow `gateway.doctor` to run a single section so clients can show progressive health-check status.
- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted.
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo.
- Active-development baseline; add user-facing changes here before release or package publication.
