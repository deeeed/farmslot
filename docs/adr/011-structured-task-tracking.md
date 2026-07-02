# ADR-011: Structured Task Tracking

**Status:** Accepted (revised 2026-03-28)
**Date:** 2026-03-27 (revised 2026-03-28)
**Relates to:** [ADR-001](001-gateway-architecture.md), [ADR-005](005-state-persistence.md), [PRD](../PRD-command-center-canonical.md) — Feature C4, [Roadmap](../ROADMAP.md) — M8

## Context

Workers track progress by marking `- [ ]` to `- [x]` checkboxes in TASK.md. The monitor polls every 5 min, counts checkboxes via regex. The UI shows an aggregate % bar but can't show which phase, which step, or how long.

Problems:

- **Opaque progress** — "15/31" doesn't tell you "Validate phase, running lint:tsc"
- **Fragile parsing** — regex on markdown is brittle if the model formats differently
- **No cross-project structure** — only Example App has templates, no shared abstraction
- **Not generalizable** — adding a new project means copy-pasting prose

Desired outcome: rich per-step, per-phase progress in the UI for any project, while keeping templates easy to author in markdown.

## Decisions

### A. What is the source of truth for task structure?

**Chosen: TASK.md IS the schema — parsed directly at read time.**

> **Revision (2026-03-28):** Originally generated a `task-schema.json` sidecar file at dispatch time. QA found this caused file-sync bugs (schema not copied to slot, wrong paths). Since the TASK.md template format is documented and consistent (`###` headers = phases, `- [ ]` = steps), the gateway now parses structure directly from TASK.md content using `generateTaskSchema()`. No sidecar file, no sync, no copy step.

The markdown template IS the schema. `generateTaskSchema(markdown, flowType)` extracts phases and steps on-the-fly. The same function that was used to generate the file now runs at read time instead.

**Not chosen: JSON definitions as source of truth** — adds a parallel artifact that must be kept in sync with the markdown.

**Not chosen: Sidecar `task-schema.json` file** — originally implemented, then removed. Caused sync bugs: file not copied to slot during dispatch, wrong paths in task.progress method, task-watcher path confusion. The markdown already contains all the structure — parsing it is cheap (~1ms).

### B. How does the gateway track structured progress?

**Chosen: Gateway parses TASK.md directly into structured progress.**

The gateway reads TASK.md via `task.progress`, calls `generateTaskSchema()` to extract phases/steps, then `joinSchemaWithMarkdown()` to map checkbox states to step statuses. Single file, single parse, zero sync issues.

**Not chosen: Worker writes progress.json sidecar** — requires worker template changes, adds another file to watch, risks stale data if the worker crashes.

**Not chosen: Worker emits progress events** — workers are LLM agents with no event infrastructure. They mark checkboxes in a file — that's the contract.

### C. Template format conventions

The gateway parser relies on these conventions (documented in `docs/reference/template-variables.md`, § TASK format):

- `###` headings define phases (any heading level works)
- `- [ ]` / `- [x]` checkboxes define steps
- Checkboxes before any heading go into a "Checklist" phase
- `<details>` blocks are skipped (reference sections)
- Headings with no checkboxes below them are pruned

No validation file needed — the parser handles format variations gracefully. Missing structure just means no structured progress (flat checkbox count fallback).

### D. How does the UI render structured progress?

**Chosen: Phase accordion with per-step status.**

Fleet slot cards show a phase label (e.g., "Validate 5/7"). Slot view sidebar replaces the flat progress bar with a collapsible phase accordion — each phase shows its steps with done/pending/active icons.

The gateway computes `TaskProgressStructured` (phases, steps, current step) and includes `taskPhase` + `taskStepProgress` in `SlotStatus` for fleet-level display without extra RPC.

### E. How does the gateway detect TASK.md changes?

**Chosen: chokidar watch on TASK.md for active slots.**

The gateway already uses chokidar for `.farm-status.json`. Add a watch on each working slot's TASK.md. On change, re-parse, broadcast `task.progress.updated` event. Remove watch when slot leaves `working` state.

## Protocol Types

```typescript
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped';

export interface TaskSchemaStep {
  index: number;
  name: string;
  artifacts?: string[];
}

export interface TaskSchemaPhase {
  name: string;
  steps: TaskSchemaStep[];
}

export interface TaskSchema {
  flowType: string;
  title: string;
  totalSteps: number;
  phases: TaskSchemaPhase[];
}

export interface TaskProgressStructured {
  schema: TaskSchema;
  phases: TaskPhaseProgress[];
  completedSteps: number;
  totalSteps: number;
  currentPhase: string | null;
  currentStep: string | null;
}
```

## Consequences

**Positive:**

- Rich per-phase, per-step progress in the UI — "Validate 5/7, running lint:tsc" instead of "15/31"
- Zero worker changes — workers still mark checkboxes as today
- Zero template author friction — still editing markdown, no JSON to maintain
- No file sync bugs — TASK.md is the single source of truth, parsed on-the-fly
- Cross-project — any template with ### headers and checkboxes gets structured tracking

**Negative:**

- Parsing cost on every read (~1ms, negligible)
- No pre-computed structure — must parse at read time (but removes a whole class of sync bugs)

**Risks:**

- Template format drift across projects — mitigated by light conventions documented in template authoring guide

## References

- PRD Feature C4: TASK.md Progress Tracker
- Roadmap M8: Structured Task Tracking
