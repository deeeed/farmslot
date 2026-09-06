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
MONITOR → SELF_REVIEW → COMPLETE (gate-held) → HUMAN_GATE (worker live)
  → FINALIZE (keep worker warm) → CI_WATCH (warm session)
  → [optional chained pr-complete / update-branch via warmSessionReuse]
  → family/slot terminal teardown (slotRelease / failed teardown / cancel)
```

1. **COMPLETE** — prepare local package; call `holdSlotForPublicationGate` (`busy` / `review-gate` / `agent: working`); emit `slotDisposition: 'gate-held'`. Do **not** call `slotRelease`.
2. **HUMAN_GATE** — keep `agent: working`; operator may attach via Companion/tmux.
   - Before presenting publication approval, materialize
     `publication_review.<flow>.minimum_independent_reviews` into reviewer work when no explicit
     dispatch plan exists. These automatic passes use `static-code`; `full-live` is opt-in through
     an explicit review plan/operator request.
   - Pipeline self-review is worker feedback and never counts as an independent review. A separate
     reviewer context using the same runner may count; runner diversity is required only when
     `require_cross_runner` is configured.
3. **FINALIZE** — capture session metrics while worker is alive; **do not** call `killSlotAgents`. Transition slot to `held` / `ci-watch` so CI follow-ups can reuse the warm session (MANUAL-000065).
4. **CI_WATCH handoff** — chained `pr-complete` / `update-branch` set `engineState.flags.warmSessionReuse` (+ `skipPrepare`). DISPATCH probes process liveness and hands the new TASK.md into the warm worker when alive; falls back to fresh `dispatchExecute` when the session is dead, the runner/model swapped, or the runner is not tmux-nudgeable (composes with MANUAL-000043 dead-session fallback and MANUAL-000045 ownership claims).
5. **Terminal cleanup** — tear down live agents when the **family/run** ends, not merely because FINALIZE completed:
   - **Successful CI end / no chain** — `slotRelease` (kills agents unless `preserveAgents`).
   - **Engine blocked/failed after FINALIZE** — `teardownGateHeldAgentsIfNeeded` only when status is `failed`/`blocked`/`cancelled` **and** gate-held FINALIZE is done, then `resetSlot`.
   - **Pre-FINALIZE gate failure** — `shouldTeardownGateHeldAgents` stays false so the operator can still attach; cancel still kills.
   - **Operator cancel** (`run.cancel` / `methods/run/lifecycle-control`) — `killAllAgentWindows` + `killAgentInSession` (same primitives as `killSlotAgents`, plus explicit runner for legacy base-pane cleanup), then `resetSlot`. Does **not** call `teardownGateHeldAgentsIfNeeded`; cancel is user-initiated from any non-terminal status (including `human-gating` / `blocked` review-gate) and always runs the full slot-level agent kill so the slot frees immediately after the terminal run record is published.

### Fleet refresh

`fleet.refresh` maps slots with active gate-held runs to `busy` / `review-gate` / `agent: working` when `blocksGateHeldSlotRelease` is true (open publication gate via `isGateHeldPublicationRun`, or post-approval until **FINALIZE** completes), not `held` / `pr-watch` / `idle`.

### Slot release guard

`slot.release` rejects release when `blocksGateHeldSlotRelease` is true for an active run on the slot (open publication gate, or post-approval until FINALIZE completes), unless `forceReset` / `preserveAgents`, because detach + agent kill breaks finalize/publish.

### API surface

- `holdSlotForPublicationGate(slotId)` — marks slot for gate wait with live worker.
- `killSlotAgents(slotId)` — role-window teardown without full slot release (used by terminal failure / cancel / slotRelease — **not** FINALIZE).
- `shouldKeepWorkerWarmThroughCiWatch(run)` / `shouldTeardownGateHeldAgents(run)` — pure policy helpers for warm-through-ci vs terminal-failure teardown.
- `warmSessionHandoffDispatch` — CI-chain handoff into a still-alive worker; `engineState.flags.warmSessionReuse`.
- `SlotReleaseParams.preserveAgents` — skip agent kill inside `slotRelease` for partial-release call sites (not used on the gate-held hot path).
- `CompleteStepOutput.slotDisposition: 'gate-held'` — protocol marker.

### Templates

Project worker templates (`dev.md`, `fix-bug.md`) should instruct: write `SIGNAL.json`, **do not `/exit`**, stay idle until publication gate resolves.

## Amendment: `free-slot` at the publication gate (2026-09-05)

[ADR-054](054-run-resource-posture.md) defines a `free-slot` gate choice. The gate-held worker
guarantee above holds **unless** the operator's gate choice or the run's dispatch `waitPolicy`
selected `free-slot`, and then only when the run's runner declares both a graceful exit and a
persisted session reload in the runner capability registry. A runner that declares neither is
refused with the typed `RUNNER_RELOAD_UNSUPPORTED`, and nothing is stopped — the worker stays live
under the rule above.

When the choice applies:

- Machine-pause release accepts the gate-held run as a third parkable shape beside `monitor` and
  `ci-watch`, stops the worker and the resources in its captured manifest, and releases slot
  ownership so dispatch can select the slot for other work.
- The run keeps its `slotId` and its park record; the record, not the slot row, is the authority
  for the parked run's slot binding. The pending gate decision stays published and answerable, so
  the run stays at `human-gating`/`blocked` rather than moving to `paused`.
- `slot.release` and slot reset refuse to destroy that park record without `forceReset`, while a
  run that claims the freed slot afterwards is released normally.
- An orchestration-only park of a gate-held run is refused: it would move the run off its gate
  without freeing anything.

**Workspace contract.** The freed slot's working tree goes to the next occupant, whose prepare
resets the checked-out branch to its base ref. That would move the parked run's branch and discard
its commits, so the park takes the branch out of the tree first:

- The park refuses, with `WORKSPACE_NOT_PRESERVABLE`, when the tree has uncommitted changes or its
  git identity cannot be read. Committed work is preserved; uncommitted work is never silently
  stashed, discarded, or committed on the run's behalf.
- Otherwise the park records the branch and its tip on the park record and detaches HEAD at that
  exact commit before releasing slot ownership. The branch ref survives untouched; the next
  occupant's reset moves only a detached HEAD. Restore checks the branch back out at that tip.
- A detach that fails, or a tree that moved between the preview and the detach, leaves the park
  `partial` and does NOT release the slot. Fail closed: a slot dispatch could claim while the
  parked branch is still checked out is the loss this contract exists to prevent.

**Fences while a park is in flight.** From the moment the write-ahead record declares a freeing
park until it is restored or cancelled, `run.resolveDecision` refuses to resolve the run's
decisions and `runtime.posture.apply` refuses every posture but `parked`. Answering the gate
mid-park would publish against a worker being stopped underneath it, and `keep-for-validation`
would reacquire capabilities on a slot another run may already own. The engine's own gate path
blocks rather than fails, because a terminal run cannot be cancelled and its park record would be
stranded. A successor's `slot.release` never detaches the parked run's binding, automated recycle
sweeps skip the freed slot, and restart recovery treats the parked run like a paused one: no agent
runtime reconcile, no gate replay, no publication-review re-arm on a slot it no longer owns. Its
pending decision is still re-broadcast so clients show the run waiting.

**Restore: the original slot, and nothing else (2026-09-06).** A freed park is restored into the
slot it was freed from, and only that slot. Answering the pending gate is itself a restore trigger:
`run.resolveDecision` restores first and consumes the decision only if that succeeded, so an
operator never has to know the run was parked. `machine.pause.restore` drives the same path.

- The slot must be free — no owner, not mid-release, no foreign warm-handoff reservation, and
  `ready`. Otherwise the restore is refused with `RESTORE_SLOT_TAKEN`, the record stays `parked`,
  the decision stays pending and answerable later, and nothing is touched. Cross-slot re-dispatch is
  a separate decision and is deliberately not attempted here.
- The restore claims the slot before anything else, journals that claim as a `restore-slot` intent,
  and finishes it on restart. Acting on a slot the run does not own would reach into whatever
  dispatch handed it to.
- The preserved branch goes back at its recorded tip. Refused with `RESTORE_WORKSPACE_UNAVAILABLE`
  when the successor left uncommitted work in the tree or the branch no longer sits at that tip:
  a checkout would carry someone else's changes onto the parked branch, or bring back commits that
  are not the ones under review.
- The worker comes back through the persisted runner session, proven or not at all
  (`RESTORE_RUNNER_RELOAD_FAILED`). Two shapes count, and they are recorded distinctly: a relaunch
  the runner ACKNOWLEDGED, and a worker already running this run's persisted session that the
  restore ADOPTED, proven by the live-binding check on a pane the slot row says is this run's.
  Both satisfy gate consumption — the question is whether the worker is back on its session, not
  who relaunched it — and neither may be inferred from the run occupying its slot. **The recorded tmux pane is not part of the
  contract**: freeing the slot hands its tmux session to the next occupant, whose dispatch replaces
  the windows in it, so the pane is routinely gone. The runner capability layer re-hosts the session
  on a fresh pane in that slot's session and writes the new target to both the park record and the
  run's agent context. It refuses rather than respawning over a pane a runner is still alive in.
- The gate itself is either held or replayed, as before: an engine loop still awaiting the operator
  is left alone with its generation unchanged, and one that had exited is replayed with the
  generation advanced. A replay presents a NEW decision, so resolving through it reports
  `RESTORE_GATE_REPLAYED` rather than consuming a decision nothing is waiting on.
- A restored gate does not inherit the `free-slot` choice that parked the run, for exactly one wait
  boundary. Without that, answering the restored gate would hand the slot away again before the
  operator saw any of the outcome.

Operators lose tmux attach for the duration of the park, which is the trade the choice makes: the
runner's persisted session is what brings the context back — on whichever pane the restore gives
it.

## Consequences

- Operators can attach to the worker during publication review on `dev` / `fix-bug`, matching the `review-pr` gate-first UX goal.
- CI follow-ups inherit the same warm context instead of re-learning the branch after FINALIZE teardown.
- Memory cost of warm sessions during long CI waits is accepted for the gate→ci-watch window; a bounded idle timeout is a follow-up if fleet pressure warrants it.
- Stale context after main moves is handled by the follow-up task (update-branch / pr-complete) re-orienting the warm worker; cold resume remains the fallback when the session dies.
- Session-resume on relaunch (ROADMAP-next) remains a fallback when the runner exits despite template guidance or `pane-died` cleanup.
- Gateway restart mid-gate: decisions replay; slot phase must be restored via `blocksGateHeldSlotRelease` on fleet refresh.
- Companion “talk to worker” affordances should key off `agent: working` + `phase: review-gate` during gate-held runs.

## Related

- [ADR-022](022-slot-lifecycle-simplification.md) — `review-gate` phase under `busy` lifecycle
- [ADR-030](030-replay-provenance-and-reference-evals.md) — local-first publication packages
- [ADR-033](033-mobile-tmux-worker-control.md) — Companion tmux attach
- PR #62 — initial implementation
