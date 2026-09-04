# ADR-054: Run resource posture at lifecycle boundaries

**Status:** Proposed
**Date:** 2026-09-04
**Relates to:** [ADR-013](013-gateway-mediated-orchestration.md), [ADR-015](015-resource-streams.md), [ADR-022](022-slot-lifecycle-simplification.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-037](037-prepare-profiles.md), [ADR-038](038-gate-held-worker-session.md), [ADR-053](053-run-lifecycle-transition-routing.md)

## Goal

A run should hold only the processes it needs for what it is doing right now, and an operator
should be able to see and change that without shell commands. Concretely:

| #   | Operator want                                                            | What it needs                                                                               |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | Metro, Webpack, Chrome, simulators stop when a run ends                  | Run-owned processes released at terminal, in dependency order                               |
| 2   | A run at a human step stops hogging resources so other work can proceed  | Shed unneeded processes at durable waits; optionally free the slot itself and restore later |
| 3   | Re-run validation on another device, simulator, or platform              | Re-target the validation step to a different device identity                                |
| 4   | Several runs share one scarce device: wait, get notified, claim, release | Fleet-scoped exclusive claim with a wait queue and an availability signal                   |

This ADR decides item 1, item 2 shedding, and the policy/status contract the other items build on.
Items 2 (slot freeing), 3, and 4 are captured as separate backlog items (see **Captured
separately**) so this decision stays small enough to ship.

## Context

Runtime capability leases already exist (`packages/protocol/src/contracts/runtime-capabilities.ts`,
`services/gateway/src/runtime-capabilities/`). They give exclusive/shared policy, dependencies,
`keepWarmMs`, health, cleanup-failure tracking, restart recovery, and a Command Center panel. The
worker acquires capabilities from its proof plan; the Gateway releases them at slot teardown.

Machine pause/restore also exists (`services/gateway/src/machine-parking/service.ts`,
`MachineParkRecord`): an operator can pause runs on a machine, stop the worker plus its observed
resources, and later restore the runner session and re-drive the step. Eligibility is limited to
`monitoring` and `ci-watching`.

What is missing is lifecycle policy between those two ends. A run can wait at a human gate, wait
for CI, or finish validation while Metro, Webpack, Chrome, and a simulator stay live. Nothing
answers three operator questions:

1. Which resources should be live at this point in the run?
2. Which are actually live, warm, stopped, or unhealthy?
3. What will be restarted before validation resumes?

Lease state alone cannot answer the second. A lease in state `released` may still have a live
provider until `keepWarmUntil`, and Command Center renders it as simply released. A fixed
provider deadline cannot express different policy for an operator wait versus final cleanup.

Lifecycle boundaries differ across flows: local-first publication flows keep the worker alive
through the gate and CI watch under ADR-038; some interactive `dev` runs wait inside `MONITOR`;
others reach a later `HUMAN_GATE`. Keying cleanup to a step name would behave inconsistently.

## Decision

### Gateway-owned resource posture

The Gateway owns a run resource posture describing intent at semantic lifecycle boundaries:

| Posture         | Intent                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `active`        | Keep only capabilities required by the current proof plan acquired and healthy.                   |
| `operator-wait` | Apply the effective retention policy while the run waits for an operator or CI.                   |
| `parked`        | Delegate to machine parking for this one run: stop worker and manifest resources, keep workspace. |
| `terminal`      | Release every run- or family-owned runtime capability in dependency order.                        |

Flows map their concrete steps to these postures in the run engine. Clients and project hooks
never infer a posture from raw run status, step names, or slot phases.

`parked` is not a new mechanism. It routes the run into the existing machine-pause release path
with a single-run selector and reports that path's eligibility verdict. Extending eligibility to
gate-held runs is a separate item.

Preparing validation or a recipe rerun is `active` with the validation's proof plan re-applied:
the Gateway reacquires the selected proof requirements and passes provider health checks before
starting the action. It is not a separate posture.

### Desired disposition and observed provider state are separate

For every capability relevant to a run, posture status records:

- desired disposition: `acquired`, `warm`, or `stopped`;
- observed provider state: `running`, `stopped`, `unhealthy`, `transitioning`, or `unknown`;
- the policy source and reason;
- lease, owner, warm deadline, last transition, effects, and cleanup failure when present.

`warm` releases ownership but keeps a healthy provider until an explicit deadline. Status must not
label a provider stopped merely because its lease is released. Reacquiring a warm, healthy provider
reuses it through the existing health contract; an unhealthy warm provider is cleaned up first.

### Operator choices at a human gate

A gate decision carries one of four choices. Choices are operator vocabulary; each resolves to a
posture plus proof plan:

| Choice                | Resolves to                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `keep-for-validation` | `active` with the validation proof plan                            |
| `minimize`            | `operator-wait` with expensive providers released, worker retained |
| `free-slot`           | `parked` (typed rejection when the run is not park-eligible)       |
| `project-default`     | Whatever the lower precedence levels resolve to                    |

