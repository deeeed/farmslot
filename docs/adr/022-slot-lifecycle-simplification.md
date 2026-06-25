# ADR-022: Slot Lifecycle Simplification

**Status:** Accepted
**Date:** 2026-04-11

## Context

The slot state machine has 11 `SlotLifecycle` values, a 3-value `SlotMode`, and a 4-value `agent` field — but no spec. This caused repeated bugs (stale `agent: 'working'` making slots undispatchable) because there are too many transitions to get right. Many values are redundant:

- `ready` vs `released` — both dispatchable, only differ by warm build
- `preparing` vs `dispatching` — both mean "orchestrator is setting up"
- `pr-watch` was merged into `ci-watch` — both meant "held for PR"
- `review-gate` — primarily a run-step phase, but publication gate-hold also uses it as a slot `phase` with `agent: working` ([ADR-038](038-gate-held-worker-session.md))
- `releasing` — brief transient (<10s)
- `custom` — redundant with `disabled` (just blocks dispatch); replaced by `manual` for "continue working" case
- `SlotMode` — redundant with lifecycle (`custom`/`disabled` exist in both)

## Decision

Collapse 11 lifecycle values to 5 core states. Move detail into a `phase` sub-field for UI display only.

### New types

```typescript
type SlotLifecycle = 'ready' | 'busy' | 'held' | 'manual' | 'disabled';

type SlotPhase =
  | 'preparing'
  | 'dispatching'
  | 'working'
  | 'releasing'
  | 'review-gate'
  | 'ci-watch'
  | null;

type SlotAgent = 'idle' | 'working' | 'no-tmux';
```

`SlotMode` is removed from the protocol. Pool JSON `mode` field persists as a config-only concept, mapped at load time:

- `dispatch` → lifecycle from fleet check (ready/busy/held)
- `custom` → `lifecycle: 'manual'`
- `disabled` → `lifecycle: 'disabled'`

`warm: boolean` on `SlotStatus` replaces the `ready` vs `released` distinction.

### Migration mapping

| Old lifecycle | New lifecycle | phase           | warm    |
| ------------- | ------------- | --------------- | ------- |
| `ready`       | `ready`       | `null`          | `true`  |
| `released`    | `ready`       | `null`          | `false` |
| `preparing`   | `busy`        | `'preparing'`   | -       |
| `dispatching` | `busy`        | `'dispatching'` | -       |
| `working`     | `busy`        | `'working'`     | -       |
| `releasing`   | `busy`        | `'releasing'`   | -       |
| `review-gate` | `busy`        | `'review-gate'` | -       |
| `ci-watch`    | `held`        | `'ci-watch'`    | -       |
| `custom`      | `manual`      | `null`          | -       |
| `disabled`    | `disabled`    | `null`          | -       |

### Dispatch logic simplification

| Check      | Before                                                             | After                                      |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------ |
| Free slot  | `mode=dispatch && lifecycle in (ready,released) && agent!=working` | `lifecycle=ready && agent!=working`        |
| Affinity   | `lifecycle in (ci-watch, ...)`                                     | `lifecycle=held`                           |
| Active run | `lifecycle in (working, preparing, dispatching, releasing)`        | `lifecycle=busy`                           |
| Protected  | 6-value set                                                        | `Set(['busy','held','manual','disabled'])` |

## Consequences

- Dispatch logic drops from 3-field checks to 1-field checks
- `SlotMode` removed — one less axis of confusion
- Phase provides same UI detail without polluting dispatch logic
- Pool JSON `mode` field unchanged — no migration of gitignored configs
- `lib/farm-status-display.py` needs a one-time update for new lifecycle values
