# ADR-018: Dev Flow & Interactive/Autonomous Modes

**Status**: Accepted
**Date**: 2026-04-02

## Context

The `feature` flow type was misnamed -- the same workflow applies to refactors, investigations, spikes, and any general development task. Additionally, workers needed two operating modes: fully autonomous (fire-and-forget) and interactive (human-in-the-loop at gate steps). Finally, Jira ticket comments -- often containing critical context from product/QA -- were lost during ticket fetch.

## Decision

### 1. Rename `feature` to `dev`

Clean rename in the `FlowType` union type. No backward-compat alias -- this is an internal tool with no external consumers. Run store performs load-time migration of persisted `'feature'` to `'dev'`.

### 2. One template + mode preamble injection

A single `dev.md` worker template serves both modes. At task-write time, a mode-specific preamble is injected after the heading:

- **Interactive**: "Pause at gate steps and wait for human review before proceeding."
- **Autonomous**: "Complete all steps without waiting. Self-review before finishing."

This avoids duplicate templates (`autonomous.md` + `interactive.md`) which would diverge over time.

### 3. `isHumanGateEnabled()` respects `run.mode`

The existing gate mechanism is overridden by `run.mode`:

- `autonomous` -- skips all human gates
- `interactive` -- enables all human gates

### 4. Self-review runs for both modes

Self-review executes regardless of mode. In interactive mode, the engine creates a decision for human review of the self-review results before proceeding to completion.

### 5. Jira comments surfaced as template variable

`fetchJiraComments()` retrieves the last 10 comments in chronological order. They are persisted to `ticket-comments.json` and injected into templates via the `{{JIRA_COMMENTS}}` placeholder.

### 6. Default modes per flow type

- `dev` -- interactive (human oversight for open-ended work)
- `fix-bug` -- autonomous (well-scoped, graded tickets)

Dispatch wizard exposes a toggle to override the default.

### 7. Run store migration

On load, `RunStore` rewrites any persisted `flowType: 'feature'` to `'dev'`. No migration script needed -- happens transparently at read time.

## Alternatives Considered

- **Duplicate templates** (autonomous.md + interactive.md) -- rejected: maintenance burden, divergence risk, identical step sequences.
- **Mode as separate flow types** (`dev-interactive`, `dev-autonomous`) -- rejected: explosion of flow types for identical pipelines.
- **Alias `feature` to `dev`** for backward compat -- rejected: internal tool, no external consumers, clean break preferred.

## Consequences

- All persisted runs with `flowType: 'feature'` auto-migrated on load. No data loss.
- `farm-feature` skill deleted -- gateway UI handles all dispatch.
- Templates renamed: `new-feature.md` to `dev.md` across all projects.
- Dispatch wizard gains Interactive/Autonomous toggle with flow-specific defaults.
- Jira comments now available to workers, reducing context loss on tickets with discussion threads.

## Relates To

- ADR-013 (gateway-mediated orchestration) -- mode extends the run state machine
- ADR-017 (LLM task summaries) -- summary generation works identically for dev flows
