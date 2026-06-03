# Farmslot — Automation, Intelligence, and Orchestration Canonical PRD

This canonical chunk PRD defines Farmslot's automation, intelligence, and orchestration layer under [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It captures the product contract for persistent run handling, monitoring, automation, and LLM-assisted improvement loops.

## Scope

This chunk owns the logic that turns the core platform into a persistent supervised automation system:

- gateway-mediated run creation and workflow state management
- persistent monitoring, decision queues, and auto-recovery behaviors
- queueing, webhook-triggered work, notifications, and completion pipelines
- scoring, task writing, self-review, co-pilot, and related LLM-assisted flows
- self-improvement and observability loops that feed future system changes

## User Outcome

An operator should get less manual toil and better evidence-backed supervision because runs can be graded, queued, monitored, nudged, reviewed, and improved through persistent product workflows instead of fragile session-only behavior.

## Canonical Current State

- The automation layer is already part of the shipped product through queueing, webhooks, notifications, and persistent daemon behavior.
- The intelligence layer is already active through multi-provider LLM support, self-review, task writing, and co-pilot features.
- The self-improvement and run-family observability surfaces are active architectural concerns reflected in recent ADRs.
- The bugfix local-first publication gate is shipped, giving automation a human-approved publication boundary with review-depth provenance before public PR mutation.
- The active next automation slice is eval-package template regression: derive a reference package from a merged PR/prior run/package/git ref, produce candidate packages from artifact-only comparison-lane runs, persist `EvalExperimentManifest` + `ResultPackageManifest`, and compare package diffs, visuals, validation evidence, review signals, timing, and cost so prompt/template/harness changes can be evaluated without creating a new merge-intended PR. This extends the existing run-family/lane/run model rather than introducing a competing line or replay taxonomy.

## Requirements

### 1. Persistent run ownership

Dispatch flows must be represented as persistent runs with recoverable state rather than ephemeral session-only chains.

### 2. Monitoring and decisions survive restarts

Monitoring, nudges, pending decisions, and recovery hints should survive normal workflow interruptions and remain visible to operators.

### 3. Automation remains supervised

Queueing, auto-recycle, self-review, and improvement proposals should reduce toil while keeping human approval and evidence review in the loop.

### 4. Intelligence uses shared product evidence

Scoring, grading, summaries, co-pilot, and self-improvement flows must rely on the same task/run/artifact evidence model rather than ad hoc per-feature data silos.

### 4.1. Logging is typed evidence

Gateway intelligence should answer from structured run state and step artifacts first. Logs are still a useful tool for the main gateway intelligence, especially for self-diagnosis of gateway/runtime failures, parser drift, prepare-script failures, and artifact gaps. When logs are needed, Co-Pilot and read-only investigation workers must consume them through scoped, bounded, redacted registry entries rather than ad hoc filesystem reads.

### 5. Cross-surface consistency

Desktop, mobile, CLI, and future surfaces should observe the same run and decision model.

## Boundaries

This chunk does **not** own:

- the shared slot lifecycle primitives themselves (Core Farmslot)
- the desktop UI contract (Command Center)
- the native mobile UI contract (Mobile Companion)
- the runner-neutral execution contract, except where automation consumes it

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [ROADMAP-next.md](ROADMAP-next.md)
- [reference/](reference/)
- ADR-013, ADR-014, ADR-016, ADR-017, ADR-021, ADR-024, ADR-025, ADR-026, ADR-027, ADR-029
- The bugfix local-first publication gate PRD/test spec and PR #73 for the shipped publication boundary
- The eval-package template-regression roadmap for the active artifact-only eval-package slice

## Success Condition for This Chunk

Farmslot can orchestrate, observe, review, and improve autonomous work through persistent supervised workflows that remain explainable and recoverable across sessions and surfaces.
