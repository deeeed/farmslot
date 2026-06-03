# Farmslot — Mobile Companion Canonical PRD

**Owner:** Arthur / Farmslot
**Last updated:** 2026-05-22
**Stale by:** 2026-08-22

This canonical chunk PRD defines the Mobile Companion within the Farmslot hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the authoritative chunk contract for the native mobile oversight experience.

## Scope

The Mobile Companion owns the native phone-first oversight experience for Farmslot:

- read-heavy fleet visibility away from the desk
- decision inbox and notifications
- task progress, terminal observation, PR status, and artifact viewing on mobile
- mobile-specific interaction patterns such as background/foreground lifecycle handling, push, and haptics

## User Outcome

An operator away from the desktop should still be able to understand farm state, react to decisions, monitor progress, and review evidence from a native mobile surface.

## Canonical Current State

- The mobile companion is already an active product chunk, not just roadmap intent.
- [ROADMAP.md](ROADMAP.md) and [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md) record M1a-M4 complete and M5/operator-control hardening.
- The mobile app shares the same gateway protocol model as the desktop command center while optimizing for native mobile constraints.
- 2026-05-16 implementation note: the current mobile review-cockpit pass is scoped as M5/operator-gate hardening. It prioritizes ready/review gate evidence, PR visual before/after review, and safe tmux replies from mobile; it is not a broad desktop-parity lane.
- 2026-05-21 implementation note: mobile evidence review must make **before → after delta identification** explicit. Visual pairs are not just gallery items; they are the operator's fastest proof that a run changed the intended thing before approval or follow-up dispatch.
- 2026-05-22 implementation note: [ADR-033](adr/033-mobile-tmux-worker-control.md) is implemented through the V1/M8 surface: all tmux panes on registered nodes are manageable worker resources, with hook/status/task/tmux-derived status, node-level branch/activity summaries, live xterm/PTY mobile terminal control, shortcuts, foreground voice nudges, authenticated gateway profile/pairing support, Android device targeting, and terminal keyboard/drag polish. Deferred mobile scope remains background wake-word, auto-send without tap, and remote node provisioning.

## Requirements

### 1. Shared backend truth

The mobile companion must consume the same gateway/state model as other product surfaces.

### 2. Mobile-native supervision

The experience should optimize for remote oversight, notifications, quick decisions, artifact review, and focused observation rather than desktop-style full editing.

### 3. Reliable away-from-desk awareness

Push notifications, connection state, and concise task/fleet summaries must make the operator aware of urgent events without requiring a desktop session.

### 4. Scope discipline

Mobile should complement the desktop command center, not replicate every heavy desktop workflow on a phone.

## Boundaries

- This document is the canonical mobile chunk contract.
- Mobile is not the authority for whole-product sequencing; that belongs to [PRD-product.md](PRD-product.md) and the canonical roadmaps.
- Full desktop editing, broad configuration management, and heavy review authoring remain outside this chunk's core contract.

## Supporting Evidence and Deep Dives

- [ADR-033: Mobile Tmux Worker Control](adr/033-mobile-tmux-worker-control.md)
- [ROADMAP.md](ROADMAP.md)
- [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md)
- ADR-012 and the gateway/protocol-related ADRs that shape shared backend behavior, especially ADR-002, ADR-008, ADR-023, ADR-027, ADR-032, and ADR-033

## Success Condition for This Chunk

Farmslot operators can supervise active work, react to decisions, and inspect evidence from a native mobile companion without weakening the shared system model or overloading the phone experience with desktop-only complexity.
