# Changelog

## Unreleased

- feat: export `DEFAULT_GATEWAY_TLS_PORT` (7778) — the shared default port the gateway serves `wss://` on when TLS is configured, so the gateway daemon and CLI reference one source of truth instead of duplicating the literal.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.7.4 - 2026-07-06

- Add `@farmslot/protocol/checklist-target` as the canonical checklist filename registry (worker, self-review, ci-fix) with signal derivation, nested-loop progress filtering, and UI progress label helpers; optional `ChecklistTargetRegistry` supports dynamic overrides.

## 0.7.3 - 2026-07-06
