# Changelog

All notable changes to `@farmslot/gateway` are tracked here.

## Unreleased

- Fall back to the last pushed tmux pane snapshot (up to five minutes old) when live `tmux.panes` times out so slot worker inventory stays usable.
- Suppress false monitor nudges while workers are live or runs are blocked at publication human gate, including when prior nudge counts are saturated
- Gate stuck violations on absent pane progress markers instead of treating any live process as active work
- Stop treating Grok echoed task text after `❯` as a waiting-for-input composer prompt
- Return a gateway-owned Doctor section catalog and support catalog-only or section-scoped reports for progressive clients
- Harden gateway authentication rate-limit IP resolution by ignoring spoofable proxy headers unless explicitly trusted
- Harden local slot file reads, writes, and HTTP file serving against symlink escapes outside the configured repo

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.1 - 2026-07-02

- Expose optional releaseNotes on gateway.status from release-notes.json generated at release cut