The Gateway returns a preview of the exact capabilities to acquire, retain, warm, or stop and
their declared release effects before the operator resolves the gate.

### Policy precedence

The effective policy resolves in this order, and every decision records its winning source:

1. the operator's gate choice for the current wait;
2. the run's dispatch configuration, persisted on the run from backlog dispatch settings
   (`packages/protocol/src/contracts/backlog.ts`), so a batch or overnight dispatch can select
   `minimize` or `free-slot` for every wait without operator input;
3. project posture defaults and per-provider retention settings in `runtime_capabilities`;
4. framework defaults: retain only what keeps the current operator action usable, release
   expensive unneeded providers at durable waits, stop every run-owned provider at terminal.

A client cannot widen an operator choice or invent its own cleanup policy.

### Reconciliation at semantic boundaries

The run engine asks one posture reconciler to preview or apply the effective policy when it enters
a durable operator wait, prepares validation, parks or resumes, reruns a recipe, or performs
terminal cleanup. Reconciliation is idempotent and uses the existing capability registry:
provider actions, dependency ordering, ownership checks, and recovery store. A client never
restarts Metro, Webpack, Chrome, or a simulator with its own shell command.

Terminal publication stays responsive under ADR-053. Slow cleanup runs as an explicit transition
effect after publication. Failures stay attached to posture status and capability lifecycle
events; the Gateway never reports a provider stopped when cleanup failed.

### Client responsibilities

All clients consume the same posture status, preview, apply, and lifecycle events and render the
Gateway's policy source, reasons, progress, and failures. None duplicates policy resolution.

- Command Center: Run Detail shows posture and last transition; gate decisions show the four
  choices with the effect preview; Slot View keeps capability diagnostics with explicit acquire,
  restart, and release actions.
- Companion: the same gate choices and a compact run-level summary. No capability administration.
- CLI: posture inspect, preview, apply, and single-capability recovery with machine-readable output.

### Runner sessions remain runner capabilities

Runner session retention, handoff, and resume stay in the shared runner capability layer. Posture
status may report whether the worker is live or resumable, but runtime providers never implement
runner-specific resume commands.

ADR-038 stays in force for `keep-for-validation`, `minimize`, and `project-default`: the gate-held
worker is never killed by those choices. `free-slot` is the one path that stops a gate-held worker,
and only under the machine-pause rule that a validated runner session reload exists.

## Captured separately

These are real operator wants that this ADR deliberately does not decide. Each has its own backlog
item and depends on this one.

- **Free the slot at an operator wait.** Extend machine-pause release eligibility to gate-held runs,
  mark the slot free, restore or re-dispatch on gate resolution. Amends ADR-038.
  `.backlog/specs/farmslot-farm/2026-09-04-free-slot-at-operator-wait.md`
- **Re-target validation to another device or platform.** Device-identity parameters on device
  capability providers; a rerun accepts a target override and reacquires.
  `.backlog/specs/farmslot-farm/2026-09-04-validation-device-retarget.md`
- **Fleet-scoped device claims with a wait queue.** Today leases are slot-scoped and exclusive
  conflicts fail fast. Add claim scope, queue on conflict, drain on release, signal availability.
  `.backlog/specs/farmslot-farm/2026-09-04-fleet-scoped-device-claims.md`

## Consequences

- Durable waits can shed Metro, Webpack, browsers, and simulators without losing the workspace or
  silently breaking the next validation.
- Command Center, Companion, and CLI explain the same desired and observed state.
- Project configuration gains a lifecycle policy next to provider mechanics; `keep_warm_ms` alone
  stays valid.
- Backlog dispatch settings gain a wait policy field that batch dispatches can set.
- The run engine gains reconciler calls at several boundaries that must compose with gate-held
  workers, CI watch, cancellation, slot release, machine parking, and restart recovery.

## Rejected alternatives

- **Cleanup hooks on human gate and completion.** Step order differs per flow, and hook names
  cannot express ownership, dependencies, warm reuse, or client-visible outcomes.
- **Each client decides what to stop.** Clients would diverge and could bypass lease ownership.
- **Released lease means stopped process.** Keep-warm deliberately leaves the provider running.
- **A separate `parked` mechanism.** Machine parking already persists a park record, stops manifest
  resources, and restores the runner session. Duplicating it would fork recovery logic.
- **A separate `validation-ready` posture.** It is `active` with a different proof plan; a new state
  adds surface without behavior.
- **Runner sessions as runtime providers.** Relaunch and retained-session delivery have their own
  capability and safety contract.

## Non-goals

- Changing backlog, work-graph, run, or slot lifecycle state machines
- Replacing machine-wide resource-pressure cleanup or machine pause
- Project-specific process names or kill commands in Gateway workflow code
- Making Companion a capability administration console
- Freeing slots, device re-targeting, or cross-run device queueing (captured separately above)

## Implementation contract

Backlog item `MANUAL-000111` owns the implementation contract in
`.backlog/specs/farmslot-farm/2026-09-03-run-resource-posture.md`.
