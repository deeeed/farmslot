# ADR-038: Gate-Held Worker Session at Publication Human Gate

**Status:** Accepted
**Date:** 2026-06-25

## Context

Local-first publication flows (`fix-bug`, autonomous `dev`, reviewed interactive `dev`) prepare a PR package at **COMPLETE** and open a **HUMAN_GATE** for operator approval before public PR mutation. Operators need to attach to the original worker tmux session at the gate to ask why/how questions with full task context.

Before PR #62, local-first **COMPLETE** called `slotRelease`, which killed all agent windows before **HUMAN_GATE** ran. The worker session was gone even when the operator still needed it. `review-pr` already ran **HUMAN_GATE** before **COMPLETE**; `dev` / `fix-bug` did not.

Secondary loss paths remain: dispatch installs `pane-died → kill-pane` on role windows, and workers may `/exit` after writing `SIGNAL.json` unless templates instruct otherwise.

## Decision

### Lifecycle contract (local-first publication)

```
MONITOR → SELF_REVIEW → COMPLETE (gate-held) → HUMAN_GATE (worker live) → FINALIZE (killSlotAgents) → CI_WATCH
```

1. **COMPLETE** — prepare local package; call `holdSlotForPublicationGate` (`busy` / `review-gate` / `agent: working`); emit `slotDisposition: 'gate-held'`. Do **not** call `slotRelease`.
2. **HUMAN_GATE** — keep `agent: working`; operator may attach via Companion/tmux.
3. **FINALIZE** — capture session metrics while worker may still be alive; call `killSlotAgents`; then transition slot to `held` / `ci-watch`.
4. **Terminal cleanup** — blocked/failed/cancel paths after gate-held **COMPLETE** must call `teardownGateHeldAgentsIfNeeded` before `resetSlot`.

### Fleet refresh

`fleet.refresh` maps gate-held runs (`complete.outputs.slotDisposition === 'gate-held'` + unresolved `engine_human_gate`) to `busy` / `review-gate` / `agent: working`, not `held` / `pr-watch` / `idle`.

### Slot release guard

`slot.release` rejects release when a gate-held publication run is active on the slot (unless `forceReset`), because detach + agent kill breaks finalize/publish.

### API surface

- `holdSlotForPublicationGate(slotId)` — marks slot for gate wait with live worker.
- `killSlotAgents(slotId)` — role-window teardown without full slot release.
- `SlotReleaseParams.preserveAgents` — skip agent kill inside `slotRelease` for partial-release call sites (not used on the gate-held hot path).
- `CompleteStepOutput.slotDisposition: 'gate-held'` — protocol marker.

### Templates

Project worker templates (`dev.md`, `fix-bug.md`) should instruct: write `SIGNAL.json`, **do not `/exit`**, stay idle until publication gate resolves.

## Consequences

- Operators can attach to the worker during publication review on `dev` / `fix-bug`, matching the `review-pr` gate-first UX goal.
- Session-resume on relaunch (ROADMAP-next) remains a fallback when the runner exits despite template guidance or `pane-died` cleanup.
- Gateway restart mid-gate: decisions replay; slot phase must be restored via `isGateHeldPublicationRun` on fleet refresh.
- Companion “talk to worker” affordances should key off `agent: working` + `phase: review-gate` during gate-held runs.

## Related

- [ADR-022](022-slot-lifecycle-simplification.md) — `review-gate` phase under `busy` lifecycle
- [ADR-030](030-replay-provenance-and-reference-evals.md) — local-first publication packages
- [ADR-033](033-mobile-tmux-worker-control.md) — Companion tmux attach
- PR #62 — initial implementation
