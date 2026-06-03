# Farmslot — Core Platform Canonical PRD

This canonical chunk PRD defines the Core Farmslot platform under [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It covers the shared framework and slot lifecycle that every other product chunk depends on.

## Scope

Core Farmslot owns the reusable execution substrate:

- pool and slot modeling
- project configuration and hook expansion
- slot lifecycle operations such as prepare, dispatch handoff, release, and recycle
- task/artifact/runtime directory conventions
- the shared CLI/gateway substrate that executes those lifecycle actions
- project-agnostic scoring and ingestion plumbing where it supports base dispatch workflows

## User Outcome

An operator should be able to define machines and slots once, apply project-specific hooks safely, and run repeatable agent work without rebuilding the framework for each project.

## Canonical Current State

- The project-agnostic framework foundation is shipped.
- GitHub issue support and standalone pre-dispatch scoring are shipped extensions of the core framework.
- The slot lifecycle model and shared gateway/CLI execution substrate are already active product infrastructure.

## Requirements

### 1. Shared framework, not project-specific glue

Core lifecycle code must stay project-agnostic. Project-specific setup, fixtures, and health logic belong in project configs and hooks.

### 2. Stable slot lifecycle

The product must preserve a predictable slot lifecycle with clear transitions for readiness, working, release, recycle, and recovery operations.

### 3. Config-driven preparation

Pool data, project config, fixtures, and hooks must drive environment preparation rather than hardcoded per-project workflow logic.

### 4. Consistent task and artifact layout

Farmslot runs need stable runtime, task, and artifact conventions so automation, review, and history tooling can locate evidence reliably.

### 5. Backend execution substrate

The shared CLI/gateway substrate must remain the authoritative execution path for lifecycle operations consumed by higher-level control surfaces.

## Boundaries

Core Farmslot does **not** define:

- the desktop control-surface UX (Command Center chunk)
- mobile oversight UX (Mobile Companion chunk)
- higher-level automation, self-review, or co-pilot behavior beyond the shared infrastructure it builds on
- the runner-neutral TUI execution contract beyond providing the base slot/runtime environment it needs

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [reference/](reference/)
- [ADR index](adr/README.md)
- ADR-001, ADR-005, ADR-007, ADR-022, ADR-027

## Success Condition for This Chunk

Farmslot operators can stand up, prepare, dispatch, and recover work on slots through a shared platform model without coupling the framework to any single project or control surface.
