# ADR-045: Worker Terminal Contract (project.json)

**Status:** Accepted  
**Date:** 2026-07-01

## Context

Worker completion depends on three loosely coupled mechanisms today:

1. **Template prose** — checklist steps telling the agent to run `./mark` and write artifacts
2. **`mark-checklist-step.cjs`** — hardcoded per-flow report paths and always-on learnings
3. **Run monitor** — waits for `SIGNAL.json` on interactive pr-complete handoff only; autonomous flows can finish with no terminal signal

A new worker template that omits terminal `./mark` instructions still dispatches. The run may complete without disposition, terminal evidence, or learnings — silent degradation.

Projects need a **declarative, project-owned contract** for required terminal outputs, validated at template-author time and enforced at `./mark` and monitor time.

**User-facing source of truth:** [Finish a worker run](../../apps/docs/docs/reference/worker-run-finish.md) — a one-page checklist (artifacts + `./mark`) that applies **inside Farmslot and in standalone agentic skills** (consensys-skills / `@farmslot/skills`). The machinery below is for Farmslot farms that want overrides; most teams copy the template snippet from that page and do not touch `worker_terminal`.

## Decision

### Single source of truth: `project.json` → `worker_terminal`

Each project declares defaults and per-flow overrides:

- **`requireSignal`** — worker must write terminal `SIGNAL.json` via `./mark` (never hand-written)
- **Per terminal command** (`complete`, `no-change`, `blocked`) — required artifact paths and optional `report` path for `evidence.reportPath`
- **`whenPresent`** — conditional requirements (e.g. when `artifacts/recipe.json` exists)

Framework ships **built-in defaults** for canonical flows (`dev`, `fix-bug`, `review-pr`, `pr-complete`, `merge-main`) when a project omits `worker_terminal`.

### Frozen run contract

At task write, the gateway resolves the contract for `run.flowType` + `run.mode` and writes:

```text
inputs/worker-terminal-contract.json
```

`./mark`, `check-task-artifact-contract.mjs`, and the run monitor read this file for the run. Template provenance already captures which template rendered the task; the terminal contract captures what must exist before the run can close.

### Three enforcement layers

| Layer           | Mechanism                            | When                                                                                                  |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Author          | `check-worker-template-contract.mjs` | CI / quality — terminal templates must mention `./mark` and required artifact paths                   |
| Worker terminal | `./mark` + artifact contract script  | Runtime — paths must exist (non-empty where applicable)                                               |
| Monitor         | `shouldHoldForMissingTerminalSignal` | Runtime — when `requireSignal` and agent exits without terminal signal, hold for operator (all flows) |

Interactive `pr-complete` handoff sets `requireSignal: false` (operator writes signal after manual work).

### Non-goals (this ADR)

- Validating learnings bullet count or prose quality (template guidance only)
- Replacing `evidence-manifest.json` / recipe protocol contracts
- Secondary worker roles (`self-review`, `ci-fix`) — primary flow contract only in v1; extend per-role contracts later

## Consequences

- New flows add a `worker_terminal.flows` entry instead of patching framework hardcodes
- Template drift is caught in CI before dispatch
- Autonomous runs fail closed when workers exit without signaling
- Pack projects (`metamask-farm`) inherit the same lint when they include `worker_terminal`

## Related

- [worker-signal-protocol.md](../../apps/docs/docs/reference/worker-signal-protocol.md)
- [ADR-038](038-gate-held-worker-session.md) — gate-held session after worker signals complete
- [ADR-026](026-self-improvement-recursive-loop.md) — learnings / retrospective consumers
