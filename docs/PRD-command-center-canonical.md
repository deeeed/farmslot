# Farmslot — Command Center Canonical PRD

This canonical chunk PRD defines the Command Center within the Farmslot product hierarchy described by [DOCS-GOVERNANCE.md](DOCS-GOVERNANCE.md) and [PRD-product.md](PRD-product.md). It is the authoritative chunk contract for the desktop control surface.

## Scope

The Command Center owns the desktop control surface for supervising and interacting with a running farm:

- fleet overview and slot status visibility
- dispatch support and lifecycle actions exposed through the gateway
- live observability into agents, terminals, progress, artifacts, and device feeds
- slot workspace and PR/review workflows
- operator-facing decision and triage surfaces

## User Outcome

An operator should be able to supervise multiple agents from one persistent visual surface instead of managing the entire fleet through one serial chat or a pile of terminal windows.

## Canonical Current State

- The command-center product layer is already shipped as a major Farmslot capability.
- The platform includes fleet visualization, slot observability, workflow orchestration, PR/CI surfaces, and a slot workspace.
- Supporting shipped history remains in `docs/IMPLEMENTED-HISTORY.md`, `docs/ROADMAP.md`, and the ADRs.
- The approved next command-center slice is the Slot Recipe Quality Cockpit (PRD/test spec dated 2026-04-21), which unifies recipe presentation across `review-workspace`, `family-observability`, and `slot-view` without changing host ownership boundaries.

## Requirements

### 1. Gateway-backed control surface

The Command Center must act as a client of the shared gateway/state model rather than inventing a parallel orchestration path.

### 2. Fleet-first observability

Operators need continuous visibility into slot health, lifecycle state, task progress, decisions, artifacts, and review status across the fleet.

### 3. Structured operator actions

Common actions such as dispatch support, lifecycle control, review triage, and decision handling should be available as structured UI workflows instead of requiring ad hoc shell navigation.

### 4. Workspace depth when needed

The chunk must support drill-down into a slot's working tree, diffs, artifacts, and live terminal context when high-touch intervention is required.

### 5. Runner-model consumer, not owner

The Command Center consumes the shared runner-execution model. It must not redefine runner behavior ad hoc for one UI surface.

## Boundaries

- This document is the canonical command-center contract.
- Mobile scope belongs to [PRD-mobile-companion-canonical.md](PRD-mobile-companion-canonical.md), not to Command Center.
- Whole-product ownership and cross-chunk boundaries live in [PRD-product.md](PRD-product.md), not here.

## Supporting Evidence and Deep Dives

- [ROADMAP.md](ROADMAP.md)
- [IMPLEMENTED-HISTORY.md](IMPLEMENTED-HISTORY.md)
- [ADR index](adr/README.md)
- `apps/command-center/ui/src/dev/dev-harness.ts` for host-parity validation entry points (`slot-view`, `review-workspace`, and `family-observability`)
- ADR-001 through ADR-018 where applicable, especially ADR-011, ADR-012, ADR-013, ADR-016, and ADR-017

## Success Condition for This Chunk

The Command Center gives one operator a reliable, persistent, multi-slot supervisory surface that reflects shared backend truth and supports intervention without becoming the only source of product authority.
