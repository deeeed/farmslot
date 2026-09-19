# ADR-060: Sub-task observability through child checklist units

**Status:** Proposed
**Date:** 2026-09-19
**Owner:** Farmslot maintainers
**Scope:** [Task directory contract](../reference/task-directory-contract.md), [ROADMAP-next](../ROADMAP-next.md) captured lane "Worker phase decomposition and sub-agent cost roll-up"
**Related:** [ADR-032](032-runner-observability-via-hooks.md), [ADR-045](045-worker-terminal-contract.md), [ADR-049](049-agent-execution-template-selection.md), [ADR-058](058-static-review-and-farm-owned-qa.md)
**Implementation spec:** [plans/sub-task-observability-v1.md](../plans/sub-task-observability-v1.md)

## Context

A run is observed through one checklist and one signal: `CHECKLIST.md` and `SIGNAL.json`, written only by `mark`. Role switches (self-review, self-review-fix, ci-fix) pair an additional checklist with its own signal, but that pairing is gateway-driven and the role set is closed. Inside a checklist, one step is one box.

Some steps are not one unit of work. A dev checklist step says "self-review the diff against the team review skill"; a static review template has two boxes and hides the whole review inside the first. The skill invoked by such a step is itself a checklist (sections and `- [ ]` rows) with its own provenance, yet nothing observes it: the parent box stays open for the whole duration, Command Center shows no progress, the harness `status --watch` shows nothing, and no per-step timing survives for the family retrospective.

The same gap exists whenever a worker delegates to a sub-agent. The parent runner may spawn it with a native tool, the harness may run a script, or the same session may execute the skill inline. Runner-native hooks do not cover this portably: Claude emits `SubagentStop`, Codex and Grok emit nothing equivalent (ADR-032 matrix).

Nesting boxes inside the parent checklist is not an option. `mark N` targets a position; the gateway parser, the CJS mirror in `@farmslot/agent-runtime`, and the harness all enumerate the same flat list, and the numbering guard exists because an inserted row silently shifts every later step.

## Decision

### A child unit is a separate checklist with its own signal

A parent step may own one child unit. A child unit is a checklist file and a signal file under `subtasks/` in the task directory, with the same shape as the parent pair. The child signal is a `WorkerSignal` with `role: subtask` and one added top-level field, `parent`, holding the parent checklist basename and the parent step number. `mark` is the only writer of child signals, as it is for the parent signal.

Child units are not role switches. They do not write `checklist-target.json`, do not change the run's active task file, and are not driven by the gateway role-switch mechanism. A child has no terminal contract of its own; the parent's contract still governs the parent's completion.

The child checklist is materialized from a source: a skill body, a catalog template, or inline text. Materialization records the source id and digest the way `executionTemplate` records the parent checklist. A skill whose body is already checklist-shaped needs no change to become a child unit.

The parent checklist stays flat. A child unit is referenced from a parent step by the `mark` registration, never by indentation or numbering inside the parent file. Numbering guards keep applying to each file on its own.

### Farmslot observes; it never spawns

Registering a child unit writes files. It does not launch a process, a tmux window, or a runner session. The parent runner, the harness, or the operator decides how the child work is executed: inline in the same session, through the runner's native sub-agent tool, or through a harness script. Whoever executes it receives the child paths in its brief and reports through `mark`.

Liveness of a child is derived from its signal and mark timestamps only. A child with no recent mark event is `stale`, never `dead`. Runner-native sub-agent hooks may attach identity to a child signal when the runner provides it; the contract is complete without them. Rendered TUI text is never evidence of child progress (ADR-032).

### The parent step is owned by its child while the child runs

When a child unit is registered on a parent step, `mark <step>` on that step is refused with a pointer to the child until the child is settled (`complete`, or its alias `done`, per the protocol helper); a `blocked` child keeps ownership of the step. A child `complete` ticks the parent box; a later `mark <step>` on the same step is an idempotent no-op. A child `blocked` propagates to the parent signal as `blocked` with the child reason, so the run blocks the way a parent `blocked` does today; resuming the child restores `running` on both. This keeps one writer per box and removes the ambiguity of a worker marking a step whose work is running elsewhere.

### Progress projection is recursive

`TaskStepProgress` gains an optional child projection with the same shape as the parent (`phases`, `completedSteps`, `totalSteps`, `currentStep`) plus the child status and source provenance. The gateway watcher observes the child index and child signals beside the parent files. Clients render the child under its parent step. The first release allows one level of nesting; the schema is recursive so deeper units need no new contract.

Child mark events carry per-step timing the way parent events do. Per-unit durations feed the existing per-phase breakdown. Token and model attribution per sub-agent remains in the per-model capture lane and is not part of this decision.

### Acceptance criteria become a ledger, not steps

Acceptance criteria stay out of the checklist (a box in `TASK.md` is never a step). Task init emits them with stable ids; the worker records a verdict per criterion (`proven`, `weak`, `missing`, `untestable`) with evidence paths and recipe nodes in a JSON ledger under `artifacts/`, through one agent-runtime command. The terminal contract requires a verdict for every criterion. The markdown coverage table becomes a rendering of the ledger. This is the second primitive of the spec and may ship after child units.

## Consequences

- Skill authors keep writing checklist-shaped skills; the farm invokes them as child units without copying their content into farm templates.
- Farm templates shrink: a step that runs a skill becomes one registration line plus the child's own rows.
- Command Center, Companion, and the harness show the same nested progress from one projection.
- Dispatch copy, worker mirror, and artifact-copy policy gain one directory (`subtasks/`).
- The task-directory contract layers table gains rows for the child unit files and the AC ledger when they ship.
- Spawning mechanics stay out of Farmslot. A runner adapter that later exposes a structured sub-agent identity may enrich the child signal; nothing in this decision depends on it.

## Non-goals

- Spawning or supervising sub-agent processes, windows, or sessions.
- Nested boxes inside one checklist file.
- Cross-run children (a child unit lives inside its parent task directory).
- Token or cost attribution per child (per-model capture lane).
- Replacing the gateway-driven role switch for self-review, self-review-fix, and ci-fix.
