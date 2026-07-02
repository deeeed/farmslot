# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- Suppress fleet idle/stuck monitor violations during orchestration phases (`preparing`, `dispatching`, etc.) so grade/prepare no longer emit worker-idle noise.
- Skip auto-nudge intelligence audit rows unless the run is in monitor or self-review worker phases.
- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-02

- Expose optional releaseNotes on gateway.status from release-notes.json generated at release cut
